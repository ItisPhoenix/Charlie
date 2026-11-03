import { randomUUID } from "node:crypto";
import {
  decideCharlieMissionWork,
  validateCharlieMissionPlan,
} from "@rakazo/core";
import type {
  CharlieMissionPlan,
  CharlieWorkProgress,
} from "@rakazo/core";
import { runAsSystem } from "@rakazo/db";
import { messageBot } from "./bot-messages.js";
import type { RunContext } from "./run-context.js";

type Progress = CharlieWorkProgress & {
  evidence?: string;
  delegatedRunId?: string;
};

type MissionRow = {
  id: string;
  spaceId: string;
  userId: string;
  chiefBotId: string;
  plan: CharlieMissionPlan;
  progress: Progress[];
  revision: number;
  createdAt: Date;
};

function stringValue(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 && value.length <= max ? value : undefined;
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

  const owners = [...new Set(plan.work.map((item) => item.assigneeBotId))];
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
  const rows = await ctx.deps.prisma.$queryRawUnsafe<MissionRow[]>(
    'INSERT INTO "charlie_missions" ("id","spaceId","userId","chiefBotId","creationKey","plan") ' +
      'VALUES ($1,$2,$3,$4,$5,$6::jsonb) ' +
      'ON CONFLICT ("creationKey") DO UPDATE SET "creationKey"=EXCLUDED."creationKey" RETURNING *',
    randomUUID(), ctx.run.spaceId, ctx.run.userId, ctx.bot.id,
    creationKey, JSON.stringify(plan),
  );
  return { ok: true, ...rowView(parseRow(rows[0]!)), note:
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

function deliveryKey(id: string, workKey: string) {
  return "charlie-mission:" + id + ":" + workKey;
}

async function delegatedRun(ctx: RunContext, row: MissionRow, workKey: string) {
  const spec = row.plan.work.find((item) => item.key === workKey);
  if (!spec) return null;
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
        clientNonce: "bot-message:" + deliveryKey(row.id, spec.key),
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
    const message =
      "Charlie mission " + row.id + ", work " + spec.key + ".\n" +
      "Goal: " + row.plan.goal + "\n" +
      "Task: " + spec.title + "\n" +
      "Verification criteria: " + spec.verificationCriteria + "\n" +
      "Execute within your authority. Return concrete evidence, uncertainty and blockers. " +
      "Do not claim that Charlie has verified completion.";

    const sent = await messageBot(
      ctx.deps,
      { ...ctx.run, sourceMessageId: ctx.run.sourceMessageId },
      { id: ctx.bot.id, name: ctx.bot.name },
      {
        bot_id: spec.assigneeBotId,
        message,
        intent: "request",
        deliveryKey: deliveryKey(row.id, key),
      },
    );
    if (!sent.ok) {
      return { error: sent.error, dispatched, retrySafe: true };
    }

    const old = row.progress.find((item) => item.key === key);
    const next: Progress[] = [
      ...row.progress.filter((item) => item.key !== key),
      { key, state: "queued", attempts: (old?.attempts ?? 0) + 1 },
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
  if (!run || run.status !== "completed" || run.trigger !== "bot_message") {
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
