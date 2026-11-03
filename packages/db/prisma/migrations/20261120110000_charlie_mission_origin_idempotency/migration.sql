-- Existing tool-call keys identify replayed effects, not the owner's objective.
-- Keep existing mission rows (including historical duplicates) unchanged.
ALTER TABLE "charlie_missions"
  ADD COLUMN "originRunId" TEXT;

-- One initial mission per authenticated owner run; intentional later missions
-- originate from separately identified standing-objective decisions.
CREATE UNIQUE INDEX "charlie_missions_owner_run_unique"
  ON "charlie_missions" ("spaceId", "userId", "chiefBotId", "originRunId")
  WHERE "originRunId" IS NOT NULL;
