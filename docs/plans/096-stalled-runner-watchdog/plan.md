# Plan: Stalled Runner Watchdog and Auto-Recovery

**Issue:** #96
**Status:** waived
**Plan review note:** Operator-directed continuation on the existing implementation branch and PR follow-up; no separate human wait state for this review-driven slice.
**Primary PR seam:** watchdog liveness and recovery correctness in the existing `#96` PR

## Goal

Ship stalled-runner detection and bounded auto-recovery for local factory runs, then close the remaining correctness gaps found during PR review.

## Scope

- detect stalled active runs from concrete liveness signals
- classify the stall reason in runtime/status state
- abort the stale runner process
- requeue through the existing retry path when recovery budget remains
- stop the runner even when the recovery budget is exhausted
- keep filesystem liveness sampling isolated per active run
- add regression coverage for mocked stalled-runner behavior

## Non-goals

- redesigning runner execution architecture
- changing merge automation policy
- replacing human operator controls
- introducing tracker-specific recovery rules
- inventing a new durable lease or supervision subsystem for this issue

## Current Gaps

- the watchdog currently relies on best-effort liveness probes and recovery state inside orchestrator runtime state
- `FsLivenessProbe` can accidentally sample a shared log path instead of a per-run path, which contaminates concurrent stall detection
- the recovery-limit branch can classify a runner as stalled but leave it alive, which leaks the slot and blocks future work
- `maxRecoveryAttempts` currently behaves like a per-run-attempt budget because watchdog recovery state is deleted before the retry path re-enters the issue
- the stall timer can age while every liveness signal remains `null`, which creates false-positive early-run stalls and misleading `"log-stall"` classification
- the watchdog log-path convention is implicit instead of being named as a shared contract in code
- watchdog enablement currently degrades silently if the orchestrator is constructed without a `livenessProbe`, so operators can believe monitoring is active when no stall detection will run
- the existing plan in this directory was too thin to document the actual runtime-state and failure-handling seam

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs here: issue-owned scope, bounded recovery policy, plan waiver note for this review-driven follow-up
- does not belong here: filesystem path logic, runner abort plumbing, tracker transport details

### Configuration Layer

- belongs here: existing `WatchdogConfig` contract on polling settings
- does not belong here: per-run liveness bookkeeping or tracker lifecycle decisions
- touched only to preserve the existing watchdog contract; no new config fields are needed for the review follow-up

### Coordination Layer

- belongs here: watchdog loop scheduling, recovery-budget checks, runtime watchdog state, decision to abort only vs abort-and-requeue
- does not belong here: tracker API normalization or runner-specific log file production
- this is the primary layer touched by the follow-up

### Execution Layer

- belongs here: runner process termination and per-run filesystem signal sampling
- does not belong here: retry policy or tracker handoff rules
- this slice touches execution only where needed to identify the correct per-run log target and stop the stale process

### Integration Layer

- untouched by this follow-up
- tracker transport, normalization, and lifecycle policy stay unchanged

### Observability Layer

- belongs here: structured warning/recovery events and status action snapshots that explain why a run was stalled or aborted
- does not belong here: recovery policy branching or liveness probe mutation
- existing observability stays intact, but exhausted recovery must also emit a persisted status action so operators can see why the runner was aborted

## Architecture Boundaries

- `src/orchestrator/stall-detector.ts` remains pure coordination logic for signal comparison and stall classification
- `src/orchestrator/liveness-probe.ts` owns best-effort local signal collection only; it must not encode retry policy
- `src/orchestrator/service.ts` owns the watchdog loop, recovery budgeting, and abort behavior
- tracker adapters remain consumers of normalized handoff state only; this issue must not add GitHub-specific watchdog conditions
- status and artifacts may report watchdog actions, but they should not become the source of watchdog decisions

## Runtime State Machine

This issue relies on explicit watchdog state in the orchestrator:

1. `watching`
   The runner is active and the watchdog is sampling liveness.
2. `stalled-recoverable`
   Signals show no progress beyond threshold and `recoveryCount < maxRecoveryAttempts`.
