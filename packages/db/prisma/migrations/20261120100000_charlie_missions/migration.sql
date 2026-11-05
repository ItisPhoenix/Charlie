-- Charlie mission graph, scoped to the authenticated owner. No host authority.
CREATE TABLE "charlie_missions" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "chiefBotId" TEXT NOT NULL,
  "creationKey" TEXT NOT NULL UNIQUE,
  "plan" JSONB NOT NULL,
  "progress" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "charlie_missions_owner_recent"
  ON "charlie_missions" ("spaceId", "userId", "createdAt" DESC);
ALTER TABLE "charlie_missions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "charlie_missions_owner" ON "charlie_missions"
  USING (
    ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
    OR app_rls_bypass()
  )
  WITH CHECK (
    ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
    OR app_rls_bypass()
  );
REVOKE ALL ON "charlie_missions" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON "charlie_missions" TO rakazo_app;
