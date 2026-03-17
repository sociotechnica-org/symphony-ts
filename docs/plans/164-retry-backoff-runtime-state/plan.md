# Issue 164 Plan: Retry/Backoff Runtime State And Retry Queue Projection

## Status

- plan-ready

## Goal

Make retry and backoff a first-class coordination seam instead of a loose `Map<number, RetryState>` plus follow-up counters inside the orchestrator. The runtime should own an explicit retry queue contract with named state transitions, failure classification, due-time handling, exhaustion decisions, and operator-visible projection so retry posture is predictable and inspectable during Phase 6 follow-up work.

This issue is the narrow follow-up seam after `#8`, `#13`, `#19`, `#99`, `#129`, and `#163`: retry scheduling already exists, but queue ownership, retry classification, and queue projection are still too implicit.

## Scope

- define an explicit coordination-owned retry/backoff runtime-state model
- separate retry queue ownership from follow-up/run-sequence bookkeeping
- encode named retry decisions for schedule, hold, release, consume, exhaust, and clear
- make retry entries carry enough normalized data for operator-visible queue posture
- replace ad hoc retry `Map` manipulation in the orchestrator with a focused retry-state module
- preserve the current tracker/runtime behavior for:
  - failure-triggered retry scheduling
  - backoff delay calculation from existing config
  - merged-terminal retry suppression
- project retry queue posture consistently through status snapshot and TUI-oriented snapshot paths
- add unit, integration, and end-to-end tests for retry queue ownership, due-time behavior, exhaustion, and visibility

## Non-Goals

- changing tracker transport or normalization contracts
- redesigning review/follow-up detection semantics
- introducing durable retry persistence across process restarts
- changing retry policy knobs in `WORKFLOW.md`
- redesigning continuation-turn budgeting or watchdog recovery
- changing landing behavior beyond consuming the clearer retry state when a run fails
- broad TUI redesign beyond consuming the richer retry queue projection

## Current Gaps

- `src/orchestrator/service.ts` owns retry queue reads, writes, deletion, and merge behavior inline across several distant branches
- `src/orchestrator/follow-up-state.ts` mixes run-sequence bookkeeping with failure-retry bookkeeping even though they model different concepts
- `src/domain/retry.ts` defines only `issue`, `nextAttempt`, `dueAt`, and `lastError`, so queue entries do not explicitly classify why a retry exists or what state they are in
- queue ownership is implicit: the orchestrator mutates `this.#state.retries` directly instead of calling a named runtime-state seam
- status projection exposes only a thin retry list, which is enough for a count and countdown but not explicit queue posture
- tests prove backoff delay behavior, but they do not treat retry queue transitions and exhaustion as a first-class state model

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in `docs/architecture.md`.

### Policy Layer

Belongs here:

- the repo-owned rule that retry/backoff should be explicit and inspectable
- the classification of retryable run failures versus exhausted failures
- the operator-visible requirement that queued retries show their current posture and due timing

Does not belong here:

- `Map` mutation details
- tracker API requests
- TUI formatting choices

### Configuration Layer

Belongs here:

- reuse the existing retry policy inputs already resolved from workflow config:
  - `polling.retry.maxAttempts`
  - `polling.retry.backoffMs`

Does not belong here:

- encoded retry queue state
- tracker-provider conditionals
- new knobs unless implementation exposes a concrete missing policy boundary

### Coordination Layer

Belongs here:

- retry queue ownership and state transitions
- decisions for schedule, hold, release, consume, clear, and exhaust
- separation between run sequence, follow-up budget, and failure retry queue state
- merge of due retries with ready/running tracker candidates

Does not belong here:

- tracker payload parsing
- runner spawn/termination mechanics
- TUI rendering strings

### Execution Layer

Belongs here:

- existing runner exit/failure facts that coordination consumes
- existing workspace/run attempt inputs used when retrying a run

Does not belong here:

- retry classification policy
- due-time queue ownership

### Integration Layer

Belongs here:

- existing tracker calls such as `recordRetry`, `failIssue`, and lifecycle refresh used by coordination decisions
- normalized handoff facts used to suppress retry after merged terminal reconciliation

Does not belong here:

- retry queue storage
- retry scheduling algorithm
- operator queue posture derivation

### Observability Layer

Belongs here:

- status snapshot projection for retry queue posture
- TUI snapshot projection of retry entries sorted by due time
- structured log fields for retry schedule, release, and exhaustion decisions

