import type { PrismaClient } from "@rakazo/db";
import { ciphertextKeyId, contentEncryptionOf, decryptText, encryptText } from "@rakazo/db";

/**
 * Mission plan and progress are raw SQL JSONB columns, so Prisma's normal
 * content-encryption extension cannot automatically seal them.
 *
 * Encrypt each column as one authenticated JSON document, bound to its
 * mission id, owner and space. Existing plaintext rows are readable until
 * the reconciler migrates them under the same mission-row lock.
 */
type Column = "plan" | "progress";
type Identity = { id: string; spaceId: string; userId: string };
type Stored = Identity & { plan: unknown; progress: unknown };

function parse(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function missionColumnSealed(value: unknown): boolean {
  const data = parse(value);
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    typeof (data as { $sealed?: unknown }).$sealed === "string"
  );
}

function ringFor(prisma: PrismaClient) {
  const content = contentEncryptionOf(prisma);
  if (!content?.ring.encryptWrites) {
    throw new Error("Mission storage requires active content encryption");
  }
  return content.ring;
}

function location(row: Identity, column: Column) {
  return {
    table: "charlie_missions",
    column,
    rowId: row.id,
    owner: row.userId,
  };
}

export async function sealMissionColumn(
  prisma: PrismaClient,
  row: Identity,
  column: Column,
  value: unknown,
): Promise<string> {
  const key = await ringFor(prisma).current(row.spaceId);
  const ciphertext = encryptText(key, location(row, column), JSON.stringify(value));
  return JSON.stringify({ $sealed: ciphertext });
}

async function openMissionColumn(
  prisma: PrismaClient,
  row: Identity,
  column: Column,
  value: unknown,
): Promise<unknown> {
  const data = parse(value);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "$sealed")) {
    return data; // Legacy row: the leader reconciler seals it under row lock.
  }
  if (!missionColumnSealed(data)) throw new Error("Invalid sealed mission column");
  const ciphertext = (data as { $sealed: string }).$sealed;
  const keyId = ciphertextKeyId(ciphertext);
  if (!keyId) throw new Error("Invalid encrypted mission content");
  const key = await ringFor(prisma).byId(keyId);
  if (key.spaceId !== row.spaceId) {
    throw new Error("Mission ciphertext belongs to a different space");
  }
  return JSON.parse(decryptText(key, location(row, column), ciphertext));
}

export async function openMissionRow<T extends Stored>(prisma: PrismaClient, row: T): Promise<T> {
  const [plan, progress] = await Promise.all([
    openMissionColumn(prisma, row, "plan", row.plan),
    openMissionColumn(prisma, row, "progress", row.progress),
  ]);
  return { ...row, plan, progress } as T;
}
