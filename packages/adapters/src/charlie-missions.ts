import { randomUUID } from "node:crypto";
import {
  BOT_MESSAGE_MAX_LENGTH,
  decideCharlieMissionWork,
  validateCharlieMissionPlan,
} from "@rakazo/core";
import type {
  CharlieMissionPlan,
  CharlieWorkProgress,
} from "@rakazo/core";
import { runAsSystem } from "@rakazo/db";
import { messageBot } from "./bot-messages.js";
import { verifiedDependencyContext } from "./charlie-mission-evidence.js";
import type { RunContext } from "./run-context.js";

type Progress = CharlieWorkProgress & {
  evidence?: string;
  delegatedRunId?: string;
  verifierBotId?: string;
  verifierRunId?: string;
  reviewEvidence?: string;
};

type MissionRow = {
  id: string;
  spaceId: string;
  userId: string;
  chiefBotId: string;
  creationKey: string;
  originRunId: string | null;
  plan: CharlieMissionPlan;
  progress: Progress[];
  revision: number;
  createdAt: Date;
};

function stringValue(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 && value.length <= max ? value : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function parseRow(row: MissionRow): MissionRow {
  // PostgreSQL's jsonb adapter normally returns objects. Accept textual JSON too.
  const plan = typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan;
  const progress = typeof row.progress === "string" ?
    JSON.parse(row.progress) : row.progress;
  validateCharlieMissionPlan(plan);
  if (!Array.isArray(progress)) throw new Error("Invalid stored mission progress");
  decideCharlieMissionWork(plan, progress);
  return { ...row, plan, progress };
}

async function findMission(ctx: RunContext, id: string) {
  const rows = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'SELECT * FROM "charlie_missions" WHERE "id"=$1 AND "spaceId"=$2 AND "userId"=$3 LIMIT 1',
    id, ctx.run.spaceId, ctx.run.userId,
  );
  return rows.length ? parseRow(rows[0]!) : null;
}

/**
 * Owner attestation is issued by the API when an authenticated owner sends
 * Chief a new human request; the worker never manufactures the attestation.
 * This permits owner-originated decisions but does not grant Ubuntu authority.
 */
async function ownerAuthorized(ctx: RunContext): Promise<boolean> {
  if (ctx.run.trigger !== "user" ||
      !ctx.source.ownerStartedRun ||
      ctx.bot.id !== process.env.CHARLIE_OWNER_CHIEF_BOT_ID) return false;

  const proof = await runAsSystem("Charlie executive mission owner-origin lookup", () =>
    ctx.deps.prisma.charlieOwnerOriginProof.findUnique({
      where: { originRunId: ctx.run.id },
      select: { userId: true, spaceId: true },
    }),
  );
  return proof?.userId === ctx.run.userId &&
    proof.spaceId === ctx.run.spaceId;
}

function rowView(row: MissionRow) {
  const decision = decideCharlieMissionWork(row.plan, row.progress);
  return {
    missionId: row.id,
    goal: row.plan.goal,
    createdAt: row.createdAt.toISOString(),
    revision: row.revision,
    decision,
    work: row.plan.work.map((spec) => ({
      ...spec,
      progress: row.progress.find((entry) => entry.key === spec.key) ??
        { key: spec.key, state: "planned", attempts: 0 },
    })),
  };
}

