CREATE TABLE "charlie_owner_origin_proofs" (
  "id" TEXT NOT NULL,
  "originRunId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "payloadB64" TEXT NOT NULL,
  "signatureB64" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "charlie_owner_origin_proofs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "charlie_owner_origin_proofs_originRunId_key"
  ON "charlie_owner_origin_proofs"("originRunId");

CREATE INDEX "charlie_owner_origin_proofs_spaceId_userId_idx"
  ON "charlie_owner_origin_proofs"("spaceId", "userId");

ALTER TABLE "charlie_owner_origin_proofs"
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY charlie_owner_origin_proofs_tenant
  ON "charlie_owner_origin_proofs"
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  );

CREATE POLICY charlie_owner_origin_proofs_system
  ON "charlie_owner_origin_proofs"
  USING (
    current_setting('app.rls_bypass', true) = 'on'
  );
