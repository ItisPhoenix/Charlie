import { runContinueJob } from "@rakazo/adapter-kit";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { decideCharlieMissionWork, validateCharlieMissionPlan } from "@rakazo/core";
import type { CharlieMissionPlan, CharlieWorkProgress } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { verifiedDependencyContext } from "./charlie-mission-evidence.js";

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
  plan: CharlieMissionPlan;
  progress: Progress[];
  revision: number;
  createdAt: Date;
};
type Tx = Prisma.TransactionClient;

const TASK_TRIGGER = "charlie_mission";
const REVIEW_TRIGGER = "charlie_mission_review";
const MAX_MISSIONS_PER_SWEEP = 20;
const OUTCOME_LIMIT = 4000;

function decode(row: MissionRow): MissionRow {
  const plan = typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan;
  const progress = typeof row.progress === "string" ? JSON.parse(row.progress) : row.progress;
  validateCharlieMissionPlan(plan);
  decideCharlieMissionWork(plan, progress);
  return { ...row, plan, progress };
}

function runNonce(id: string, key: string, attempt: number) {
  return "charlie:mission:" + id + ":" + key + ":" + attempt;
}

function reviewNonce(id: string, key: string, attempt: number) {
  return "charlie:review:" + id + ":" + key + ":" + attempt;
}

function messageNonce(id: string, key: string, attempt: number) {
  return "bot-message:charlie-mission:" + id + ":" + key + ":attempt:" + attempt;
}

