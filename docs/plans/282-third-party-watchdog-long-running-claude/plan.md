# Issue 282 Plan: Third-Party Watchdog Robustness For Long-Running Claude Tasks

## Status

- approved
- Review handoff recorded on issue `#282` with `Plan review: approved`

## Goal

Make third-party factory watchdog behavior robust for long-running Claude tasks by replacing the single watchdog idle budget with explicit reviewed budgets for active execution and PR follow-through, without weakening genuine-stall detection or mixing tracker-specific policy into the fix.

## Scope

- recreate the missing checked-in plan document for the already approved issue seam
- keep the runtime change narrow around watchdog policy and workflow config
- let active execution use a distinct idle budget from PR follow-through
- preserve existing watchdog reason precedence (`pr-stall` > `workspace-stall` > `log-stall`)
- add parser, detector, orchestrator, and end-to-end coverage for representative long-running Claude quiet periods
- document the new watchdog frontmatter contract

## Non-goals

- redesigning the overall watchdog architecture
- changing tracker transport, normalization, or lifecycle policy
- adding Claude-specific output parsing
- introducing cross-restart watchdog persistence
- changing retry budgets or retry classes
- broad TUI or status-surface redesign

## Current Gaps

- the current watchdog uses one global `stall_threshold_ms` for every active-run posture
- long third-party Claude turns can make legitimate progress, then remain quiet for longer than that single threshold while still being healthy
- the earlier `#251` slice covered raw stdio activity, but it does not cover the remaining quiet-period case where a run has already written or opened a PR and then goes silent while still working
- the current config cannot express a reviewed distinction between execution-idle tolerance and PR follow-through tolerance

## Decision Notes

- treat this as a coordination/config policy issue first, not a tracker issue
- keep the change provider-neutral even though Claude is the motivating failure mode
- preserve the existing stall reasons and recovery model; only the idle-budget selection changes
- keep backward compatibility by retaining `stall_threshold_ms` as the base/default contract

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs here:
  - the repo-owned rule that one watchdog threshold is too brittle for long-running third-party tasks
  - the policy that idle budgets should differ between active execution and PR follow-through
- does not belong here:
  - subprocess plumbing
  - GitHub-specific handoff parsing

### Configuration Layer

- belongs here:
  - extending `polling.watchdog` with explicit reviewed idle-budget fields
  - retaining `stall_threshold_ms` as the compatibility baseline/default
- does not belong here:
  - watchdog classification branches hidden outside typed config resolution

### Coordination Layer

- belongs here:
  - selecting the applicable watchdog idle budget from normalized liveness facts
  - preserving explicit stall-reason precedence and recovery decisions
- does not belong here:
  - tracker API behavior
  - provider-specific Claude parsing

### Execution Layer

- touched only enough to support regression coverage
- does not own watchdog budget policy

### Integration Layer

- intentionally untouched
- tracker transport, normalization, and policy remain unchanged

### Observability Layer

- belongs here:
  - reflecting the new config contract in docs and preserving explicit watchdog outcomes in tests/status
- does not belong here:
  - becoming the source of threshold-selection policy truth

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - extend typed watchdog config with explicit idle-budget fields
- `src/config/workflow.ts`
  - parse and validate the new fields while preserving backward compatibility
- `src/orchestrator/stall-detector.ts`
  - select the applicable threshold from normalized liveness facts
- tests
  - parser coverage
  - detector coverage
  - orchestrator/e2e regressions for quiet long-running Claude postures
- docs
  - frontmatter reference updates for the new watchdog contract

### Does not belong in this issue

- tracker lifecycle changes
- runner protocol redesign
- remote execution changes
- broad observability refactors

## Layering Notes

- config/workflow
  - defines the reviewed contract
  - must not embed tracker-specific policy
- runner
  - may help reproduce the regression in tests
  - must not choose watchdog thresholds
- orchestrator
  - chooses the applicable budget and enforces recovery
  - must not reach into tracker transport details
- tracker
  - remains the source of normalized PR/review facts
  - must not compensate for watchdog policy gaps

## Slice Strategy And PR Seam

This issue stays reviewable in one PR by limiting the change to one seam:

1. restore the missing approved plan file
2. add explicit watchdog idle-budget config fields
3. teach the detector how to choose between execution and PR-follow-through budgets
4. add focused regressions for quiet long-running Claude behavior
5. document the contract

Deferred from this PR:

- multi-phase budgets beyond execution vs PR follow-through
- semantic parsing of Claude output
- durable watchdog forensics across restarts

## Runtime State Machine

States for one active issue:

