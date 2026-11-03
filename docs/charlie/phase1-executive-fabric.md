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
