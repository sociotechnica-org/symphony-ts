# Issue 134 Plan

## Summary

Align the operator tooling and core docs with the merged factory-control CLI and multi-runner runtime model.

Plan approval is waived for this issue by direct operator instruction in the local session requesting immediate implementation and PR creation.

## Scope

- update operator guidance to prefer `symphony factory status|start|stop|restart`
- update durable operator-facing docs and skill guidance for the factory-control runtime model without checking local operator automation into the repo from a gitignored path
- update `README.md` to reflect the current runner model, status surfaces, and workflow/config behavior
- update `docs/guides/self-hosting-loop.md` to reflect the current self-hosting runtime contract

## Non-Goals

- changing runtime behavior in `src/orchestrator/`, `src/runner/`, or `src/tracker/`
- redesigning the operator workflow beyond what is needed to match the merged runtime
- introducing new control or dashboard features
- changing issue/pull-request lifecycle policy

## Current Gaps

- operator guidance still describes health checks in terms of live worker / child processes rather than the new factory-control surface
- the checked-in operator/docs surface does not yet give contributors a clean, versioned home for operator-loop automation without force-adding from `.ralph/`
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
  - does not belong: changing retries, watchdog logic, reconciliation behavior, or repackaging local operator automation as part of this docs slice
- Execution
  - belongs: documenting the current multi-runner model and runner-neutral operator expectations
  - does not belong: runner implementation changes or checking in local operator-loop automation from a gitignored path
- Integration
  - belongs: none beyond describing current GitHub-facing behavior accurately
  - does not belong: tracker transport or normalization changes
- Observability
  - belongs: operator-facing status surfaces, degraded-state interpretation, Ralph status generation
  - does not belong: redesigning the runtime status schema

## Architecture Boundaries

- Keep `skills/symphony-operator/SKILL.md` focused on durable operator behavior, not transient overnight facts.
- Defer packaging of the Ralph/operator loop as first-class repo tooling to a dedicated follow-up issue rather than mixing it into this docs refresh.
- Keep `README.md` high-signal and operator-facing; do not duplicate every internal implementation detail.
- Keep `docs/guides/self-hosting-loop.md` focused on the repo’s real operating loop, not broad architecture explanations.

## Slice Strategy

One reviewable docs-and-skill PR:

1. add the issue plan documenting the intended seam
2. update operator guidance
3. update README and self-hosting guide to match the merged runtime
4. defer operator-loop packaging to a follow-up issue

This stays reviewable because it does not touch core runtime logic or introduce checked-in tooling from `.ralph/`; it only aligns durable docs and operator guidance with already-merged behavior.

## Implementation Steps

1. Add this plan under `docs/plans/134-operator-tooling-runtime-docs/plan.md`.
2. Update `skills/symphony-operator/SKILL.md`:
   - prefer `symphony factory status --json` as the first health check
   - describe the detached factory-control surface explicitly
   - make runner expectations runner-neutral across `codex`, `claude-code`, and `generic-command`
3. Update `README.md`:
   - clarify the multi-runner story
   - clarify the distinction between `status` and `factory status`
   - clarify `workspace.repo_url` as an explicit/fallback config field rather than always-required bootstrap config
4. Update `docs/guides/self-hosting-loop.md`:
   - align setup with the current checked-in `WORKFLOW.md`
   - include the factory-control/status commands as the normal operator surface
5. Record follow-up issue `#136` for packaging operator-loop automation as a first-class repo-owned tool instead of checking it in via `.ralph/`.
6. Run repo checks appropriate to the touched files.
7. Commit, push, and open a PR referencing `#134`.

## Tests

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

Even though this slice is mostly docs and skill guidance, run the standard gates because the repository standard requires clean local validation before PR creation.

## Acceptance Scenarios

1. An operator reading `skills/symphony-operator/SKILL.md` learns to inspect the factory via `symphony factory status --json` rather than inferring health from raw process lists first.
2. A new reader can follow `README.md` and understand:
   - the supported runner kinds
   - how `codex` differs from `claude-code` and `generic-command`
   - the distinction between `status` and `factory status`
3. A reader following `docs/guides/self-hosting-loop.md` sees the current self-hosting commands and current checked-in workflow assumptions.
4. Checked-in packaging for the Ralph/operator loop is explicitly deferred to `#136` instead of being shipped from `.ralph/`.

## Exit Criteria

- operator skill reflects the factory-control and runner model now on `main`
- README and self-hosting guide no longer contain the identified stale assumptions
- checked-in operator-loop packaging is explicitly deferred to `#136`
- local validation passes
- PR is opened against `main` and references `#134`

## Deferred

- any follow-up runtime changes if the new operator flow reveals control-surface gaps
- packaging the Ralph/operator loop as first-class repo tooling instead of a gitignored local script (`#136`)
- broader operator dashboard / TUI workflow changes
- issue-specific runtime fixes such as guarded-landing artifact semantics or watchdog false positives