1. `watching-execution`
   - no PR-follow-through posture is active
   - watchdog uses the execution idle budget
2. `watching-pr-follow-through`
   - a PR exists for the active run
   - watchdog uses the PR-follow-through idle budget
3. `stalled-recoverable`
   - no observable activity advanced within the applicable budget and recovery remains
4. `stalled-terminal`
   - no observable activity advanced within the applicable budget and recovery is exhausted
5. `runner-finished`
   - the run exits normally and watchdog state is cleared

Allowed transitions:

- `watching-execution -> watching-execution`
- `watching-execution -> watching-pr-follow-through`
- `watching-pr-follow-through -> watching-pr-follow-through`
- `watching-execution -> stalled-recoverable`
- `watching-execution -> stalled-terminal`
- `watching-pr-follow-through -> stalled-recoverable`
- `watching-pr-follow-through -> stalled-terminal`
- `stalled-recoverable -> runner-finished`
- `stalled-terminal -> runner-finished`
- `watching-execution -> runner-finished`
- `watching-pr-follow-through -> runner-finished`

Authoritative activity sources remain unchanged in this slice:

- run start
- runner heartbeat/action
- watchdog log growth
- workspace diff movement
- PR head movement

The changed policy in this slice is only which idle threshold applies when those sources stop moving.

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Long Claude execution wrote files early, then went quiet with no PR yet | workspace diff hash present, no new log/heartbeat activity | none required | use execution idle budget; do not stall until that budget expires |
| Long Claude follow-up run has an open PR and is quiet while processing review/check context | PR head SHA present, no new log/heartbeat activity | normalized PR snapshot | use PR follow-through idle budget; do not stall until that budget expires |
| No observable activity within the applicable budget and no PR exists | stale local liveness signals | none required | classify using existing reason precedence and recover/abort normally |
| No observable activity within the applicable budget and PR facts remain unchanged | stale local liveness signals | PR head/actionable feedback unchanged | classify `pr-stall` or `workspace-stall` with existing precedence and recover/abort normally |
| Observable activity resumes before the applicable budget expires | advancing heartbeat/log/diff/PR facts | whatever tracker facts already exist | treat as live and reset idle baseline |

## Storage / Persistence Contract

- no new durable tracker or workspace state is introduced
- workflow config becomes the only new durable contract in this slice
- status and issue artifacts continue to reflect the existing watchdog outcomes and summaries

## Observability Requirements

- watchdog summaries must remain explicit about the classified reason
- docs must make the new idle-budget contract inspectable to operators
- tests should prove which threshold is being applied without requiring operator guesswork

## Implementation Steps

1. Restore the missing checked-in plan document on the issue branch.
2. Extend `WatchdogConfig` with explicit execution and PR-follow-through threshold fields that default from `stall_threshold_ms`.
3. Parse and validate the new frontmatter fields in workflow config resolution.
4. Update stall detection to select the applicable threshold from normalized liveness facts while preserving existing reason precedence.
5. Add detector tests covering threshold selection for execution and PR-follow-through postures.
6. Add a regression that simulates a quiet long-running Claude execution posture not already covered by raw-stdio tests.
7. Update frontmatter docs for the new watchdog fields.

## Tests

Unit:

- `tests/unit/workflow.test.ts`
  - loads the new watchdog threshold fields
  - preserves backward-compatible defaults from `stall_threshold_ms`
- `tests/unit/stall-detector.test.ts`
  - execution posture uses execution threshold
  - PR posture uses PR-follow-through threshold
  - reason precedence remains unchanged

Orchestrator / end-to-end:

- add a regression where a Claude fixture writes early, then stays quiet longer than the execution baseline but shorter than the execution-specific threshold
- add a regression where a PR-follow-through posture remains quiet longer than the baseline but shorter than the PR threshold

## Acceptance Scenarios

1. A long-running Claude task that writes early but then remains quiet does not fail at the old single global threshold when the execution threshold is higher.
2. A long-running Claude follow-up with an open PR does not fail at the old single global threshold when the PR threshold is higher.
3. A genuinely silent stalled run still fails once the applicable threshold is exceeded.
4. Existing `pr-stall` / `workspace-stall` classification precedence remains unchanged.

## Exit Criteria

- plan file exists in the repository and matches the approved issue seam
- watchdog config supports explicit execution and PR-follow-through idle budgets
- detector applies the correct threshold without changing stall-reason precedence
- quiet long-running Claude regressions are covered by tests
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- more than two watchdog idle phases
- provider-specific progress semantics
- restart-persistent watchdog state or forensics