3. `aborting-for-retry`
   The watchdog records recovery, emits the recovery action, and aborts the runner so the existing retry path can launch a new attempt.
4. `stalled-terminal`
   Signals show no progress beyond threshold and the issue-scoped watchdog recovery budget is exhausted.
5. `aborting-terminal`
   The watchdog aborts the runner without incrementing recovery or emitting a retry-oriented recovery action.
6. `runner-finished`
   The runner exits or throws; the watchdog loop is stopped and runtime state is cleaned up.
7. `waiting-for-first-signal`
   The runner is active but the probe has not yet observed any concrete log, workspace, or PR-head signal, so the stall clock must not advance.

Allowed transitions:

- `watching -> waiting-for-first-signal -> watching`
- `watching -> stalled-recoverable -> aborting-for-retry -> runner-finished`
- `watching -> stalled-terminal -> aborting-terminal -> runner-finished`
- `watching -> runner-finished`

Invalid transitions:

- watchdog-triggered transition directly into tracker-specific labels or comments
- multiple concurrent watchdog entries for one issue
- leaving a runner in `stalled-terminal` without moving to `aborting-terminal`

## Failure-Class Matrix

| Observed condition                                              | Local facts available                                          | Normalized tracker facts                     | Expected decision                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Log, diff, or PR head changes within threshold                  | runner live, liveness snapshot changed                         | current lifecycle unchanged                  | remain `watching`                                                                                                                  |
| No liveness change past threshold and recovery budget remains   | runner live, watchdog entry present, `canRecover = true`       | issue still active                           | record recovery, emit watchdog recovery action, abort runner so retry path can continue                                            |
| No liveness change past threshold and recovery budget exhausted | runner live, watchdog entry present, `canRecover = false`      | issue still active                           | emit a terminal watchdog status action, abort runner without requeue-oriented recovery bookkeeping, and do not leave slot occupied |
| Probe has not observed any concrete liveness signal yet         | all probe signals `null`; runner may still be booting          | tracker facts may also be empty              | remain in `waiting-for-first-signal`, keep sampling, and do not classify a stall yet                                               |
| Probe fails transiently                                         | runner state unknown for one sample                            | tracker unchanged                            | log probe failure and keep watching                                                                                                |
| Runner exits or throws before watchdog fires                    | runner promise settled, watchdog stop signal aborted           | tracker lifecycle handled by normal run flow | stop watchdog cleanly and remove runtime state                                                                                     |
| Two active issues probe logs concurrently                       | separate issue number / run session id / workspace root inputs | tracker facts independent                    | sample per-run log paths only; no cross-issue signal sharing                                                                       |

## Slice Strategy And PR Size

This remains one reviewable PR because the follow-up only closes watchdog correctness gaps already identified on PR `#97`.

What lands in this slice:

- per-run log-path derivation inside `FsLivenessProbe`
- a named watchdog log-file contract helper shared by the probe and tests
- unconditional runner abort when a stall is confirmed but recovery is exhausted
- issue-scoped watchdog recovery budgeting that survives retries until the issue completes or fails
- regression tests for both cases plus the all-signals-null guard
- plan refresh so the recorded seam matches the shipped code

Deferred from this slice:

- richer runner-managed session log pointer contracts
- watchdog-specific tracker comments beyond the current structured status/event surface
- broader runner supervision refactors

## Storage And Persistence Contract

- watchdog runtime state stays in `src/orchestrator/state.ts` and remains process-local
- the issue-scoped watchdog recovery budget persists only in process memory for the lifetime of the active factory instance
- no new durable files or tracker records are introduced by this follow-up
- filesystem liveness sampling is best-effort and must tolerate missing log files by returning `null`

## Observability Requirements

- preserve stall reason classification (`log-stall`, `workspace-stall`, `pr-stall`)
- preserve structured warnings for probe failure and recovery-limit exhaustion
- warn explicitly when watchdog config is enabled without a liveness probe so the degraded runtime is inspectable
- keep the existing `watchdog-recovery` status action only for the retryable recovery path
- emit a distinct terminal status action when recovery is exhausted so `status.json` does not silently lose the stalled-runner context
- avoid implying successful recovery when the watchdog is only performing a terminal abort

