# Issue 134 Plan

## Summary

Align the operator tooling and core docs with the merged factory-control CLI and multi-runner runtime model.

Plan approval is waived for this issue by direct operator instruction in the local session requesting immediate implementation and PR creation.

## Scope

- update operator guidance to prefer `symphony factory status|start|stop|restart`
- update `.ralph/ralph-loop.sh` so local status generation reflects factory-control state instead of ad hoc worker-process greps
- update `README.md` to reflect the current runner model, status surfaces, and workflow/config behavior
- update `docs/guides/self-hosting-loop.md` to reflect the current self-hosting runtime contract

## Non-Goals

- changing runtime behavior in `src/orchestrator/`, `src/runner/`, or `src/tracker/`
- redesigning the operator workflow beyond what is needed to match the merged runtime
- introducing new control or dashboard features
- changing issue/pull-request lifecycle policy

## Current Gaps

- operator guidance still describes health checks in terms of live worker / child processes rather than the new factory-control surface
- Ralph’s status files are still derived from process greps and GitHub label snapshots instead of the detached runtime control contract
- `README.md` still carries subtle codex-only assumptions and incomplete config/status explanations
- the self-hosting guide still treats `workspace.repo_url` and raw `.tmp/status.json` as the primary operator story even though the current runtime has first-class factory-control commands

## Architecture Layers

- Policy
  - belongs: operator working rules in `skills/symphony-operator/SKILL.md`
  - does not belong: tracker lifecycle changes or merge policy changes
- Configuration
  - belongs: clarifying how `tracker.repo`, `SYMPHONY_REPO`, `agent.runner.kind`, and `agent.command` interact in docs
  - does not belong: new config fields or parsing changes
- Coordination
  - belongs: none beyond documenting the existing control flow
  - does not belong: changing retries, watchdog logic, or reconciliation behavior
- Execution
  - belongs: documenting the current multi-runner model and runner-neutral operator expectations
  - does not belong: runner implementation changes
- Integration
  - belongs: none beyond describing current GitHub-facing behavior accurately
  - does not belong: tracker transport or normalization changes
- Observability
  - belongs: operator-facing status surfaces, degraded-state interpretation, Ralph status generation
  - does not belong: redesigning the runtime status schema

## Architecture Boundaries

- Keep `skills/symphony-operator/SKILL.md` focused on durable operator behavior, not transient overnight facts.
- Keep `.ralph/ralph-loop.sh` focused on local operator automation and status summarization; do not turn it into a second scheduler.
- Keep `README.md` high-signal and operator-facing; do not duplicate every internal implementation detail.
- Keep `docs/guides/self-hosting-loop.md` focused on the repo’s real operating loop, not broad architecture explanations.

## Slice Strategy

One reviewable docs-and-tooling PR:

1. add the issue plan documenting the intended seam
2. update operator guidance
3. update Ralph status generation to consume the factory-control surface
4. update README and self-hosting guide to match the merged runtime

This stays reviewable because it does not touch core runtime logic; it only aligns durable docs and operator automation with already-merged behavior.

## Implementation Steps

1. Add this plan under `docs/plans/134-operator-tooling-runtime-docs/plan.md`.
2. Update `skills/symphony-operator/SKILL.md`:
   - prefer `symphony factory status --json` as the first health check
   - describe the detached factory-control surface explicitly
   - make runner expectations runner-neutral across `codex`, `claude-code`, and `generic-command`
3. Update `.ralph/ralph-loop.sh`:
   - replace worker-health inference based on process greps with factory-control JSON when available
   - keep graceful fallback behavior if the command fails
   - update the operator prompt so it tells the model to use the factory-control surface
4. Update `README.md`:
   - clarify the multi-runner story
   - clarify the distinction between `status` and `factory status`
   - clarify `workspace.repo_url` as an explicit/fallback config field rather than always-required bootstrap config
5. Update `docs/guides/self-hosting-loop.md`:
   - align setup with the current checked-in `WORKFLOW.md`
   - include the factory-control/status commands as the normal operator surface
6. Run repo checks appropriate to the touched files.
7. Commit, push, and open a PR referencing `#134`.

## Tests

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

Even though this slice is mostly docs and shell tooling, run the standard gates because `.ralph/ralph-loop.sh` changes operator automation and the repository standard requires clean local validation before PR creation.

## Acceptance Scenarios

1. An operator reading `skills/symphony-operator/SKILL.md` learns to inspect the factory via `symphony factory status --json` rather than inferring health from raw process lists first.
2. Ralph’s generated status files reflect factory-control state, workerAlive, and embedded runtime status rather than only process grep results.
3. A new reader can follow `README.md` and understand:
   - the supported runner kinds
   - how `codex` differs from `claude-code` and `generic-command`
   - the distinction between `status` and `factory status`
4. A reader following `docs/guides/self-hosting-loop.md` sees the current self-hosting commands and current checked-in workflow assumptions.

## Exit Criteria

- operator skill reflects the factory-control and runner model now on `main`
- Ralph status generation consumes the control surface instead of the old worker-grep heuristic alone
- README and self-hosting guide no longer contain the identified stale assumptions
- local validation passes
- PR is opened against `main` and references `#134`

## Deferred

- any follow-up runtime changes if the new operator flow reveals control-surface gaps
- broader operator dashboard / TUI workflow changes
- issue-specific runtime fixes such as guarded-landing artifact semantics or watchdog false positives
