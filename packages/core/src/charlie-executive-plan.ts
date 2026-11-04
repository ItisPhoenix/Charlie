/**
 * Charlie executive planning primitives.
 * Pure decisions only: no host execution, DB writes or implicit approval.
 */

export type CharlieWorkState =
  | "planned"
  | "queued"
  | "running"
  | "submitted"
  | "verifying"
  | "verified"
  | "delivered"
  | "blocked"
  | "failed"
  | "cancelled";

export type CharlieWorkSpec = {
  key: string;
  title: string;
  assigneeBotId: string;
  /** Optional independent specialist, invoked only when Chief escalates. */
  verifierBotId?: string;
  dependsOn: readonly string[];
  verificationCriteria: string;
  /** A report confirms delivery; review requires assessed evidence. */
  completionPolicy?: "report" | "review";
  maxAttempts: number;
};

export type CharlieMissionPlan = {
  goal: string;
  maxConcurrentAgents: number;
  maxRuntimeSeconds: number;
  work: readonly CharlieWorkSpec[];
};

export type CharlieWorkProgress = {
  key: string;
  state: CharlieWorkState;
  attempts: number;
};

export type CharlieMissionDecision = {
  state: "running" | "awaiting_verification" |
    "completed" | "blocked" | "failed";
  ready: string[];
  verified: number;
  delivered: number;
  total: number;
  active: number;
};

const KEY_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;

function validText(value: unknown, max: number): boolean {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max;
}

function whole(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) &&
    typeof value === "number" &&
    value >= min &&
    value <= max;
}

/** Reject ambiguous, cyclic or unbounded execution plans. */
export function validateCharlieMissionPlan(
  plan: CharlieMissionPlan,
): void {
  if (!plan || !validText(plan.goal, 8000)) {
    throw new Error("Mission goal is required");
  }
  if (!whole(plan.maxConcurrentAgents, 1, 8) ||
      !whole(plan.maxRuntimeSeconds, 60, 86400)) {
    throw new Error("Mission resource budget is invalid");
  }
  if (!Array.isArray(plan.work) ||
      plan.work.length < 1 ||
      plan.work.length > 40) {
    throw new Error("Mission must have 1–40 work items");
  }

  const byKey = new Map<string, CharlieWorkSpec>();

  for (const item of plan.work) {
    if (!item ||
        typeof item.key !== "string" ||
        !KEY_PATTERN.test(item.key) ||
        !validText(item.title, 200) ||
        !validText(item.assigneeBotId, 128) ||
        !validText(item.verificationCriteria, 2000) ||
        (item.completionPolicy !== undefined &&
          item.completionPolicy !== "report" && item.completionPolicy !== "review") ||
        (item.verifierBotId !== undefined &&
          (!validText(item.verifierBotId, 128) ||
            item.verifierBotId === item.assigneeBotId)) ||
        !whole(item.maxAttempts, 1, 5) ||
        !Array.isArray(item.dependsOn) ||
        item.dependsOn.length > 39) {
      throw new Error("Invalid work item");
    }
    if (byKey.has(item.key)) {
      throw new Error(`Duplicate work item: ${item.key}`);
    }
    byKey.set(item.key, item);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (key: string, depth: number): void => {
    if (depth > 40 || visiting.has(key)) {
      throw new Error("Cyclic work dependency");
    }
    if (visited.has(key)) return;

    const item = byKey.get(key);
    if (!item) {
      throw new Error(`Unknown dependency: ${key}`);
    }

    visiting.add(key);
    const dependencies = new Set<string>();

    for (const dependency of item.dependsOn) {
      if (typeof dependency !== "string" ||
          dependencies.has(dependency)) {
        throw new Error("Duplicate or invalid dependency");
      }
      dependencies.add(dependency);
      visit(dependency, depth + 1);
    }

    visiting.delete(key);
    visited.add(key);
  };

  for (const key of byKey.keys()) visit(key, 0);
}

const WORK_STATES = new Set<CharlieWorkState>([
  "planned", "queued", "running", "submitted", "verifying",
  "verified", "delivered", "blocked", "failed", "cancelled",
]);

/**
 * Assessed work unlocks any downstream stage. A delivered report may unlock
 * another informational report without being falsely labelled verified.
 */
export function decideCharlieMissionWork(
  plan: CharlieMissionPlan,
  progress: readonly CharlieWorkProgress[],
): CharlieMissionDecision {
  validateCharlieMissionPlan(plan);

  const known = new Set(plan.work.map((item) => item.key));
  const states = new Map<string, CharlieWorkProgress>();

  for (const item of progress) {
    if (!item || !known.has(item.key) ||
        states.has(item.key) ||
        !WORK_STATES.has(item.state) ||
        !whole(item.attempts, 0, 5)) {
      throw new Error("Invalid or duplicate progress record");
    }
    states.set(item.key, item);
  }

  const stateOf = (key: string): CharlieWorkState =>
    states.get(key)?.state ?? "planned";

  const active = plan.work.filter((item) =>
    ["queued", "running", "verifying"].includes(stateOf(item.key)),
  ).length;

  const verified = plan.work.filter((item) =>
    stateOf(item.key) === "verified",
  ).length;
  const delivered = plan.work.filter((item) =>
    stateOf(item.key) === "delivered",
  ).length;

  const failed = plan.work.some((item) =>
    stateOf(item.key) === "failed" ||
    stateOf(item.key) === "cancelled",
  );

  const blocked = plan.work.some((item) =>
    stateOf(item.key) === "blocked",
  );

  const submitted = plan.work.some((item) =>
    ["submitted", "verifying"].includes(stateOf(item.key)),
  );
  const executing = plan.work.some((item) =>
    ["queued", "running"].includes(stateOf(item.key)),
  );

  // Never oversubscribe a previously persisted running mission.
  const capacity = Math.max(0, plan.maxConcurrentAgents - active);

  const ready = failed || blocked
    ? []
    : plan.work.filter((item) =>
        stateOf(item.key) === "planned" &&
        item.dependsOn.every((dependency) =>
          stateOf(dependency) === "verified" ||
          (item.completionPolicy === "report" && stateOf(dependency) === "delivered"),
        ) &&
        (states.get(item.key)?.attempts ?? 0) < item.maxAttempts,
      ).slice(0, capacity).map((item) => item.key);

  const exhausted = plan.work.some((item) =>
    stateOf(item.key) === "planned" &&
    (states.get(item.key)?.attempts ?? 0) >= item.maxAttempts,
  );

  const state: CharlieMissionDecision["state"] =
    verified + delivered === plan.work.length ? "completed" :
    failed || exhausted ? "failed" :
    blocked || (active === 0 && ready.length === 0 && !submitted)
      ? "blocked" :
    submitted && !executing && ready.length === 0
      ? "awaiting_verification" :
    "running";

  return {
    state,
    ready,
    verified,
    delivered,
    total: plan.work.length,
    active,
  };
}