## Implementation Steps

1. Refresh this plan so the #96 review-driven seam, state machine, and failure matrix are explicit.
2. Extend watchdog runtime state so the recovery counter survives active-entry cleanup and is cleared only on terminal issue completion or failure.
3. Update `checkStall` to treat "no observable signal yet" as a waiting state and to treat first observation of a signal as progress instead of an immediate stall.
4. Add a named watchdog log-file helper and update `FsLivenessProbe` to derive a unique per-run log filename from `runSessionId` when available, with a deterministic per-issue fallback when it is not.
5. Update the watchdog loop in `src/orchestrator/service.ts` so a confirmed stalled runner is always aborted, even when `maxRecoveryAttempts` has already been reached.
6. Keep the retry-oriented recovery bookkeeping limited to the recoverable branch so exhausted recovery does not fabricate another retry, but still persist a terminal watchdog status action before aborting.
7. Add unit coverage for the per-run log probe behavior, the all-signals-null guard, and the cross-retry recovery-budget bound.
8. Add a watchdog regression test for the enabled-without-probe configuration so the warning path and entry guard stay aligned.
9. Run formatting, lint, typecheck, tests, `codex review --base origin/main`, then update the existing PR with the fixes and resolve the automated review feedback.

## Tests And Acceptance Scenarios

Unit coverage:

- `FsLivenessProbe` reads a run-specific log path derived from `runSessionId`
- `FsLivenessProbe` falls back to a per-issue log path when no session id is available
- `checkStall` does not classify a stall while every liveness signal remains unobserved
- watchdog aborts a stalled runner when recovery is exhausted and does not require a retry budget
- watchdog enabled without a probe warns and skips monitoring without fabricating active watchdog state

Integration / orchestrator coverage:

- stalled runner with immediate watchdog detection is aborted and the run returns cleanly
- stalled runner with no recovery budget still gets aborted so the concurrency slot is released and the status snapshot records the terminal watchdog action
- repeated stalled retries stop recovering once the issue-scoped `maxRecoveryAttempts` budget is exhausted

Named acceptance scenarios:

1. Given two active runs with different session ids, when one run’s log grows, then the other run’s liveness snapshot is unaffected by that write.
2. Given a stalled run with `maxRecoveryAttempts` already exhausted, when the watchdog classifies the stall, then the runner is aborted, no indefinite live process remains, and `status.json` records the terminal watchdog action.
3. Given a stalled run with recovery budget remaining, when the watchdog classifies the stall, then the runner is aborted, the existing retry path can requeue, and observability records the recovery action.
4. Given a runner that has not yet produced any observable log, workspace, or PR signal, when the watchdog samples repeatedly, then it does not classify a stall until at least one concrete signal exists.
5. Given a runner that stalls on consecutive retries, when the issue reaches the configured `maxRecoveryAttempts`, then later retries abort terminally instead of resetting the watchdog recovery budget.
6. Given watchdog config enabled without a liveness probe, when a run starts, then Symphony warns that stall detection is disabled instead of silently pretending to monitor liveness.

## Exit Criteria

- the shared-log-path bug is removed
- the exhausted-recovery branch aborts the stalled runner
- watchdog regressions are covered by tests
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass
- `codex review --base origin/main` runs clean after fixes
- PR `#97` reflects the follow-up and no actionable automated review comments remain

## Deferred To Later Issues Or PRs

- standardized runner-emitted log pointer locations for all runner backends
- verification that every runner backend writes the optional watchdog session log to the named contract path
- richer terminal watchdog reporting beyond the single status action and warning emitted in this slice
- longer-lived durable recovery counters across process restarts
- broader supervision and lease recovery refinements beyond the watchdog seam

## Decision Notes

- The per-run log-path fix stays in the execution-facing liveness probe instead of moving into the runner because the current issue only needs isolated sampling, not a new log artifact contract.
- The terminal stall branch still aborts the runner even though it does not requeue; bounded recovery must stop leaked work, not permit indefinite occupancy.