export async function missionCreate(
  ctx: RunContext,
  args: Record<string, unknown>,
  creationKey: string,
) {
  if (!(await ownerAuthorized(ctx))) {
    return { error: "Only an authenticated owner request to Charlie may create missions." };
  }
  const plan = {
    goal: args.goal,
    maxConcurrentAgents: args.maxConcurrentAgents,
    maxRuntimeSeconds: args.maxRuntimeSeconds,
    work: args.work,
  } as CharlieMissionPlan;
  try {
    validateCharlieMissionPlan(plan);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid mission plan" };
  }

  if (!stringValue(creationKey, 256)) return { error: "Invalid mission creation key." };
  if (plan.work.some((item) =>
    item.assigneeBotId === ctx.bot.id || item.verifierBotId === ctx.bot.id)) {
    return { error: "Chief must coordinate work, not delegate to itself." };
  }
  const owners = [...new Set(plan.work.flatMap((item) =>
    [item.assigneeBotId, ...(item.verifierBotId ? [item.verifierBotId] : [])],
  ))];
  const bots = await ctx.deps.prisma.bot.findMany({
    where: {
      id: { in: owners },
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (bots.length !== owners.length) {
    return { error: "Every work assignee must be an active bot owned by this user." };
  }
  // Never update or return a different tenant's row on a creation-key conflict.
  const rows = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'INSERT INTO "charlie_missions" ("id","spaceId","userId","chiefBotId","creationKey","originRunId","plan") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ' +
      'ON CONFLICT DO NOTHING RETURNING *',
    randomUUID(), ctx.run.spaceId, ctx.run.userId, ctx.bot.id,
    creationKey, ctx.run.id, JSON.stringify(plan),
  );
  const [existing] = rows.length ? rows : await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'SELECT * FROM "charlie_missions" WHERE "spaceId"=$1 AND "userId"=$2 ' +
      'AND "chiefBotId"=$3 AND ("creationKey"=$4 OR "originRunId"=$5) ' +
      'ORDER BY CASE WHEN "originRunId"=$5 THEN 0 ELSE 1 END LIMIT 1',
    ctx.run.spaceId, ctx.run.userId, ctx.bot.id, creationKey, ctx.run.id,
  );
  if (!existing) return { error: "Mission creation key belongs to another scope." };
  const mission = parseRow(existing);
  // Repeated model calls during a single owner turn reuse the original mission,
  // irrespective of their distinct tool call/effect identities.
  if (mission.originRunId === ctx.run.id && mission.creationKey !== creationKey) {
    return { ok: true, reused: true, ...rowView(mission),
      note: "Mission already exists for this owner request; continue it." };
  }
  if (canonicalJson(mission.plan) !== canonicalJson(plan)) {
    return { error: "Mission creation key cannot be reused for a different plan." };
  }
  return { ok: true, ...rowView(mission), note:
    "Mission persisted; dispatch ready tasks with mission_dispatch." };
}

export async function missionList(ctx: RunContext) {
  const rows = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'SELECT * FROM "charlie_missions" WHERE "spaceId"=$1 AND "userId"=$2 ' +
      'ORDER BY "createdAt" DESC LIMIT 20',
    ctx.run.spaceId, ctx.run.userId,
  );
  return { missions: rows.map((row) => {
    const mission = parseRow(row);
    return {
      missionId: mission.id,
      goal: mission.plan.goal,
      createdAt: mission.createdAt.toISOString(),
      decision: decideCharlieMissionWork(mission.plan, mission.progress),
    };
  }) };
}

function deliveryKey(id: string, workKey: string, attempt: number) {
  return "charlie-mission:" + id + ":" + workKey + ":attempt:" + attempt;
}

