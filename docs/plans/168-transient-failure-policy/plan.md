# Issue 168 Plan: Rate-Limit And Transient-Failure Handling Policy

## Status

- plan-ready

## Goal

Define and implement a first-class transient-failure policy so Symphony can distinguish provider pressure, account limits, and ordinary runner failures. The runtime should decide when to pause dispatch, when to queue a retry, and when to fail terminally from normalized failure classes instead of treating every non-zero runner outcome as the same `run-failure` path.

This is the next Phase 6 follow-up seam after `#164`: retry/backoff state now exists, but failure classification and dispatch posture are still too implicit for operationally credible handling of provider pressure.

## Scope

- define a normalized transient-failure classification seam for runner outcomes and runner update signals
- classify at least these conditions distinctly:
  - provider rate-limit pressure
  - provider/account access pressure
  - ordinary transient runner failure
  - existing terminal/non-transient paths that should keep current behavior
- add a coordination-owned dispatch-pressure state that can pause new work intentionally while a provider-pressure window is active
- apply retry/backoff policy from the normalized failure class instead of hard-coding all non-zero exits as `run-failure`
- preserve the existing retry queue as the per-issue retry owner, but widen it just enough to represent transient/provider-pressure classes clearly
- project pressure posture and transient retry posture through status/TUI so operators can see why work is paused or deferred
- add unit, integration, and end-to-end tests for classification, pause/hold/release behavior, and operator-visible posture

## Non-Goals

- changing tracker transport or normalization contracts
- redesigning the issue/PR handoff lifecycle
- introducing durable transient-failure or retry persistence across process restarts
- adding new workflow knobs for per-class backoff, jitter, or retry budgets in this slice
- broad runner API redesign beyond the minimum normalized signal surface needed for transient-failure policy
- provider-specific policy for every possible backend; this slice should cover the signals Symphony already sees today and provide a narrow contract for future providers
- changing landing, review-loop, or watchdog policy except where they must consume the clearer transient-failure seam

## Current Gaps

- `src/orchestrator/service.ts` routes non-zero runner exits into one generic `run-failure` retry class
- `src/domain/retry.ts` has no class for rate-limit or account-pressure retries, so operator-visible retry posture cannot explain why a retry is queued
- `src/orchestrator/state.ts` already has a `rateLimits` slot, but coordination does not currently use provider-pressure facts to gate dispatch
- runner update ingestion records token/accounting facts, but there is no normalized transient-pressure contract that the orchestrator can consume
- status/TUI can show retry queue entries, but not a clear "dispatch paused because provider pressure is active" posture
- the current retry budget path does not clearly document whether provider pressure should pause the whole factory, defer only one issue, or both

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in `docs/architecture.md`.

### Policy Layer

Belongs here:

- the repo-owned rule that provider pressure and ordinary run failure are different failure classes
- the rule that provider pressure may pause dispatch intentionally instead of letting the factory thrash
- the rule that operator-visible status must explain whether Symphony is retrying one issue or pausing broader dispatch

Does not belong here:

- provider payload parsing details
- in-memory state container choices
- TUI string formatting

### Configuration Layer

Belongs here:

- reuse existing retry policy inputs already resolved from workflow config:
  - `polling.retry.maxAttempts`
  - `polling.retry.backoffMs`

Does not belong here:

- raw provider-pressure state
- tracker-specific pause rules
- new config unless implementation exposes a concrete missing boundary that cannot be expressed with current policy

### Coordination Layer

Belongs here:

- transient-failure classification consumption and disposition decisions
- dispatch-pressure runtime state and transitions
- decisions for pause, extend, release, retry, and terminal fail
- coordination between the retry queue and a global dispatch pause window

Does not belong here:

- raw Codex payload parsing
- tracker API transport details
- runner command construction

### Execution Layer

Belongs here:

- runner exit/output facts and normalized update signals that coordination consumes
- existing workspace/run-attempt mechanics when a deferred retry later re-enters dispatch

Does not belong here:

- dispatch pause policy
- retry budget ownership
- tracker comments or labels

### Integration Layer

Belongs here:

- existing tracker calls such as `recordRetry`, `markIssueFailed`, and lifecycle refresh
- normalized issue eligibility facts used when a paused factory resumes dispatch

Does not belong here:

- provider-pressure classification logic
- dispatch gate state
- retry queue storage

### Observability Layer

Belongs here:

- status snapshot and TUI projection for dispatch-pressure posture
- retry queue projection that names transient/provider-pressure classes clearly
- structured log fields for classify, pause, extend, release, retry, and exhaust decisions

Does not belong here:

- acting as the source of truth for pause policy
- inferring provider pressure by reparsing raw runner output independently of coordination

## Architecture Boundaries

### `src/runner/` normalized signal seam

Owns:

- extracting provider-neutral transient-pressure hints from the runner signals Symphony already receives
- keeping raw provider payload parsing close to the runner/update boundary

Does not own:

- retry budgets
- dispatch pause state
- tracker mutation policy

Decision note:

- This slice should prefer a small normalized signal/helper over letting `service.ts` parse provider-specific JSON ad hoc.

