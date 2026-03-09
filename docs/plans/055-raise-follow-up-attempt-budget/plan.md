# Phase 1.3.x Technical Plan: Raise Default Follow-Up Attempt Budget

## Objective

Raise the default `polling.retry.max_follow_up_attempts` in `WORKFLOW.md` from `2` to `25` so the factory tolerates the review-loop depth already observed in this repo.

## Scope

- update the default in `WORKFLOW.md`
- update any docs/tests that depend on the previous default, if any
- validate that config parsing and test suites still pass

## Non-goals

- redesigning follow-up budget semantics
- changing non-review retry behavior
- making the follow-up budget unbounded
- modifying the runtime algorithm in `follow-up-state.ts`

## Current Gap

The current default of `2` is effectively allowing only one rerun after the initial implementation run before the issue is marked `symphony:failed`. Recent merged PRs in this repo required substantially more review-fix cycles than that.

## Spec / Layer Mapping

- Policy: default operational budget for review follow-up depth
- Configuration: `WORKFLOW.md` default `polling.retry.max_follow_up_attempts`
- Coordination: unchanged runtime logic; only the configured ceiling changes
- Execution: unchanged
- Integration: unchanged
- Observability: unchanged except downstream behavior from the higher configured ceiling

## Architecture Boundaries

- This issue changes the default config only.
- It does not change tracker policy, orchestrator algorithms, or runner behavior.
- The deeper redesign of how follow-up budgets should work belongs in a later issue.

## Slice Strategy

This fits in one small PR because it is a single configuration default change with validation only.

## Implementation Steps

1. Change `polling.retry.max_follow_up_attempts` default in `WORKFLOW.md` from `2` to `25`.
2. Search for docs/tests that assume the old default and update only if necessary.
3. Run format, lint, typecheck, and test.
4. Open a small PR referencing `#55`.

## Tests and Acceptance Scenarios

- Config continues to parse successfully from `WORKFLOW.md`.
- Existing tests continue to pass unchanged unless they intentionally assert the default value.
- Factory runtime can be restarted later using the new default without further code changes.

## Observability

- No new observability surface in this issue.
- The effect should later be visible only as fewer premature `symphony:failed` transitions during long review loops.

## Exit Criteria

- `WORKFLOW.md` default is `25`
- local gate passes
- PR is clean and mergeable

## Deferred Work

- better follow-up budget semantics
- distinction between bot-only and human-only review loops
- pause/escalate behavior instead of hard failure

## Revision Log

- 2026-03-09: Initial plan created. Plan review waived by direct user instruction to implement this fix immediately.