async function delegatedRun(ctx: RunContext, row: MissionRow, workKey: string) {
  const spec = row.plan.work.find((item) => item.key === workKey);
  if (!spec) return null;
  const trackedRunId = row.progress.find((item) => item.key === workKey)?.delegatedRunId;
  if (trackedRunId) {
    return ctx.deps.prisma.run.findFirst({
      where: {
        id: trackedRunId,
        botId: spec.assigneeBotId,
        userId: row.userId,
        spaceId: row.spaceId,
        trigger: { in: ["charlie_mission", "bot_message"] },
      },
      select: { id: true, status: true, trigger: true },
    });
  }
  const bot = await ctx.deps.prisma.bot.findFirst({
    where: {
      id: spec.assigneeBotId,
      spaceId: row.spaceId,
      userId: row.userId,
      archivedAt: null,
    },
    select: { thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const message = await ctx.deps.prisma.message.findUnique({
    where: {
      threadId_clientNonce: {
        threadId: bot.thread.id,
        clientNonce: "bot-message:" + deliveryKey(
          row.id, spec.key, row.progress.find((p) => p.key === workKey)?.attempts ?? 1,
        ),
      },
    },
    select: { runId: true },
  });
  if (!message?.runId) return null;
  return ctx.deps.prisma.run.findFirst({
    where: {
      id: message.runId,
      botId: spec.assigneeBotId,
      userId: row.userId,
      spaceId: row.spaceId,
    },
    select: { id: true, status: true, trigger: true },
  });
}

export async function missionStatus(ctx: RunContext, args: Record<string, unknown>) {
  const id = stringValue(args.missionId, 128);
  if (!id) return { error: "missionId is required." };
  const row = await findMission(ctx, id);
  if (!row) return { error: "Mission not found." };
  const result = rowView(row);
  const runs = await Promise.all(row.plan.work.map(async (spec) => {
    const run = await delegatedRun(ctx, row, spec.key);
    return { key: spec.key, runId: run?.id ?? null, runStatus: run?.status ?? null };
  }));
  const deadline = row.createdAt.getTime() + row.plan.maxRuntimeSeconds * 1000;
  return { ...result, delegatedRuns: runs, deadlineExceeded: Date.now() >= deadline };
}

/**
 * Send exactly one bot message per mission work item. messageBot persists
 * the child run and clientNonce atomically; retries reuse the same delivery
 * key, even after a crash before our progress update.
 */
export async function missionDispatch(ctx: RunContext, args: Record<string, unknown>) {
  if (!(await ownerAuthorized(ctx))) {
    return { error: "A fresh authenticated owner request to Charlie is required." };
  }
  const id = stringValue(args.missionId, 128);
  if (!id) return { error: "missionId is required." };
  let row = await findMission(ctx, id);
  if (!row || row.chiefBotId !== ctx.bot.id) {
    return { error: "Mission not found or not owned by this coordinator." };
  }
  if (Date.now() >= row.createdAt.getTime() + row.plan.maxRuntimeSeconds * 1000) {
    return { error: "Mission deadline expired. No further delegation was sent." };
  }

  const dispatched: string[] = [];
  const initial = decideCharlieMissionWork(row.plan, row.progress);
  for (const key of initial.ready) {
    const spec = row.plan.work.find((item) => item.key === key)!;
    const message = [
      "Charlie mission " + row.id + ", work " + spec.key + ".",
      "Goal: " + row.plan.goal,
      "Task: " + spec.title,
      "Verification criteria: " + spec.verificationCriteria,
      "Execute within your authority. Return concrete evidence, uncertainty and blockers.",
      "Do not claim that Charlie has verified completion.",
    ];
    const dependency = verifiedDependencyContext(row.plan, row.progress, key);
    if (!dependency.ok) return { error: dependency.error, dispatched };
    if (dependency.context) message.push(dependency.context);
    const fullMessage = message.join("\n");
    if (fullMessage.length > BOT_MESSAGE_MAX_LENGTH) {
      return { error: "Delegation exceeds the bot-message size limit.", dispatched };
    }
    const attempt = (row.progress.find((item) => item.key === key)?.attempts ?? 0) + 1;

    const sent = await messageBot(
      ctx.deps,
      { ...ctx.run, sourceMessageId: ctx.run.sourceMessageId },
      { id: ctx.bot.id, name: ctx.bot.name },
      {
        bot_id: spec.assigneeBotId,
        message: fullMessage,
        intent: "request",
        deliveryKey: deliveryKey(row.id, key, attempt),
      },
    );
    if (!sent.ok) {
      return { error: sent.error, dispatched, retrySafe: true };
    }

    const old = row.progress.find((item) => item.key === key);
    const next: Progress[] = [
      ...row.progress.filter((item) => item.key !== key),
      { key, state: "queued", attempts: attempt },
    ];
    const updated = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
      'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
        '"updatedAt"=NOW() WHERE "id"=$2 AND "spaceId"=$3 AND "userId"=$4 ' +
        'AND "revision"=$5 RETURNING *',
      JSON.stringify(next), row.id, row.spaceId, row.userId, row.revision,
    );
    if (!updated.length) {
      return {
        error: "Concurrent mission change; reread mission_status and retry.",
        dispatched,
        retrySafe: true,
      };
    }
    row = parseRow(updated[0]!);
    dispatched.push(key);
  }
  return { ok: true, dispatched, ...rowView(row) };
}

/**
 * A completed bot run is evidence of execution, not task correctness.
 * The item remains submitted; it cannot unlock dependents until a separate
 * independent verification stage records verified status.
 */
export async function missionSubmit(ctx: RunContext, args: Record<string, unknown>) {
  if (!(await ownerAuthorized(ctx))) {
    return { error: "A fresh authenticated owner request to Charlie is required." };
  }
  const id = stringValue(args.missionId, 128);
  const key = stringValue(args.workKey, 64);
  const evidence = stringValue(args.evidence, 4000);
  if (!id || !key || !evidence) return { error: "missionId, workKey and evidence are required." };
  const row = await findMission(ctx, id);
  if (!row || row.chiefBotId !== ctx.bot.id) return { error: "Mission not found." };
  const old = row.progress.find((entry) => entry.key === key);
  if (old?.state !== "queued" && old?.state !== "running") {
    return { error: "Work must have been delegated before submission." };
  }
  const run = await delegatedRun(ctx, row, key);
  if (!run || run.status !== "completed" ||
      !["bot_message", "charlie_mission"].includes(run.trigger)) {
    return { error: "A completed delegated bot run is required for submission." };
  }
  const next: Progress[] = [
    ...row.progress.filter((entry) => entry.key !== key),
    { ...old, state: "submitted", evidence, delegatedRunId: run.id },
  ];
  const updated = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
      '"updatedAt"=NOW() WHERE "id"=$2 AND "spaceId"=$3 AND "userId"=$4 ' +
      'AND "revision"=$5 RETURNING *',
    JSON.stringify(next), row.id, row.spaceId, row.userId, row.revision,
  );
  if (!updated.length) return { error: "Concurrent change; inspect mission_status and retry." };
  return { ok: true, ...rowView(parseRow(updated[0]!)),
    note: "Execution submitted, not verified. Dependent work remains blocked." };
}


/**
 * Reconcile durable mission progress against actual child-run states.
 * Only a new owner-originated Chief turn may mutate missions.
 * Completed runs stay queued until their evidence is explicitly submitted;
 * the coordinator never silently treats execution as independent verification.
 */
export async function missionReconcile(ctx: RunContext, args: Record<string, unknown>) {
  if (!(await ownerAuthorized(ctx))) {
    return { error: "A fresh authenticated owner request to Charlie is required." };
  }
  const id = stringValue(args.missionId, 128);
  if (!id) return { error: "missionId is required." };
  const row = await findMission(ctx, id);
  if (!row || row.chiefBotId !== ctx.bot.id) return { error: "Mission not found." };

  const deadlineExceeded =
    Date.now() >= row.createdAt.getTime() + row.plan.maxRuntimeSeconds * 1000;
  const changes: string[] = [];
  const next: Progress[] = [...row.progress];

  for (const spec of row.plan.work) {
    const prior = next.find((item) => item.key === spec.key);
    if (prior?.state === "submitted" || prior?.state === "verifying" || prior?.state === "verified" ||
        prior?.state === "failed" || prior?.state === "cancelled" ||
        prior?.state === "blocked") continue;

    const child = await delegatedRun(ctx, row, spec.key);
    if (!child) continue;
    const attempts = prior?.attempts ?? 1;
    let newState: Progress["state"] | undefined;
    if (child.status === "running") newState = "running";
    if (child.status === "queued") newState = "queued";
    if (child.status === "failed" || child.status === "cancelled") {
      newState = attempts < spec.maxAttempts && !deadlineExceeded ? "planned" : "failed";
    }
    if (!newState || prior?.state === newState) continue;

    const updated: Progress = {
      key: spec.key,
      state: newState,
      attempts,
    };
    const idx = next.findIndex((item) => item.key === spec.key);
    if (idx >= 0) next[idx] = updated;
    else next.push(updated);
    changes.push(spec.key + ":" + newState);
  }

  if (changes.length === 0) {
    return { ok: true, changes, deadlineExceeded, ...rowView(row) };
  }

  const updated = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
      '"updatedAt"=NOW() WHERE "id"=$2 AND "spaceId"=$3 AND "userId"=$4 ' +
      'AND "revision"=$5 RETURNING *',
    JSON.stringify(next), row.id, row.spaceId, row.userId, row.revision,
  );
  if (!updated.length) {
    return { error: "Concurrent mission change; reread status and retry." };
  }
  return { ok: true, changes, deadlineExceeded, ...rowView(parseRow(updated[0]!)) };
}


