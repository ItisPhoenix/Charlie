import {
  createHash,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@rakazo/db";

const ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function blocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function issueGordonCommandGrant(
  prisma: PrismaClient,
  input: Record<string, unknown>,
) {
  const chiefId = process.env.CHARLIE_OWNER_CHIEF_BOT_ID;
  const gordonId = process.env.CHARLIE_OWNER_GORDON_BOT_ID;
  const keyPath = process.env.CHARLIE_OWNER_SIGNING_KEY_FILE;

  if (!chiefId || !gordonId || !keyPath) return null;

  const runId = input.gordon_run_id;
  const effectId = input.effect_id;
  const command = input.command;

  if (
    typeof runId !== "string" ||
    !ID_PATTERN.test(runId) ||
    typeof effectId !== "string" ||
    !ID_PATTERN.test(effectId) ||
    typeof command !== "string" ||
    !command.length ||
    Buffer.byteLength(command, "utf8") > 8192
  ) return null;

  const gordon = await prisma.run.findUnique({
    where: { id: runId },
  });

  if (
    !gordon ||
    gordon.botId !== gordonId ||
    !["user", "bot_message"].includes(gordon.trigger) ||
    gordon.status !== "running" ||
    !gordon.sourceMessageId
  ) return null;

  const inbound = await prisma.message.findUnique({
    where: { id: gordon.sourceMessageId },
  });
  if (
    !inbound ||
    inbound.threadId !== gordon.threadId ||
    inbound.runId !== gordon.id
  ) return null;

  // A direct owner request to Gordon has its own signed owner-origin proof.
  // Delegation through Chief must link to the exact original owner run.
  let originRunId: string;
  if (gordon.trigger === "user") {
    if (inbound.role !== "user") return null;
    originRunId = gordon.id;
  } else {
    const inboundBlocks = blocks(inbound.blocks);
    if (inboundBlocks.length !== 1) return null;
    const received = inboundBlocks[0];

    if (
      received?.kind !== "bot_message_received" ||
      received.fromBotId !== chiefId ||
      !["request", "question"].includes(String(received.intent ?? "request")) ||
      typeof received.returnToMessageId !== "string"
    ) return null;

    const outbound = await prisma.message.findUnique({
      where: { id: received.returnToMessageId },
    });
    if (
      !outbound ||
      outbound.role !== "bot" ||
      outbound.botId !== chiefId ||
      !outbound.runId
    ) return null;

    const sentBlocks = blocks(outbound.blocks);
    if (
      sentBlocks.length !== 1 ||
      sentBlocks[0]?.kind !== "bot_message_sent" ||
      sentBlocks[0]?.toBotId !== gordonId ||
      !["request", "question"].includes(
        String(sentBlocks[0]?.intent ?? "request"),
      )
    ) return null;
    originRunId = outbound.runId;
  }

  const origin = await prisma.run.findUnique({
    where: { id: originRunId },
  });
  if (
    !origin ||
    origin.botId !== (gordon.trigger === "user" ? gordonId : chiefId) ||
    origin.trigger !== "user" ||
    origin.userId !== gordon.userId ||
    origin.spaceId !== gordon.spaceId ||
    !origin.sourceMessageId
  ) return null;

  const [proof, source] = await Promise.all([
    prisma.charlieOwnerOriginProof.findUnique({
      where: { originRunId: origin.id },
    }),
    prisma.message.findUnique({
      where: { id: origin.sourceMessageId },
    }),
  ]);

  if (
    !proof ||
    !source ||
    source.role !== "user" ||
    source.threadId !== origin.threadId ||
    proof.userId !== origin.userId ||
    proof.spaceId !== origin.spaceId
  ) return null;

  const sourceBlocks = blocks(source.blocks);
  if (
    sourceBlocks.length !== 1 ||
    sourceBlocks[0]?.kind !== "text" ||
    typeof sourceBlocks[0]?.text !== "string"
  ) return null;

  const signingKey = readFileSync(keyPath);
  const proofBytes = Buffer.from(proof.payloadB64, "base64");
  const proofSignature = Buffer.from(proof.signatureB64, "base64");

  if (
    proofSignature.length !== 64 ||
    !verify(null, proofBytes, createPublicKey(signingKey), proofSignature)
  ) return null;

  const claim: unknown = JSON.parse(proofBytes.toString("utf8"));
  if (!claim || typeof claim !== "object" || Array.isArray(claim))
    return null;

  const authority = claim as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);

  if (
    authority.version !== 1 ||
    authority.type !== "charlie_owner_origin" ||
    authority.issuer !== "charlie-api" ||
    authority.owner_user_id !== origin.userId ||
    authority.space_id !== origin.spaceId ||
    authority.chief_bot_id !== origin.botId ||
    authority.origin_run_id !== origin.id ||
    authority.source_message_id !== source.id ||
    authority.prompt_sha256 !== sha256(sourceBlocks[0].text) ||
    typeof authority.issued_at !== "number" ||
    typeof authority.expires_at !== "number" ||
    authority.issued_at > now ||
    authority.expires_at <= now ||
    authority.expires_at - authority.issued_at > 3600
  ) return null;

  const grant = {
    version: 1,
    issuer: "charlie-api",
    owner_user_id: origin.userId,
    space_id: origin.spaceId,
    chief_bot_id: chiefId,
    gordon_bot_id: gordonId,
    gordon_run_id: gordon.id,
    origin_run_id: origin.id,
    effect_id: effectId,
    command_sha256: sha256(command),
    issued_at: now,
    expires_at: now + 45,
  };

  const payload = Buffer.from(JSON.stringify(grant), "utf8");
  const signature = sign(null, payload, signingKey);

  return {
    grant_b64: payload.toString("base64"),
    signature_b64: signature.toString("base64"),
  };
}
