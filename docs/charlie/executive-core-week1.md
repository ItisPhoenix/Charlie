# Charlie Executive Core — Week 1

Goal: deliver a persistent objective that autonomously detects relevant changes, decides whether to act, coordinates existing agents, verifies outcomes and records learning.

Reuse functioning messaging, agents, task board, schedules, watches, tools, skills, connectors, computer backend, and run recovery. Do not rebuild them.

## Days 1–3: Autonomous objective loop
- Persist an owner-directed standing objective, goals, limits, state and progress.
- Consume existing change watches and events as signals. Deduplicate and prioritize.
- Convert justified signals into bounded work using the existing mission graph.
- Fix observed duplicate mission creation and stuck-run recovery.
- Forward precise execution evidence to an independent reviewer.

## Days 4–5: Adaptation
- Reuse the existing tool catalog and skill management to identify available capabilities.
- For unmet needs, safely create and validate a capability in an isolated workspace.
- Record verified results, failed attempts and reusable lessons for later decisions.

## Days 6–7: Acceptance and release
- Demonstrate a real ongoing release-authenticity objective using the existing specialists.
- Verify repeated unchanged signals do not trigger duplicate work.
- Verify the workflow survives a restart and concludes with an evidence-backed status.
- Apply a production change only after validation, backup and rollback preparation.

Acceptance: a real goal produces useful actions and independent evidence without a new chat message, within the owner's established permissions. Source code work should be performed directly through the GitHub integration where practical; Codex is reserved for genuinely broad or compiler-intensive changes.