function reviewerKey(row: MissionRow, key: string, attempt: number) {
  return "charlie-review:" + row.id + ":" + key + ":attempt:" + attempt;
}

/** Keep review work separate from execution. A claim alone cannot unlock dependencies. */
export async function missionRequestReview(ctx: RunContext, args: Record<string, unknown>) {
  if (!(await ownerAuthorized(ctx))) return { error: "Fresh owner-to-Charlie authority is required." };
  const id = stringValue(args.missionId, 128);
  const key = stringValue(args.workKey, 64);
  const verifierId = stringValue(args.verifierBotId, 128);
  if (!id || !key || !verifierId) return { error: "missionId, workKey and verifierBotId are required." };
  let row = await findMission(ctx, id);
  if (!row || row.chiefBotId !== ctx.bot.id) return { error: "Mission not found." };
  const item = row.plan.work.find((work) => work.key === key);
  const progress = row.progress.find((work) => work.key === key);
  if (!item || !progress || !["submitted", "verifying"].includes(progress.state)) {
    return { error: "Only submitted work can enter independent review." };
  }
  if (item.assigneeBotId === verifierId || ctx.bot.id === verifierId) {
    return { error: "Reviewer must differ from the executor and coordinator." };
  }
  if (progress.state === "verifying" && progress.verifierBotId !== verifierId) {
    return { error: "A reviewer is already assigned to this attempt." };
  }
  const reviewer = await ctx.deps.prisma.bot.findFirst({
    where: { id: verifierId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
    select: { id: true },
  });
  if (!reviewer) return { error: "Reviewer is not an active owned specialist." };
  if (progress.state === "submitted") {
    const next = row.progress.map((work) => work.key === key
      ? { ...work, state: "verifying" as const, verifierBotId: verifierId } : work);
    const rows = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
      'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
        '"updatedAt"=NOW() WHERE "id"=$2 AND "spaceId"=$3 AND "userId"=$4 ' +
        'AND "revision"=$5 RETURNING *',
      JSON.stringify(next), row.id, row.spaceId, row.userId, row.revision,
    );
    if (!rows.length) return { error: "Concurrent update. Read mission_status and retry." };
    row = parseRow(rows[0]!);
  }
  const text = [
    "Independent Charlie mission review.",
    "Mission " + row.id + " / work " + key,
    "Goal: " + row.plan.goal, "Task: " + item.title,
    "Criteria: " + item.verificationCriteria,
    "UNTRUSTED executor claim: " + progress.evidence,
    "Inspect the result independently, not just the claimant's description.",
    "First line must be MISSION_REVIEW_PASS or MISSION_REVIEW_FAIL.",
    "Second line must begin Evidence: and describe observations, source and uncertainty.",
    "When independent corroboration is unavailable, respond MISSION_REVIEW_FAIL.",
  ].join("\n");
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return { error: "Review request is too long." };
  const outcome = await messageBot(
    ctx.deps, { ...ctx.run, sourceMessageId: ctx.run.sourceMessageId },
    { id: ctx.bot.id, name: ctx.bot.name },
    {
      bot_id: verifierId, intent: "request", message: text,
      deliveryKey: reviewerKey(row, key, progress.attempts),
    },
  );
  if (!outcome.ok) return { error: outcome.error, reviewPending: true, retrySafe: true };
  return { ok: true, missionId: id, workKey: key, reviewerBotId: verifierId,
    note: "Verification run queued. Work is not yet verified." };
}

