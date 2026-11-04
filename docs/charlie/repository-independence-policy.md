# Charlie repository independence and upstream review policy

Status: proposed on an isolated Charlie branch. Applies after review/merge into Charlie's own main.

## Ownership and write boundary
- Charlie's authoritative source repository is `https://github.com/ItisPhoenix/Charlie`. Its `main` branch is Charlie's own release branch.
- Do not create pull requests, commit, force-push, or publish releases in `elie222/rakazo` on Charlie's behalf.
- Do not automatically synchronize, merge, rebase, or deploy commits from Rakazo into Charlie's `main`.
- Keep Charlie's production deployment, containers, configuration, secrets, build artifacts, CI and release workflows under Charlie-controlled sources and credentials.
- Fork network detachment is a separate owner-admin operation. Preserve a record of the existing Phase 1 pull request before detaching; GitHub states fork detachment discards PRs and other repository metadata.

## Optional, read-only external release review
1. Inspect public Rakazo releases and changelogs only as an external reference; no Git remote is required.
2. Record relevant security fixes, behavior changes, dependencies, licenses, and compatibility risks.
3. Import only a selected patch into a dedicated `charlie/upstream-review/<topic>` branch. Prefer minimal cherry-picks or adapted changes rather than merging the upstream branch.
4. Review licensing, provenance, security boundaries, Charlie architecture, regression impact, migration plan, and rollback.
5. Run project CI and real-host acceptance where applicable before a pull request into Charlie's `main`.
6. Merge only after review; do not deploy an external release automatically.

## Independence acceptance
- GitHub reports Charlie as a standalone repository, not a fork.
- No CI workflow, update agent, build file, install script, container image, package registry or mobile release process silently fetches or deploys Rakazo.
- Production and disaster recovery paths use Charlie-owned images and reproducible build instructions.
- Rename internal `@rakazo/*` package names, environment variables, application identity and documentation through staged, tested migrations; avoid breaking live data or contracts.
- Preserve all required Apache-2.0 license, copyright, attribution and NOTICE obligations for retained derivative code.
- The external project's public releases remain optional review inputs, not an authoritative upstream.

## Release gates
- Do not bypass failed or missing required CI checks to mark Phase 1 complete.
- Retain verified production backups and rollback evidence before changing running services.
- Do not remove existing Rakazo-derived code or deployed images without tested Charlie replacements.
