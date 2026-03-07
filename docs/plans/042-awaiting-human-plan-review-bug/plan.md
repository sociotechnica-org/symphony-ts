# Bug: Do Not Fail Runs While Waiting For Human Plan Review

## Objective

Teach the GitHub bootstrap runtime to treat `plan-ready -> awaiting human review` as a valid pre-PR handoff state so the factory waits instead of retrying/failing when a worker intentionally stops after plan creation.

## Scope

- detect plan-review handoff state from issue comments when no PR exists for an issue branch
- represent that handoff as a normalized runtime lifecycle state
- keep the orchestrator in a waiting state instead of retry/fail for that handoff
- resume issue execution when issue comments indicate `approved`, `waived`, or `changes-requested`
- surface the waiting state in factory status/observability
- cover the behavior with unit and integration tests using the mock GitHub server

## Non-goals

- redesigning the broader PR lifecycle loop
- adding richer human-facing comment templates or acknowledgement comments
- changing the plan-review policy itself
- Beads-specific workflow behavior

## Current Gap

The runtime still treats a successful worker run with no PR as failure. That matched the pre-plan-review workflow but now breaks valid `plan-ready` handoffs. Issue `#32` proved the live gap: the worker wrote a plan, requested human review, then the runtime retried and failed with `No open pull request found for symphony/32`.

## Spec / Layer Mapping

- Policy: plan review as a valid handoff already lives in `WORKFLOW.md`, `AGENTS.md`, and `skills/symphony-plan/SKILL.md`
- Configuration: no config schema changes expected
- Coordination: orchestrator must recognize and wait on a valid pre-PR handoff instead of treating it as failure
- Execution: worker reruns should resume only after explicit approval, waiver, or requested revisions
- Integration: GitHub tracker adapter must read issue comments as tracker-side handoff input while GitHub remains the tracker
- Observability: status snapshot must surface the plan-review waiting state distinctly from active execution and PR review

## Architecture Boundaries

- tracker transport: fetch issue comments from GitHub REST separately from PR transport
- tracker normalization/policy: parse issue comments into normalized plan-review handoff state in focused modules instead of embedding ad hoc string checks in orchestrator code
- orchestrator: consume the normalized handoff state and wait; do not parse GitHub comment bodies directly
- observability: reflect the new waiting state without coupling status rendering to comment parsing rules

## Slice Strategy

This issue should fit in one reviewable PR because it is a narrow runtime-correctness seam:

1. add a normalized pre-PR plan-review lifecycle path
2. integrate it into the existing tracker/orchestrator handoff flow
3. add focused tests for the exact failure mode from `#32`

The richer human-facing protocol and acknowledgement loop are deferred to `#48`.

## Runtime State Machine And Failure Matrix

### States touched

- `missing`
- `awaiting-plan-review` (new)
- `awaiting-review`
- `needs-follow-up`
- `ready`

### Allowed transitions introduced

- successful run with no PR + latest relevant comment is `Plan status: plan-ready` -> `awaiting-plan-review`
- `awaiting-plan-review` + later `Plan review: approved` -> rerun issue without failing on missing PR
- `awaiting-plan-review` + later `Plan review: waived` -> rerun issue without failing on missing PR
- `awaiting-plan-review` + later `Plan review: changes-requested` -> rerun issue to revise the plan

### Failure classes

| Scenario                                             | Evidence                                                           | Expected behavior                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| No PR exists and no valid plan-review handoff exists | no PR, no relevant issue comment state                             | keep existing failure behavior                    |
| Worker stopped at plan-ready                         | no PR, latest relevant comment is `Plan status: plan-ready`        | wait in `awaiting-plan-review`; do not retry/fail |
| Human approved/waived after plan-ready               | no PR, latest relevant comment is `Plan review: approved/waived`   | rerun issue; do not fail                          |
| Human requested plan changes                         | no PR, latest relevant comment is `Plan review: changes-requested` | rerun issue to revise plan                        |

## Implementation Steps

1. Add a plan-review comment parser and normalized handoff evaluator in the tracker layer.
2. Extend GitHub transport to fetch issue comments with enough metadata for ordering.
3. Extend the lifecycle kind/status model with `awaiting-plan-review`.
4. Update the GitHub bootstrap tracker so missing-PR cases consult plan-review handoff state before returning `missing`.
5. Update orchestrator/status handling to treat `awaiting-plan-review` as a valid waiting state.
6. Add integration tests for:
   - plan-ready handoff waits
   - approved resumes
   - changes-requested resumes
7. Add orchestrator/unit tests for the live `#32` failure mode.

## Tests And Acceptance Scenarios

- unit tests for plan-review comment parsing and ordering
- integration tests for tracker handoff classification when no PR exists
- orchestrator unit test proving a successful run can stop at plan review without failure
- full repo gate: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`

## Observability

- status snapshot should expose `awaiting-plan-review` distinctly
- last action summary should reflect plan-review waiting rather than missing PR failure

## Exit Criteria

- a worker that stops at `plan-ready` without opening a PR is left waiting, not failed
- approval/waiver/changes-requested comments cause the issue to resume instead of failing on missing PR
- the status snapshot shows the waiting state distinctly
- the live `#32` failure mode is covered by tests

## Deferred Work

- human-facing plan-review templates and acknowledgement comments (`#48`)
- Beads-native plan-review state model
- any broader redesign of issue reporting or PR review flow

## Revision Log

- 2026-03-07: Initial plan for runtime support of pre-PR plan-review handoff.
