# Issue 164 Plan: Retry/Backoff Runtime State And Retry Queue Projection

## Status

- plan-ready

## Goal

Make retry and backoff a first-class coordination-owned runtime seam with explicit queue ownership, retry classification, due-time/exhaustion rules, and operator-visible projection instead of a loose `retries` map plus ad hoc branching.

This issue is the implementation slice for the Phase 6 follow-up seam named in `docs/plans/013-production-hardening-recovery-architecture/plan.md`. `SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping from `docs/architecture.md`.

## Scope

- replace the current loose retry queue contract (`Map<number, RetryState>`) with a named runtime-state module that owns retry scheduling, dequeueing, exhaustion, and cleanup
- distinguish retryable failure classes explicitly instead of collapsing all retry scheduling into one generic message path
- make due times and backoff posture explicit in the runtime-state contract rather than implicit in scattered `Date.now() + backoffMs` calculations
- project retry queue posture through the status snapshot and TUI snapshot with enough detail for operators to tell what is queued, why, and when it will run
- keep retry state clearly separate from run sequencing, tracker-driven rework, landing state, and watchdog ownership state
- update tests, docs, and issue artifacts/status expectations to match the new retry seam

## Non-goals

- redesigning tracker transport, normalization, or lifecycle policy
- changing the runner continuation-turn contract or workspace lifecycle semantics
- persisting retry queue state across process restarts in this slice
- redesigning watchdog policy, graceful shutdown policy, or landing policy beyond the compatibility changes needed to classify retries correctly
- broad report/archive schema work unrelated to retry queue visibility
- expanding this PR into a general observability overhaul

## Current Gaps

- `src/orchestrator/state.ts` stores retries as a loose `Map<number, RetryState>` while follow-up/run sequencing lives in a separate helper, so retry ownership is split across unrelated modules
- `src/domain/retry.ts` only records `nextAttempt`, `dueAt`, and `lastError`, so the queue does not encode retry class, exhaustion facts, or the backoff inputs that produced the due time
- `src/orchestrator/service.ts` schedules retries inline from several failure paths, which makes queue cleanup and operator-visible semantics dependent on call-site discipline
- `src/orchestrator/follow-up-state.ts` still owns failure retry attempt counters even though issue `#57` deliberately separated tracker-driven rework from abnormal-failure retries
- `src/observability/status.ts` and the TUI snapshot only expose `nextAttempt`, `dueAt`, and `lastError`, which is not enough to tell whether the queue contains a runner failure, watchdog recovery failure, missing-target retry, or another retryable class
- existing tests cover retry presence and suppression, but they do not treat retry classification and queue projection as a stable coordination contract

## Decision Notes

- This slice should stay inside coordination-owned retry state plus observability projection. It should not expand into tracker mapping or restart durability work, because those are separable Phase 6 seams with their own review surfaces.
- Retry classification should be normalized at the coordination boundary. The orchestrator may derive classes from known failure conditions, but trackers and status surfaces should consume the normalized class instead of reverse-engineering messages.
- Run sequencing remains separate from retry queue state. The retry queue may carry the next run sequence it will launch, but it should not own continuation/rework policy.
- Backoff remains configuration-driven through the existing retry config. This issue hardens runtime state and visibility; it does not introduce new retry knobs unless implementation uncovers a missing contract needed to keep the queue coherent.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining which abnormal failures are retryable, what exhaustion means, and what retry posture operators must be able to see
  - does not belong: tracker payload parsing, runner subprocess details, or TUI-only wording
- Configuration Layer
  - belongs: the existing `polling.retry` inputs that bound retry attempts/backoff
  - does not belong: live queue entries, retry counters, or per-issue due times
- Coordination Layer
  - belongs: queue ownership, retry classification, due-time calculation, dequeue rules, exhaustion checks, and cleanup when terminal outcomes supersede queued retries
  - does not belong: tracker transport logic or presentation formatting
- Execution Layer
  - belongs: unchanged runner/workspace execution when the coordinator dequeues a retry and launches another run
  - does not belong: deciding retry class or backoff posture
- Integration Layer
  - belongs: no new behavior in this slice beyond continuing to surface the normalized lifecycle facts the coordinator already uses
  - does not belong: retry queues, backoff calculations, or exhaustion logic
- Observability Layer
  - belongs: projecting retry queue entries, classification, due times, and exhaustion posture derived from coordination state
  - does not belong: re-deriving retry classes from raw tracker or runner text

## Architecture Boundaries

### Belongs in this issue

- `src/domain/retry.ts`
  - expand the retry entry contract to carry explicit class/queue metadata
- `src/orchestrator/follow-up-state.ts` or successor module(s)
  - remove failure-retry ownership from the follow-up helper
- `src/orchestrator/state.ts`
  - replace the loose retry map with a named retry runtime-state module
- `src/orchestrator/service.ts`
  - route retry scheduling/dequeue/cleanup through the new retry-state seam