### `src/orchestrator/transient-failure-policy.ts` or equivalent focused module

Owns:

- mapping normalized runner facts into a transient-failure class and disposition
- deciding whether a failure means:
  - retry only
  - retry plus dispatch pause
  - terminal fail

Does not own:

- tracker writes
- raw runner I/O
- TUI formatting

### `src/orchestrator/dispatch-pressure-state.ts` or equivalent focused module

Owns:

- current pressure posture
- pause-until bookkeeping
- explicit transitions for activate, extend, clear, and release

Does not own:

- retry queue mutation beyond the explicit coordination seam
- tracker polling
- issue handoff policy

### `src/orchestrator/retry-state.ts`

Owns:

- per-issue retry queue state
- retry class storage and retry-entry release timing

Does not own:

- global dispatch pause posture
- raw failure parsing

Decision note:

- If provider-pressure retries need richer metadata than the current retry entry exposes, add it here rather than storing parallel ad hoc maps in `service.ts`.

### `src/orchestrator/service.ts`

Owns:

- orchestration flow and side-effect sequencing
- consuming the new transient-failure policy and dispatch-pressure state
- holding new dispatch while pressure posture is active

Does not own:

- inline provider-pressure heuristics spread across branches
- direct raw update parsing
- ad hoc pause bookkeeping

## Slice Strategy And PR Seam

This issue should land as one runner/coordination/observability slice:

1. add a normalized transient-failure classification seam
2. add coordination-owned dispatch-pressure state
3. route retry scheduling and dispatch gating through those explicit seams
4. project the resulting posture in status/TUI
5. add focused tests

Deferred from this PR:

- restart-durable pressure/retry persistence
- per-provider configurable retry classes or backoff knobs
- tracker comment wording redesign beyond what is needed to reflect the clearer retry class
- broader runner event/schema redesign
- manual operator controls to clear or override dispatch pressure

Why this seam is reviewable:

- it stays centered on one runtime concept: transient failure disposition
- it avoids mixing tracker transport changes with coordination policy
- it closes an operationally important gap without bundling a larger restart-persistence design into the same patch

## Runtime State Machine

This issue changes orchestration behavior, so both dispatch posture and per-issue retry posture must be explicit.

### Factory Dispatch-Pressure States

1. `dispatch-open`
   - no provider-pressure pause is active
2. `dispatch-paused`
   - new dispatch is intentionally blocked until a known or inferred `resumeAt`
3. `dispatch-paused-extended`
   - a new pressure signal extends or replaces the current pause window
4. `dispatch-released`
   - the pause window expired or was cleared by a newer non-pressure fact; dispatch may resume on the current or next poll

Allowed transitions:

- `dispatch-open -> dispatch-paused`
- `dispatch-paused -> dispatch-paused-extended`
- `dispatch-paused -> dispatch-released`
- `dispatch-paused-extended -> dispatch-released`
- `dispatch-released -> dispatch-open`

Decision notes:

- `dispatch-paused-extended` may be represented as an update to one stored state rather than a separately persisted enum, but the extension transition must still be explicit in tests and helper names.
- Active runs already in progress may continue; the pause applies to new dispatch decisions.

### Per-Issue Failure/Retry States

1. `attempt-failed`
   - a run attempt ended in a classified failure
2. `retry-queued`
   - the issue is queued for a future retry with an explicit retry class
3. `retry-held-by-pressure`
   - the issue retry is due or nearly due, but factory dispatch is still paused by provider pressure
4. `retry-released`
   - the issue is eligible to re-enter dispatch
5. `terminal-failed`
   - retry budget exhausted or the failure is non-retryable
6. `cleared`
   - the issue completed or moved to a terminal non-retry path

Allowed transitions:

- `attempt-failed -> retry-queued`
- `retry-queued -> retry-held-by-pressure`
- `retry-queued -> retry-released`
- `retry-held-by-pressure -> retry-released`
- `attempt-failed -> terminal-failed`
- `retry-queued -> cleared`
- `retry-released -> cleared`

Decision notes:

- `retry-held-by-pressure` may be a derived orchestration state from `dueAt <= now` plus an active dispatch pause, but it must be explicit in the policy helpers and tests.
- This slice should keep one retry queue owner. Do not create a second parallel queue just for provider-pressure deferrals unless the current queue contract proves insufficient.

## Failure-Class Matrix