async function findChild(
  tx: Tx,
  row: MissionRow,
  key: string,
  botId: string,
  attempt: number,
) {
  const direct = await tx.run.findUnique({
    where: { spaceId_clientNonce: {
      spaceId: row.spaceId, clientNonce: runNonce(row.id, key, attempt),
    } },
    select: { id: true, status: true, botId: true, userId: true },
  });
  if (direct?.botId === botId && direct.userId === row.userId) return direct;
  const bot = await tx.bot.findFirst({
    where: { id: botId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
    select: { thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const message = await tx.message.findUnique({
    where: { threadId_clientNonce: {
      threadId: bot.thread.id, clientNonce: messageNonce(row.id, key, attempt),
    } },
    select: { runId: true },
  });
  if (!message?.runId) return null;
  return tx.run.findFirst({
    where: { id: message.runId, botId, spaceId: row.spaceId, userId: row.userId },
    select: { id: true, status: true, botId: true, userId: true },
  });
}

async function findReview(tx: Tx, row: MissionRow, key: string, botId: string, attempt: number) {
  const direct = await tx.run.findUnique({
    where: { spaceId_clientNonce: {
      spaceId: row.spaceId, clientNonce: reviewNonce(row.id, key, attempt),
    } },
    select: { id: true, status: true, botId: true, userId: true },
  });
  if (direct?.botId === botId && direct.userId === row.userId) return direct;
  const bot = await tx.bot.findFirst({
    where: { id: botId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
    select: { thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const inbound = await tx.message.findUnique({
    where: { threadId_clientNonce: {
      threadId: bot.thread.id,
      clientNonce: "bot-message:charlie-review:" + row.id + ":" + key + ":attempt:" + attempt,
    } },
    select: { runId: true },
  });
  if (!inbound?.runId) return null;
  return tx.run.findFirst({
    where: { id: inbound.runId, botId, spaceId: row.spaceId, userId: row.userId },
    select: { id: true, status: true, botId: true, userId: true },
  });
}

async function finalOutput(tx: Tx, runId: string, botId: string, coordinatorId: string): Promise<string> {
  const messages = await tx.message.findMany({
    where: { runId, botId, role: "bot" },
    select: { blocks: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 40,
  });
  // Prefer the agent's explicit result to its coordinator. Ordinary chat text
  // can contain intermediate progress which is not a final evidence report.
  for (const message of messages) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const item = block as Record<string, unknown>;
      if (item.kind === "bot_message_sent" && item.toBotId === coordinatorId &&
          item.intent === "result" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim().slice(0, OUTCOME_LIMIT);
      }
    }
  }
  for (const message of messages) {
    if (!Array.isArray(message.blocks)) continue;
    const text = message.blocks.flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const item = block as Record<string, unknown>;
      return item.kind === "text" && typeof item.text === "string" && item.text.trim()
        ? [item.text.trim()]
        : [];
    }).join("\n");
    if (text) return text.slice(0, OUTCOME_LIMIT);
  }
  return "";
}

async function queueAgent(
  tx: Tx,
  row: MissionRow,
  spec: { key: string; title: string; assigneeBotId: string; verificationCriteria: string },
  botId: string,
  trigger: string,
  nonce: string,
  prompt: string,
): Promise<string | null> {
  const bot = await tx.bot.findFirst({
    where: { id: botId, userId: row.userId, spaceId: row.spaceId, archivedAt: null },
    select: { thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const existing = await tx.run.findUnique({
    where: { spaceId_clientNonce: { spaceId: row.spaceId, clientNonce: nonce } },
    select: { id: true, botId: true },
  });
  if (existing) return existing.botId === botId ? existing.id : null;

  const task = await tx.task.create({
    data: {
      spaceId: row.spaceId,
      userId: row.userId,
      botId,
      threadId: bot.thread.id,
      prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: row.spaceId,
      userId: row.userId,
      botId,
      threadId: bot.thread.id,
      taskId: task.id,
      trigger,
      clientNonce: nonce,
      status: "queued",
    },
    select: { id: true },
  });
  return run.id;
}

async function advanceMission(prisma: PrismaClient, id: string, now: Date): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<MissionRow[]>(
      'SELECT * FROM "charlie_missions" WHERE "id"=$1 FOR UPDATE', id,
    );
    if (!rows.length) return [];
    const row = decode(rows[0]!);
    // Do not auto-start newly created plans before the original authenticated
    // owner-originated run has explicitly dispatched their first stage.
    if (!row.progress.length) return [];
    const deadlineExpired =
      now.getTime() >= row.createdAt.getTime() + row.plan.maxRuntimeSeconds * 1000;
    const next: Progress[] = [...row.progress];
    const scheduled: string[] = [];
    let changed = false;

    for (const spec of row.plan.work) {
      const position = next.findIndex((item) => item.key === spec.key);
      if (position < 0) continue;
      const progress = next[position]!;
      if (progress.state === "queued" || progress.state === "running") {
        const child = await findChild(tx, row, spec.key, spec.assigneeBotId, progress.attempts);
        if (!child) continue;
        if (child.status === "completed") {
          const evidence = await finalOutput(tx, child.id, spec.assigneeBotId, row.chiefBotId);
          if (evidence.length >= 40) {
            next[position] = { ...progress, state: "submitted", evidence,
              delegatedRunId: child.id };
          } else {
            // A completed run without usable evidence cannot silently hold the mission.
            next[position] = { ...progress, state: "blocked",
              evidence: "Completed executor run did not supply sufficient evidence.",
              delegatedRunId: child.id };
          }
          changed = true;
        } else if (child.status === "running" || child.status === "leased") {
          if (progress.state !== "running") {
            next[position] = { ...progress, state: "running" };
            changed = true;
          }
        } else if (["failed", "cancelled"].includes(child.status)) {
          next[position] = {
            key: spec.key,
            state: progress.attempts < spec.maxAttempts && !deadlineExpired ? "planned" : "failed",
            attempts: progress.attempts,
          };
          changed = true;
        }
      }
      const current = next[position]!;
      if (current.state === "submitted" && spec.verifierBotId && !deadlineExpired) {
        const prompt = [
          "Independent Charlie mission evidence review. This is a bounded delegated run.",
          "Mission: " + row.id + ", work: " + spec.key,
          "Goal: " + row.plan.goal,
          "Task: " + spec.title,
          "Criteria: " + spec.verificationCriteria,
          "UNTRUSTED executor claim: " + current.evidence,
          "Independently inspect the actual result; do not accept executor narration as proof.",
          "First line: MISSION_REVIEW_PASS or MISSION_REVIEW_FAIL.",
          "Second line starts Evidence: and cites your own observations.",
          "If unable to independently corroborate, return MISSION_REVIEW_FAIL.",
        ].join("\n");
        const runId = await queueAgent(
          tx, row, spec, spec.verifierBotId, REVIEW_TRIGGER,
          reviewNonce(row.id, spec.key, current.attempts), prompt,
        );
        if (runId) {
          next[position] = { ...current, state: "verifying",
            verifierBotId: spec.verifierBotId, verifierRunId: runId };
          scheduled.push(runId);
          changed = true;
        }
      }
      if (next[position]?.state === "verifying") {
        const currentReview = next[position]!;
        const verifierId = currentReview.verifierBotId;
        if (!verifierId) continue;
        const review = await findReview(tx, row, spec.key, verifierId, currentReview.attempts);
        if (!review) continue;
        if (review.status === "completed") {
          const report = await finalOutput(tx, review.id, verifierId, row.chiefBotId);
          const match = /^(MISSION_REVIEW_PASS|MISSION_REVIEW_FAIL)\s*\nEvidence:\s*\S/.exec(report);
          if (match && report.length >= 75) {
            next[position] = { ...currentReview,
              state: match[1] === "MISSION_REVIEW_PASS" ? "verified" : "blocked",
              verifierRunId: review.id, reviewEvidence: report };
          } else {
            // Completed but malformed reviews fail closed; do not wait forever.
            next[position] = { ...currentReview, state: "blocked",
              verifierRunId: review.id,
              reviewEvidence: report || "Review completed without a usable evidence report." };
          }
          changed = true;
        } else if (["failed", "cancelled"].includes(review.status)) {
          next[position] = { ...currentReview, state: "blocked" };
          changed = true;
        }
      }
    }

    // No background delegation may mint a signed owner-origin grant.
    // In particular, Gordon cannot perform privileged host mutations from
    // a charlie_mission run; the independent API grant chain rejects it.
    if (!deadlineExpired) {
      const decision = decideCharlieMissionWork(row.plan, next);
      for (const key of decision.ready) {
        const spec = row.plan.work.find((work) => work.key === key)!;
        const prior = next.find((work) => work.key === key);
        const attempt = (prior?.attempts ?? 0) + 1;
        const dependency = verifiedDependencyContext(row.plan, next, key);
        if (!dependency.ok) {
          const blocked: Progress = {
            key, state: "blocked", attempts: prior?.attempts ?? 0,
            evidence: dependency.error,
          };
          const oldIndex = next.findIndex((work) => work.key === key);
          if (oldIndex >= 0) next[oldIndex] = blocked;
          else next.push(blocked);
          changed = true;
          continue;
        }
        const prompt = [
          "Charlie mission continued as background delegated work.",
          "Mission: " + row.id + ", task: " + key,
          "Owner objective: " + row.plan.goal,
          "Work: " + spec.title,
          "Verification criteria: " + spec.verificationCriteria,
          "Use your ordinary tools and existing permission gates.",
          "You have NO owner-originated host-root grant. Request the owner if privileged work is needed.",
          "Produce concrete evidence and blockers in your final answer.",
          dependency.context,
        ].filter(Boolean).join("\n");
        const runId = await queueAgent(
          tx, row, spec, spec.assigneeBotId, TASK_TRIGGER,
          runNonce(row.id, key, attempt), prompt,
        );
        if (!runId) continue;
        const entry: Progress = { key, state: "queued", attempts: attempt, delegatedRunId: runId };
        const idx = next.findIndex((work) => work.key === key);
        if (idx >= 0) next[idx] = entry;
        else next.push(entry);
        scheduled.push(runId);
        changed = true;
      }
    }
    if (changed) {
      await tx.$executeRawUnsafe(
        'UPDATE "charlie_missions" SET "progress"=$1::jsonb, "revision"="revision"+1,' +
          '"updatedAt"=NOW() WHERE "id"=$2',
        JSON.stringify(next), row.id,
      );
    }
    return scheduled;
  }, { timeout: 20000 });
}

/**
 * Bounded, leader-elected reconciliation hook. A process restart cannot create
 * duplicate bot runs: mission rows are locked and run nonces are unique.
 */
export function createCharlieMissionReconciler(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now?: () => Date;
}): () => Promise<void> {
  // Rotating keyset cursor prevents the same oldest 20 missions from starving
  // newer work; a mission remains eligible regardless of its age.
  let cursor = "";
  return async () => {
    const rows = await deps.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "charlie_missions" WHERE "id" > $1 ' +
        'ORDER BY "id" ASC LIMIT $2',
      cursor, MAX_MISSIONS_PER_SWEEP,
    );
    if (rows.length < MAX_MISSIONS_PER_SWEEP && cursor) {
      const wrap = await deps.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "charlie_missions" WHERE "id" <= $1 ' +
          'ORDER BY "id" ASC LIMIT $2',
        cursor, MAX_MISSIONS_PER_SWEEP - rows.length,
      );
      rows.push(...wrap);
    }
    if (rows.length > 0) cursor = rows[rows.length - 1]!.id;
    for (const { id } of rows) {
      try {
        const queued = await advanceMission(deps.prisma, id, deps.now?.() ?? new Date());
        for (const runId of queued) {
          await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
            // The existing run reconciler repairs missed durable wakes.
            getLogger().warn("Charlie mission wake deferred to run reconciliation", error);
          });
        }
      } catch (error) {
        getLogger().error("Charlie mission reconciliation failed", error);
      }
    }
  };
}