- `src/orchestrator/status-state.ts`, `src/observability/status.ts`, and TUI snapshot types in `src/orchestrator/service.ts`
  - publish retry classification and queue posture
- retry-focused unit and orchestration/e2e tests
  - assert queue ownership, due-time behavior, exhaustion, and operator-visible projection

### Does not belong in this issue

- tracker transport or normalization refactors
- restart-persistence of retry entries across process restarts
- watchdog algorithm redesign beyond retry classification inputs
- landing-state redesign
- broad artifact/report schema redesign not required by the retry projection contract

## Layering Notes

- `config/workflow`
  - continues to own retry/backoff inputs
  - does not own live retry queue state
- `tracker`
  - continues to expose normalized issue and handoff facts
  - does not own retry queue semantics or queue cleanup
- `workspace`
  - continues to prepare/reuse workspaces for dispatched runs
  - does not infer retry class or due time
- `runner`
  - continues to report execution outcomes and liveness facts
  - does not schedule retries or classify queue entries
- `orchestrator`
  - owns the retry queue state machine and transitions
  - does not parse tracker-specific payloads to recover retry meaning
- `observability`
  - reflects normalized retry queue state
  - does not become a second source of truth for retry posture

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam limited to:

1. one explicit retry runtime-state contract
2. the orchestrator call-site refactor needed to route retry scheduling/dequeueing through that contract
3. the minimum status/TUI/artifact projection changes needed to make the new queue visible
4. focused tests proving the contract

This remains reviewable because it does not combine:

- tracker lifecycle refactors
- restart durability work
- shutdown/watchdog redesign
- runner transport changes

If implementation shows that restart persistence is required to keep the queue coherent, stop and split that into a follow-up issue instead of broadening this PR silently.

## Runtime State Model

### Retry queue ownership

Introduce one coordination-owned retry runtime-state module responsible for:

- creating retry entries
- recording the retry class and scheduling inputs
- determining whether a queued entry is due
- dequeuing due entries into poll candidates
- clearing superseded entries when completion, failure, merge, or other terminal outcomes win
- exposing a stable read model for status/TUI projection

### Retry entry shape

Each retry entry should converge on a stable shape that extends the current `RetryState`:

- `issue`
- `runSequence`
- `failureRetryAttempt`
- `nextRunSequence`
- `retryClass`
  - `runner-failure`
  - `watchdog-abort`
  - `shutdown-interrupted`
  - `missing-target`
  - `unexpected-orchestrator-failure`
- `scheduledAt`
- `backoffMs`
- `dueAt`
- `lastError`

If implementation discovers that two of these classes are indistinguishable with current local facts, keep the enum smaller rather than faking precision.

### Retry state machine

Per issue, retry state should move through these coordination states:

- `none`
  - no queued retry exists
- `scheduled`
  - retry entry exists and `dueAt > now`
- `due`
  - retry entry exists and `dueAt <= now`
- `dequeued`
  - poll loop has claimed the entry for dispatch and removed it from the queue
- `cleared`
  - entry was removed because the issue completed, failed terminally, or another superseding terminal outcome won
- `exhausted`
  - the latest retryable failure consumed the last configured attempt and transitions to terminal failure instead of re-entering the queue

`exhausted` is a decision outcome, not a persistent queued entry.

### Allowed transitions

- run attempt fails with retryable class and remaining budget -> `none|cleared -> scheduled`
- scheduled entry reaches due time during poll -> `scheduled -> due -> dequeued`
- dequeued retry is dispatched -> queue remains `none` until the run either succeeds, waits, or schedules another retry
- retryable failure after a prior retry -> `dequeued|none -> scheduled` with incremented `failureRetryAttempt`
- retryable failure with no remaining budget -> `dequeued|none -> exhausted`
- merged/completed/terminal-failed observation while entry is queued -> `scheduled|due -> cleared`
- explicit runtime cleanup on issue success/failure -> `scheduled|due -> cleared`

### Runtime decision rules

- only abnormal failure paths schedule retry entries
- tracker-driven `rework-required` remains active work and never enters the retry queue
- queue due-time computation must happen in one retry-state helper, not inline call sites
- exhaustion is decided from `failureRetryAttempt` against `polling.retry.maxAttempts`
- status/TUI projection must derive from retry entries directly, not from parsing `lastError`

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Runner exits non-zero during implementation or rework | runner result, run sequence, current retry attempt | lifecycle may still be active | schedule `runner-failure` retry if budget remains; otherwise fail terminally |
| Watchdog aborts a stalled run | watchdog abort reason, run sequence, current retry attempt | lifecycle still active or unknown | schedule `watchdog-abort` retry if budget remains; otherwise fail terminally |
| Shutdown interrupts an active run before normal completion | shutdown state, run session, run sequence | tracker still shows running issue | classify as `shutdown-interrupted`; retry only if current shutdown policy treats it as retryable |
| Successful run ends with `missing-target` | successful run artifacts, branch exists | lifecycle is `missing-target` | schedule `missing-target` retry if budget remains; otherwise fail terminally |
| Unexpected orchestrator exception escapes issue processing | error, issue number, run sequence | tracker facts may be stale | schedule `unexpected-orchestrator-failure` retry if budget remains; otherwise fail terminally |
| Issue/PR is merged or completed before queued retry is due | queued retry entry, refreshed lifecycle | lifecycle is `handoff-ready` | clear queued retry and complete issue; do not retry |
| Issue has queued retry but tracker shows terminal failure from another path | queued retry entry, refresh result | future terminal classification or failed label state | clear queued retry and preserve terminal outcome |