Does not belong here:

- acting as the source of truth for retry policy
- inferring retry ownership by bypassing coordination state

## Architecture Boundaries

### `src/orchestrator/retry-state.ts` or equivalent focused module

Owns:

- retry queue data model
- transition helpers for queue mutation
- due-entry collection and queue projection helpers

Does not own:

- tracker writes
- runner control
- prompt attempt rendering

### `src/orchestrator/follow-up-state.ts`

Owns:

- run-sequence bookkeeping driven by lifecycle observations
- failure retry attempt counters only if they remain the smallest non-duplicative home after retry-state extraction

Does not own:

- retry queue entry storage
- due-time calculations
- retry observability projection

Decision note:

- If keeping failure-retry counters in `follow-up-state.ts` still couples two distinct seams, move them into the retry-state module so follow-up state becomes sequence-only.

### `src/orchestrator/service.ts`

Owns:

- orchestration flow and side-effect sequencing
- calling the retry-state seam instead of mutating queue maps inline
- consuming retry decisions when merging tracker candidates and handling failures

Does not own:

- inline queue-state algorithms spread across distant branches
- retry snapshot shaping

### `src/observability/`

Owns:

- status/TUI projection shapes for queued retries
- parsing/rendering of any new retry snapshot fields

Does not own:

- retry scheduling policy
- queue mutation rules

## Slice Strategy And PR Seam

This issue should land as one coordination-and-observability PR:

1. extract an explicit retry-state seam with named transitions
2. migrate the orchestrator to consume that seam
3. widen retry projection just enough to expose queue posture cleanly in status/TUI
4. add focused tests for the new runtime-state contract

Deferred from this PR:

- restart-time durable retry recovery
- retry persistence across worker restarts
- policy changes to max retry attempts or backoff calculation
- any tracker transport/normalization refactor
- broader watchdog or continuation-loop redesign

Why this seam is reviewable:

- it stays centered on one runtime concept: retry/backoff state ownership
- it avoids mixing tracker boundary changes with coordination refactoring
- it closes the inspectability gap without requiring a larger restart-persistence design in the same patch

## Runtime State Machine

This issue changes long-running orchestration behavior, so the retry/backoff state model must be explicit.

### Per-Issue Retry Queue States

1. `idle`
   - no queued failure retry exists for the issue
2. `scheduled`
   - a retryable failure was classified and the next attempt has a due time in the future
3. `due`
   - the queued retry is eligible to re-enter dispatch on the current poll
4. `consumed`
   - the due retry was released into dispatch and is no longer owned by the queue
5. `cleared`
   - retry state was intentionally removed because the issue completed, failed terminally, or moved to a non-retry path
6. `exhausted`
   - the run failed, retry budget is exhausted, and coordination must terminally fail rather than queue again

Allowed transitions:

- `idle -> scheduled`
- `scheduled -> due`
- `due -> consumed`
- `scheduled -> cleared`
- `due -> cleared`
- `idle -> exhausted`
- `scheduled -> exhausted`
- `consumed -> scheduled`
- `consumed -> cleared`

Decision notes:

- `due` may be represented as a derived state from `dueAt <= now` rather than persisted separately, but the transition must still be explicit in tests and helper names.
- `consumed` is an orchestration-observable transition, not a durable queue state. It exists so the queue module owns release semantics instead of making `service.ts` delete map entries opportunistically.

### Queue Ownership Rules

- only the retry-state module mutates queued retry entries
- scheduling a retry must atomically:
  - compute the next run attempt
  - compute the next failure retry attempt
  - stamp the due time
  - retain the failure classification summary for observability
- releasing due retries must atomically remove them from queue ownership and return normalized dispatch inputs
- clearing an issue must remove both queued retry ownership and any retry-attempt bookkeeping that should not survive a terminal outcome

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Run fails and retry attempt is still below `maxAttempts` | run sequence, current retry attempt, failure message | issue still active; no merged terminal handoff | schedule retry with `dueAt = now + backoffMs`; project queued posture |
| Run fails and retry attempt reaches `maxAttempts` | run sequence, current retry attempt, failure message | issue still active; no merged terminal handoff | mark retry `exhausted`; do not queue; fail issue terminally |
| Run fails but post-failure lifecycle refresh shows merged terminal handoff | run failure facts | refreshed lifecycle is `handoff-ready` | suppress retry/failure queueing and complete terminally |
| Issue already has a scheduled retry and a normal poll sees the tracker item again before due time | queued retry entry with future `dueAt` | ready/running candidate from tracker | hold queued retry; do not dispatch early |
| Scheduled retry reaches its due time on a poll | queued retry entry with `dueAt <= now` | tracker still returns the issue as eligible running/ready work | release retry into dispatch with preserved next attempt number |
| Retrying issue completes or reaches a non-retry terminal path | queued retry entry may still exist | lifecycle becomes handoff-ready or issue is failed terminally | clear retry ownership and counters |
| Operator inspects status/TUI while retries are pending | queue entries with due times and summaries | none required beyond normalized issue identity | show retry queue posture sorted by due time, including next attempt and summarized reason |

