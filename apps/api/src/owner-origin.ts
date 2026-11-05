import { createHash, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

export async function attestAuthenticatedOwnerOrigin(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    botId: string;
    runId: string;
    sourceMessageId: string;
    blocks: MessageBlock[];
  },
): Promise<void> {
  const keyPath = process.env.CHARLIE_OWNER_SIGNING_KEY_FILE;
  const chiefId = process.env.CHARLIE_OWNER_CHIEF_BOT_ID;
  const gordonId = process.env.CHARLIE_OWNER_GORDON_BOT_ID;

  // Only a signed-in owner may establish host authority, either through Chief
  // or by addressing Gordon directly. Never attest agent-generated messages.
  if (!keyPath || !chiefId || !gordonId || ![chiefId, gordonId].includes(input.botId)) return;

  // Only a new, plain-text owner request is attested. Tool output and bot messages are excluded.
  if (input.blocks.length !== 1 || input.blocks[0]?.kind !== "text") return;
  const prompt = input.blocks[0].text;
  if (typeof prompt !== "string" || !prompt.trim()) return;

  // Independently check authenticated account ownership.
  const space = await tx.space.findUnique({
    where: { id: input.actor.spaceId },
    select: { createdByUserId: true, organizationId: true },
  });
  if (!space || space.createdByUserId !== input.actor.userId) return;

  const owner = await tx.member.findFirst({
    where: {
      organizationId: space.organizationId,
      userId: input.actor.userId,
      role: "owner",
    },
    select: { id: true },
  });
  if (!owner) return;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    type: "charlie_owner_origin",
    issuer: "charlie-api",
    owner_user_id: input.actor.userId,
    space_id: input.actor.spaceId,
    chief_bot_id: input.botId,
    origin_run_id: input.runId,
    source_message_id: input.sourceMessageId,
    prompt_sha256: createHash("sha256")
      .update(prompt, "utf8")
      .digest("hex"),
    issued_at: now,
    expires_at: now + 3600,
    nonce: randomUUID(),
  };

  const message = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, message, readFileSync(keyPath));

  // Persist in the same transaction that created the owner run.
  await tx.charlieOwnerOriginProof.create({
    data: {
      originRunId: input.runId,
      spaceId: input.actor.spaceId,
      userId: input.actor.userId,
      payloadB64: message.toString("base64"),
      signatureB64: signature.toString("base64"),
    },
  });
}
