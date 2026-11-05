-- Phase 1 security fix: the owner-proof system policy must check the
-- cryptographic bypass key, not merely the tenant-settable session flag.
-- Forward-only: preserve existing owner proof rows and their tenant policy.
DROP POLICY IF EXISTS "charlie_owner_origin_proofs_system"
  ON "charlie_owner_origin_proofs";

CREATE POLICY "charlie_owner_origin_proofs_system"
  ON "charlie_owner_origin_proofs"
  USING ((SELECT app_rls_bypass()));