| Observed condition                                                                            | Local facts available                                             | Normalized tracker facts available             | Expected decision                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner exits non-zero with generic failure output                                             | exit code, stderr/stdout, no provider-pressure hint               | issue still active; no merged terminal handoff | queue retry with ordinary transient class; do not pause broader dispatch                                                                                 |
| Runner/update path reports provider rate-limit with reset hint                                | normalized rate-limit class, optional reset time, current attempt | issue still active; no merged terminal handoff | queue retry with rate-limit class and pause new dispatch until `max(resetAt, now + backoffMs)`                                                           |
| Runner/update path reports provider/account access pressure without a precise reset           | normalized account-pressure class, current attempt                | issue still active; no merged terminal handoff | queue retry with account-pressure class and pause dispatch until `now + backoffMs` while surfacing the degraded reason clearly                           |
| Provider-pressure signal arrives while another dispatch pause is already active               | current `resumeAt`, new class, new optional reset                 | none required                                  | extend/replace the pause window using the clearer or later signal; do not thrash pause state                                                             |
| Retry becomes due while dispatch is still paused                                              | queued retry entry with `dueAt <= now`, active pause state        | tracker still returns the issue as eligible    | hold release; do not start new work until the pressure pause clears                                                                                      |
| Pause window expires and eligible retries/ready issues exist                                  | current time >= `resumeAt`                                        | tracker still returns eligible work            | release dispatch pause and resume normal queue selection on the next poll/runOnce                                                                        |
| Post-failure reconciliation shows merged terminal handoff after a pressure-classified failure | failure facts, issue retry candidate                              | refreshed lifecycle is `handoff-ready`         | suppress retry and clear any queued/paused state just as the merged-terminal path already does                                                           |
| Retry budget is exhausted for a pressure or ordinary transient class                          | current attempt count, retry class                                | issue still active; no merged terminal handoff | mark issue failed terminally, clear queue/pressure state for that issue, and keep factory pause only if another independent pressure state still applies |

## Storage / Persistence Contract

- keep transient-failure classification outcomes and dispatch-pressure state in memory for this issue
- keep the retry queue as the per-issue source of truth for scheduled re-entry
- keep dispatch-pressure posture as a coordination-owned runtime structure rather than encoding it indirectly in status-only fields
- status snapshot remains the operator-visible projection, not the source of truth
- do not add restart-durable pause persistence in this slice

Decision note:

- Restart durability is intentionally deferred because combining provider-pressure policy with restart reconciliation would broaden the PR past one reviewable seam.

## Observability Requirements

- status snapshot should expose whether dispatch is open or paused and, when paused, the normalized pressure class and resume timing
- retry projection should continue to expose queued retries, but with classes that distinguish ordinary run failure from provider-pressure retries
- TUI should make it obvious when the factory is paused globally versus merely waiting on one issue retry
- structured logs should name:
  - transient-failure classification
  - dispatch pause activation/extension/release
  - retry scheduling/exhaustion under the classified policy

## Implementation Steps

1. Introduce a small normalized transient-failure classification seam near the runner/update boundary and domain/orchestrator types as needed.
2. Add a focused dispatch-pressure runtime-state module under `src/orchestrator/`.
3. Update retry-state/domain types to represent the new retry classes and any extra metadata needed for observability.
4. Update `src/orchestrator/service.ts` to:
   - classify runner failures through the new policy seam
   - activate/extend/clear dispatch pause state
   - hold new dispatch while paused
   - schedule retries with the correct class and timing
5. Update status/TUI projection code to expose dispatch-pressure posture and the clearer retry classes.
6. Add or update tests across unit, integration, and end-to-end harnesses.

## Tests And Acceptance Scenarios

### Unit

- transient-failure classification tests for generic run failure, rate-limit pressure, and account-pressure signals
- dispatch-pressure state tests for activate, extend, expire, and clear transitions
- orchestrator policy tests proving due retries are held while dispatch pressure is active
- status/TUI tests proving paused-dispatch posture and retry-class projection render stably

### Integration

- GitHub bootstrap integration test covering a pressure-classified failure that pauses dispatch, records retry intent, then resumes after the pause window
- integration coverage for generic transient failure proving it queues a retry without pausing unrelated dispatch

### End-To-End

- bootstrap e2e scenario where a runner emits a rate-limit-like failure, Symphony pauses dispatch, then retries successfully after the pause/backoff window
- bootstrap e2e scenario where an ordinary transient failure retries without putting the whole factory into paused posture
- bootstrap e2e scenario where a merged terminal reconciliation suppresses retry and clears paused/queued posture after a classified transient failure

## Acceptance Scenarios

1. A provider-pressure failure causes Symphony to queue a retry and visibly pause new dispatch until a resume time.
2. While paused, eligible ready/running tracker items are not dispatched early even if retry backoff has elapsed.
3. When the pause window clears, the queued retry re-enters dispatch with the correct next attempt number and retry class.
4. An ordinary transient runner failure still retries, but does not pause unrelated work.
5. If retries exhaust, Symphony marks the issue failed terminally and does not leave stale queued or paused posture behind.
6. If post-failure reconciliation shows merged terminal state, Symphony suppresses retry and clears the transient-failure posture cleanly.

## Exit Criteria

- transient failure classification is explicit in code and tests
- provider-pressure pause state is explicit in coordination state rather than implied
- `src/orchestrator/service.ts` no longer treats all non-zero runner exits as the same retry policy path
- status/TUI explain whether Symphony is paused globally or merely retrying one issue
- tests cover classification, pause/hold/release behavior, merged-terminal suppression, and exhaustion
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- durable pressure/retry persistence across restarts
- per-class configurable backoff/jitter/budgets
- richer operator controls for clearing or overriding pressure posture
- broader provider coverage beyond the normalized signals already available to the current runtime

## Revision Log

- 2026-03-17: Initial plan created for issue `#168`.