## Storage / Persistence Contract

- keep retry/backoff state in memory for this issue
- keep the retry queue as a coordination-owned runtime structure rather than a loose map stored directly on `OrchestratorState`
- status snapshot remains the operator-visible projection, not the source of truth
- do not add restart-durable retry persistence in this slice

Decision note:

- restart durability is intentionally deferred because combining queue persistence, reconciliation, and observability would widen this PR beyond one reviewable seam.

## Observability Requirements

- status snapshot should continue to expose queued retries, but through a projection derived from the explicit retry-state seam
- projection should make queue posture inspectable enough to answer:
  - which issues are queued
  - what next attempt will run
  - when each retry becomes due
  - why the issue is queued
- TUI snapshot should continue sorting retries by soonest due time and render the same queue semantics from the normalized projection
- structured logs should name retry schedule, retry release, retry clear, and retry exhaustion decisions with issue identifier and attempt context

## Implementation Steps

1. Introduce a focused retry runtime-state module under `src/orchestrator/` and reshape `src/domain/retry.ts` if needed to support explicit queue entries and projection.
2. Move queue mutation and due-entry collection out of `src/orchestrator/service.ts` into named retry-state helpers.
3. Narrow `src/orchestrator/follow-up-state.ts` so run sequence and retry queue ownership are no longer blurred.
4. Update the orchestrator to:
   - schedule retries via the retry-state seam
   - merge due retries with tracker candidates via the retry-state seam
   - clear retry state on completion/failure suppression/terminal failure
5. Update status and TUI projection code to consume the normalized retry queue projection rather than raw `Map` contents.
6. Add or update targeted tests across unit, integration, and e2e harnesses.

## Tests And Acceptance Scenarios

### Unit

- retry-state transition tests for schedule, due, release, clear, and exhaust
- follow-up-state tests proving run sequence remains separate from retry queue state
- status snapshot tests proving retry queue projection remains sorted and complete
- TUI tests proving queued retries still render in due-time order with stable wording

### Integration

- GitHub bootstrap integration test covering a failed attempt that schedules a retry, holds before due, and re-enters dispatch when due
- integration coverage for exhausted retries reaching terminal failure without leaving stale queue state

### End-To-End

- bootstrap e2e scenario where an issue fails once, appears in queued retry posture, then reruns after backoff and completes
- bootstrap e2e scenario where retries exhaust and the issue is marked failed without stale queued-retry projection
- bootstrap e2e scenario where a merged terminal reconciliation suppresses retry scheduling after a failing attempt

## Acceptance Scenarios

1. A run fails, the runtime schedules a retry, and operator-visible status shows the issue in the retry queue with a due time and next attempt number.
2. The same issue is visible in tracker polling before the backoff expires, but the orchestrator does not dispatch it early.
3. Once the due time passes, the retry queue releases the issue back into dispatch with the correct attempt number.
4. If the retry budget is exhausted, the runtime fails the issue terminally and removes it from queued retry projection.
5. If post-failure reconciliation shows a merged terminal state, retry scheduling is suppressed and the queue remains clean.

## Exit Criteria

- retry/backoff ownership lives behind an explicit runtime-state seam
- `src/orchestrator/service.ts` no longer mutates retry queue state ad hoc in multiple places
- status/TUI consume a normalized retry queue projection
- tests cover queue transitions, due-time behavior, exhaustion, and visible posture
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- durable retry persistence and restart-time retry reconciliation
- policy-level retry classification beyond the current failure path
- richer operator controls over queued retries
- any config expansion for retry jitter, per-class backoff, or manual requeue controls

## Revision Log

- 2026-03-16: Initial draft created for issue `#164`.