export async function missionFinalizeReview(ctx: RunContext, args: Record<string, unknown>) {
  if (!(await ownerAuthorized(ctx))) return { error: "Fresh owner-to-Charlie authority is required." };
  const id = stringValue(args.missionId, 128);
  const key = stringValue(args.workKey, 64);
  if (!id || !key) return { error: "missionId and workKey are required." };
  const row = await findMission(ctx, id);
  if (!row || row.chiefBotId !== ctx.bot.id) return { error: "Mission not found." };
  const work = row.progress.find((item) => item.key === key);
  if (work?.state !== "verifying" || !work.verifierBotId) {
    return { error: "No pending independent review exists." };
  }
  const verifier = await ctx.deps.prisma.bot.findFirst({
    where: { id: work.verifierBotId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
    select: { thread: { select: { id: true } } },
  });
  if (!verifier?.thread) return { error: "Reviewer no longer available." };
  const inbound = await ctx.deps.prisma.message.findUnique({
    where: { threadId_clientNonce: {
      threadId: verifier.thread.id,
      clientNonce: "bot-message:" + reviewerKey(row, key, work.attempts),
    } },
    select: { runId: true },
  });
  if (!inbound?.runId) return { error: "Review was not delivered." };
  const run = await ctx.deps.prisma.run.findFirst({
    where: {
      id: inbound.runId, spaceId: row.spaceId, userId: row.userId,
      botId: work.verifierBotId, trigger: "bot_message", status: "completed",
    },
    select: { id: true },
  });
  if (!run) return { error: "Independent verifier run is not completed." };
  const messages = await ctx.deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot", botId: work.verifierBotId },
    select: { blocks: true },
    take: 50,
  });
  const reports: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.blocks)) continue;
    for (const raw of message.blocks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const block = raw as Record<string, unknown>;
      if (block.kind === "bot_message_sent" &&
          block.toBotId === ctx.bot.id && block.intent === "result" &&
          typeof block.text === "string") reports.push(block.text);
    }
  }
  const report = reports.find((text) =>
    /^(MISSION_REVIEW_PASS|MISSION_REVIEW_FAIL)\s*\nEvidence:\s*\S/.test(text.trim()) &&
    text.length >= 75 && text.length <= BOT_MESSAGE_MAX_LENGTH);
  if (!report) return { error: "Reviewer did not provide a structured evidence report." };
  const passed = report.trim().startsWith("MISSION_REVIEW_PASS");
  const next = row.progress.map((item) => item.key === key ? {
    ...item, state: passed ? "verified" as const : "blocked" as const,
    verifierRunId: run.id, reviewEvidence: report,
  } : item);
  const updated = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
      '"updatedAt"=NOW() WHERE "id"=$2 AND "spaceId"=$3 AND "userId"=$4 ' +
      'AND "revision"=$5 RETURNING *',
    JSON.stringify(next), row.id, row.spaceId, row.userId, row.revision,
  );
  if (!updated.length) return { error: "Concurrent mission update; retry after status read." };
  return { ok: true, reviewVerdict: passed ? "passed" : "failed",
    reviewerRunId: run.id, ...rowView(parseRow(updated[0]!)),
    note: "Independent agent review is evidence assessment, not guaranteed truth." };
}