## Storage / Persistence Contract

- the retry queue remains in-memory in this slice
- the authoritative coordination contract is the retry runtime-state module, not ad hoc status rows or artifact fields
- status snapshots, TUI snapshots, and issue artifacts remain derived views over the queue
- if retry persistence across restart becomes necessary, it must land as a named follow-up seam rather than incidental JSON hidden inside observability files

## Observability Requirements

- status snapshots should expose retry entries with class, next run sequence/attempt, due time, and last error summary
- the TUI retry section should show enough information to tell why an item is queued, not just that it is queued
- issue artifacts should record retry scheduling with the normalized retry class so later reports do not have to infer meaning from free-form text
- logs should identify retry class and exhaustion decisions explicitly

## Implementation Steps

1. Define the expanded retry entry and retry-class vocabulary in `src/domain/retry.ts`.
2. Extract a focused retry runtime-state helper in `src/orchestrator/` that owns scheduling, due-time checks, dequeueing, cleanup, and exhaustion decisions.
3. Remove failure retry attempt ownership from `src/orchestrator/follow-up-state.ts`, leaving it responsible only for non-retry continuation/run-sequence facts if still needed.
4. Update `src/orchestrator/state.ts` and `src/orchestrator/service.ts` to use the retry runtime-state helper for:
   - scheduling retries
   - collecting due retries
   - clearing stale/superseded entries
   - deciding exhaustion
5. Update status/TUI/artifact projection to surface retry class and queue posture without re-deriving it from free-form summaries.
6. Add or update unit tests for the retry runtime-state helper and orchestrator decisions.
7. Add focused integration/e2e coverage for operator-visible retry queue projection and stale-entry cleanup.
8. Run formatting, lint, typecheck, unit/integration/e2e tests, and a local self-review pass if a reliable review tool is available.

## Tests And Acceptance Scenarios

### Unit

- retry-state helper schedules entries with explicit class, backoff, and due time
- retry-state helper returns due entries only when `dueAt <= now`
- retry-state helper clears queued entries cleanly on completion/terminal failure
- exhaustion decisions are based on explicit retry attempts, not on run sequence
- follow-up state no longer owns failure retry counters

### Orchestrator / integration

- runner failure schedules a `runner-failure` retry entry and status snapshot projects the class and due time
- watchdog-triggered retry is projected distinctly from a generic runner failure
- merged/completed reconciliation clears a queued retry entry before it can be dispatched
- `rework-required` reruns do not create retry queue entries

### End-to-end

- a failing run schedules a visible retry entry, the status snapshot/TUI read model shows the retry class and due time, and the next poll dispatches it when due
- a retryable `missing-target` path shows up as queued retry posture instead of being indistinguishable from other failures
- a merged PR suppresses or clears stale queued retry state so operators do not see phantom retries after completion

## Acceptance Scenarios

1. Given a runner failure with retry budget remaining, when Symphony schedules a retry, then the runtime queue records a classified entry with `scheduledAt`, `backoffMs`, `dueAt`, and the next run sequence, and the status surface exposes that entry directly.
2. Given a queued retry whose due time has not arrived, when the poll loop runs, then the issue is not dispatched early and the queue entry remains visible as scheduled.
3. Given a queued retry whose due time has arrived, when the poll loop runs, then the entry is dequeued once and the retry run is launched with the recorded next sequence/attempt.
4. Given a retryable failure on the last allowed attempt, when failure handling runs, then Symphony records exhaustion and fails terminally instead of creating another queue entry.
5. Given tracker-driven rework after a successful run, when the issue is resumed, then Symphony reruns the work without adding a retry queue entry.
6. Given a queued retry for an issue that merges before the due time, when the tracker is refreshed, then Symphony clears the queued entry and leaves no stale retry posture in status output.

## Exit Criteria

- retry scheduling, dequeueing, cleanup, and exhaustion are owned by one explicit retry runtime-state seam
- retry queue entries have explicit normalized classification and due-time metadata
- status/TUI/artifact surfaces project retry posture from that normalized queue state
- rework/follow-up state stays separate from abnormal-failure retry state
- relevant unit, integration, and e2e tests pass

## Deferred To Later Issues Or PRs

- durable retry queue persistence across restart
- retry policy changes such as exponential backoff, jitter, or per-class retry budgets
- broader Phase 6 recovery-surface redesign across shutdown, restart, cleanup, and reporting
- rate-limit-specific retry classes or tracker-provider-specific retry policy
