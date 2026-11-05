# Charlie — Phase 1: Executive Intelligence

## Existing foundations to reuse
- Durable bot-to-bot messaging and job reconciliation
- Shared ticket board and task catalog
- Agent creation and management
- Run leases, effect tracking and recoverable work
- Gordon's authenticated owner-origin host authority

## Phase 1 delivery contract
1. Persist owner missions and a shared task dependency graph.
2. Resolve tasks to existing agents and bounded execution budgets.
3. Dispatch only dependency-ready work with durable ownership.
4. Track delegation, run provenance, evidence and failure recovery.
5. Require verifiable evidence before unlocking dependent work.
6. Reconcile incomplete missions after worker interruption.
7. Show mission progress and unresolved blockers to the owner.

## Batch 1
Pure executive planning engine with bounded graph validation,
cycle rejection, verified-only dependency release, concurrency
limits and explicit incomplete/blocked outcomes.

## Remaining implementation
Durable mission repository, integration with existing ticket and
bot-message systems, live coordination, recovery and acceptance.

## Security
No mission state grants Ubuntu root authority. Gordon retains its
independent signed origin, command binding and effect replay checks.

## Release rule
Never deploy an incomplete Phase 1 batch to production.

## Batch 2 — Persisted missions and real delegation (integration branch only)
- Owner-attested Chief runs may create durable, versioned mission graphs.
- Ready tasks route through the existing message_bot persistence, wake and replay safeguards.
- Mission status reads the actual child run associated with the deduplicated message.
- Completed agent runs may be submitted with evidence, never silently verified.
- Independent verification, dependency release, unattended reconciliation, and
  end-to-end live mission acceptance remain pending for the final Phase 1 batch.
- The new mission table currently stores goal and evidence JSON in plaintext in
  PostgreSQL. Encrypt before considering it production-ready for sensitive goals.
- No mission tool grants Gordon authority: his signed owner-to-Gordon flow remains separate.

## Batch 3 — Recovery and hardening
- Fixed creation-key collision handling: no cross-owner upsert or conflict leak.
- Delegations carry stable per-attempt delivery keys, allowing bounded retry
  without duplicating messages after a crash.
- Added explicit mission_reconcile against actual delegated runs: running,
  queued, cancelled and failed; budgets prevent indefinite retry.
- Dispatch validates real bot-message size limits.
- No automatic verification: a successful model run is not independently
  verified. Verified completion and autonomous evidence review remain blocked.
- Reconciliation currently requires a fresh authenticated owner-to-Chief turn;
  it is **not** yet a daemon/background autonomous recovery loop.
- No new migrations in this batch. Migration from Batch 2 still requires
  real PostgreSQL migration acceptance in an isolated clone.

## Batch 4 — Review provenance and replay correctness
- Separate reviewer bot must be active and distinct from executor and coordinator.
- Submitted work is claimed as verifying before reviewer dispatch; a retried send
  preserves the originally chosen reviewer and uses a per-attempt delivery key.
- A real completed reviewer run with a structured evidence assessment is required
  before recording reviewed success or a blocker.
- Reviewer approval is an evidence assessment, not guaranteed factual correctness.
- Canonical JSON plan comparisons no longer fail when PostgreSQL JSONB reorders keys.
- Mission status and reviews remain owner-command-driven; automatic background
  recovery, encrypted storage and live multi-agent acceptance are still pending.

## Batch 5 — Durable unattended mission continuation
- Worker reconciler resumes persisted mission graphs after restart under a leader,
  using actual agent run states. Auto-queued work uses durable per-attempt run
  clientNonce plus mission row locking to prevent duplicate effects.
- A real completed executor run with a recorded outcome submits evidence;
  execution completion itself never means verified.
- Work items may specify a separate verifierBotId; a real review run is started
  automatically and only its distinct completed report can unlock dependents.
- Dependents are queued only after reviewed success, within a per-mission
  concurrency and runtime budget. Missing reviewer means awaiting manual review.
- Automatic tasks use trigger charlie_mission or charlie_mission_review, and are
  not owner-originated commands: they cannot inherit Gordon root authorization.
- This batch is source-only, not a deployment. Mission data encryption,
  isolated PostgreSQL migration acceptance, and live multi-agent tests are
  required before production.

## Phase 1 completion policy — risk-proportionate delivery
- Routine, explicitly read-only informational tasks do not need a second AI approval run: a completed specialist run with a nontruncated report and only completed read-only tool effects may be marked delivered and unlock read-only follow-up work.
- The mission ledger stores this basis explicitly as `completionBasis: read_only_delivery`. This means delivery was confirmed, not that factual claims were independently corroborated.
- Missing or truncated reports, incomplete tool effects, unrecognized effects, consequential actions and explicit independent reviews retain the Chief assessment path. Root authority, owner-origin grants, and effect replay protections are unchanged.
- Use ordinary natural-language owner requests. Chief selects specialists; the owner does not supply IDs or commit hashes.
- Acceptance remains subject to live deployment and the separate sensitive mission-data encryption requirement.

## Mission ledger protection — at-rest data
- Mission plan and progress JSONB are sealed with the existing per-space AES-256-GCM content keys, authenticated against the row ID, user ID, table, column and space.
- Mission creation and subsequent writes are sealed before reaching PostgreSQL. Legacy rows are readable and migrated by the mission reconciler under a row lock, with no migration needed for empty unactivated progress.
- This uses the existing content-key provider and fails closed if content encryption is disabled; key rotation uses the embedded ciphertext key ID for decryption.
- Deployment requires an encrypted recovery backup of legacy mission rows before worker migration, because older application revisions cannot read the newly sealed JSONB.
- Positive-path dependency execution, live encrypted read/write acceptance, and sensitive-backup retention remain separate release checks.

## Phase 1 specialist boundary — scoped delivery
- An agent receives one work item's title and completion criteria as its executable assignment. The overall mission goal is orientation only, not an instruction to launch or finish dependent work.
- The runtime, not the specialist, records completion and starts dependency-ready tasks. Queued/planned downstream work does not make the current specialist's own report incomplete.
- Mission-task runs do not offer coordinator-only mission list/status tools. Chief retains owner-facing mission visibility, and independent review runs retain read-only assessment tools.
- A read-only specialist report can be delivered without a second AI approval, but source inspection does not prove runtime behavior. Actual missing evidence still blocks the item. Owner-origin host grants, effect gates and replay protections remain unchanged.
- The legacy owner-triggered reconcile path preserves already-delivered terminal work. Final acceptance requires a real two-stage mission with recorded ordering and attributable evidence.
