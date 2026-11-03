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
