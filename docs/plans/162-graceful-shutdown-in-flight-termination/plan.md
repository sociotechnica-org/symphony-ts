# Issue 162 Plan: Graceful Shutdown and In-Flight Termination

## Status

- plan-ready

## Goal

Add a first-class coordination-owned shutdown path for active local runs so an intentional operator stop or restart is recorded and surfaced as intentional shutdown, not flattened into a generic runner failure or crash-recovery side effect.

This slice should preserve restart-recoverable local facts, drive bounded runner termination through the execution seam, and make the shutdown posture inspectable through status and logs.

## Scope

- define an explicit shutdown transition for locally owned active runs
- extend local run ownership records so intentional shutdown leaves a recoverable posture instead of only a stale lease
- let the orchestrator request bounded graceful termination of in-flight runner work before escalated kill/cleanup
- keep tracker state recoverable while the factory is stopping, instead of immediately classifying shutdown as a normal failed attempt
- surface shutdown posture distinctly in status snapshots, issue artifacts, and logs
- cover coordinated stop, restart-time recovery, and shutdown-specific observability in unit and end-to-end tests

## Non-goals

- redesigning the full retry queue, continuation loop, or watchdog model
- changing tracker lifecycle semantics beyond the minimum needed to preserve recoverable `running` state
- adding remote-runner or hosted control-plane shutdown support
- introducing durable config-driven shutdown policy beyond a minimal local grace timeout if the execution seam requires it
- changing workspace retention behavior except where shutdown correctness depends on preserving local facts

## Current Gaps

- the orchestrator forwards an abort signal into active runner turns, but it does not record a named shutdown state for the run it is interrupting
- shutdown-triggered runner interruption is normalized close to generic failure handling, so status/comments can look like an ordinary failed attempt rather than an intentional stop
- active-run lease records track owner/runner PIDs, but they do not preserve whether the local owner stopped intentionally, is still draining, or already escalated to forced termination
- restart recovery can distinguish stale ownership from active ownership, but it cannot distinguish an intentional operator stop from a crash or dead-owner orphan
- operator-facing status shows runner visibility phases such as `shutdown`, but the coordination layer does not expose a durable shutdown posture that recovery and observability can reason about directly

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the layer mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: defining intentional shutdown as distinct from crash, watchdog failure, retryable run failure, and orphan repair
  - belongs: defining that local stop/restart leaves active work in a recoverable coordination posture instead of immediately consuming a retry/failure path
  - does not belong: tracker-specific transport details, runner-specific signal mechanics, or a global retry redesign
- Configuration Layer
  - belongs: at most a narrow typed shutdown grace timeout if current execution contracts need an explicit bound
  - does not belong: persisting runtime shutdown posture in workflow config or adding broader operator policy knobs in this slice
- Coordination Layer
  - belongs: owning the shutdown transition, recording shutdown posture for active runs, deciding when a run is draining, shutdown-interrupted, or force-terminated, and deciding how restart recovery interprets that posture
  - does not belong: low-level subprocess signaling details or tracker API quirks
- Execution Layer
  - belongs: exposing graceful-stop hooks and bounded termination behavior from runner/workspace seams
  - does not belong: deciding whether a stop is retryable, failed, or intentionally recoverable
- Integration Layer
  - belongs: minimal tracker interactions required to preserve recoverable `running` state and avoid accidental failure classification during stop
  - does not belong: encoding shutdown semantics inside tracker transport or normalization modules
- Observability Layer
  - belongs: publishing shutdown posture in status snapshots, logs, and issue artifacts distinctly from generic failure
  - does not belong: inventing separate control-plane policy or new tracker lifecycle rules

## Architecture Boundaries

### Coordination / orchestrator

Belongs here:

- explicit shutdown state transitions for active runs
- runtime decisions for graceful drain, forced termination, shutdown-complete, and restart recovery interpretation
- coordination-owned updates to local run ownership records

Does not belong here:

- runner-specific process spawning details
- tracker transport or normalization logic

### Execution / runner and workspace

Belongs here:

- a provider-neutral way to request graceful cancellation and learn whether the runner exited due to shutdown
- bounded escalation from graceful cancellation to forceful local termination when needed

Does not belong here:

- retry/failure lifecycle policy
- durable shutdown posture semantics beyond execution facts

### Integration / tracker

Belongs here:

- preserving the existing tracker `running` posture while the factory stops unless a more specific tracker transition is strictly required for correctness

Does not belong here:

- representing shutdown intent through tracker-specific ad hoc state
- mixing transport, normalization, and shutdown policy in one adapter module

### Observability

Belongs here:

- status/log fields and artifact observations that distinguish shutdown from failure and orphan recovery

Does not belong here:

- reconstructing shutdown policy from raw runner text

## Slice Strategy And PR Seam

This should stay one reviewable PR by keeping the seam inside the existing local supervision path introduced by issue `#19`:

1. extend the local active-run record/state model with explicit shutdown posture
2. teach the orchestrator to enter and complete that shutdown transition when its stop signal fires
3. route bounded graceful termination through the runner contract
4. expose the resulting posture in status/artifacts/restart recovery tests

Deferred from this PR:

- broader restart-recovery redesign beyond interpreting the new shutdown posture
- watchdog or continuation-budget refactors
- remote execution shutdown support
- tracker-facing lifecycle expansion beyond keeping `running` recoverable

Why this seam is reviewable:

- the durable state already lives in `src/orchestrator/issue-lease.ts`
- the long-running policy already lives in `src/orchestrator/service.ts`
- runner event/cancellation contracts already exist and can be extended without changing tracker adapter structure

## Runtime State Machine

Issue `#162` changes stateful orchestration behavior, so the shutdown path should be explicit.

### Active-run coordination states

1. `active`
   - lease exists, owner is alive, run is executing normally
2. `shutdown-requested`
   - orchestrator received a local stop signal and recorded intentional shutdown for the run
   - graceful cancellation/termination has been requested through the execution seam
3. `shutdown-draining`
   - runner/workspace is still exiting within the configured grace window
4. `shutdown-terminated`
   - runner exited because of shutdown and the run record is left in an intentional recoverable posture for restart reconciliation/operator inspection
5. `shutdown-forced`
   - graceful drain did not complete within the bound; the runtime escalated to forced local termination and recorded that fact
6. `recovered-after-shutdown`
   - a later startup/reconciliation pass consumed the shutdown record and resumed or reclassified the issue
7. `failed-orphan`
   - dead owner / dead runner with no intentional shutdown posture; existing orphan/crash recovery applies

### Allowed transitions

- `active -> shutdown-requested`
  - factory stop/restart signal reaches the orchestrator while the run is locally owned
- `shutdown-requested -> shutdown-draining`
  - graceful cancellation was forwarded successfully and the child is still alive
- `shutdown-requested -> shutdown-terminated`
  - runner exits promptly and reports/normalizes shutdown interruption
- `shutdown-draining -> shutdown-terminated`
  - runner exits within grace period
- `shutdown-draining -> shutdown-forced`
  - grace period expires and the runtime escalates to forced termination
- `shutdown-terminated -> recovered-after-shutdown`
  - next startup/reconciliation observes intentional shutdown posture and chooses the recoverable follow-up path
- `shutdown-forced -> recovered-after-shutdown`
  - next startup/reconciliation observes forced local termination caused by shutdown and chooses the recoverable follow-up path
- `active -> failed-orphan`
  - owner dies without intentional shutdown posture; existing stale-owner reconciliation remains in force

### State invariants

- only coordination code writes the durable shutdown posture
- tracker `running` may remain true while local posture is `shutdown-terminated` or `shutdown-forced`
- shutdown does not consume retry budget at stop time; retry/fail decisions happen during later recovery according to normalized facts

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Operator stops the factory while a runner turn is executing | owner PID alive, runner PID alive, run record `active` | issue is `running` | record `shutdown-requested`, send graceful cancel, move to `shutdown-draining` or `shutdown-terminated` based on exit timing |
| Runner exits after shutdown request within grace window | shutdown posture recorded, runner exit classified as shutdown-interrupted | issue remains `running` | persist `shutdown-terminated`, do not mark attempt failed, leave recoverable state for restart |
| Runner ignores graceful cancel and stays alive past grace window | shutdown posture recorded, runner PID still alive after deadline | issue remains `running` | escalate to forced termination, persist `shutdown-forced`, leave recoverable state for restart |
| Factory crashes before recording intentional shutdown | stale owner, maybe live or dead runner, no shutdown posture | issue remains `running` | treat as existing orphan/crash recovery, not intentional shutdown |
| Startup finds `shutdown-terminated` record with no live owner/runner | durable shutdown posture, no live processes | issue remains `running` and no merge-ready handoff | classify as recoverable intentional shutdown and requeue/reconcile without misreporting as crash |
| Startup finds `shutdown-forced` record with lingering live runner | durable forced-shutdown posture, runner PID still alive | issue remains `running` | terminate lingering child if needed, then proceed through intentional-shutdown recovery path |
| Startup finds generic stale-owner record from issue `#19` | no intentional shutdown posture | issue remains `running` | preserve existing orphan recovery behavior |
| Watchdog or normal runner failure happens without stop signal | no shutdown posture, failure/stall facts present | issue may be `running` or follow-up lifecycle | preserve existing failure/watchdog classification, do not recast as shutdown |

## Storage / Persistence Contract

- extend the existing local active-run record under `.symphony-locks/<issue>/run.json` instead of creating a second durability mechanism
- record a normalized shutdown posture section such as:
  - requested at
  - current shutdown state
  - graceful deadline / forced-termination timestamp when applicable
  - last shutdown-related reason summary
- keep the lease directory as the system of record for local active-run ownership and shutdown posture
- cleanup remains idempotent: recovery may clear the record once the intentional shutdown posture has been consumed

## Observability Requirements

- status snapshots must distinguish intentional shutdown from generic `failed`, `cancelled`, and orphan-recovery states
- issue artifact observations should include shutdown-requested / shutdown-terminated facts so operator reports can explain why a run stopped
- logs should name whether the runtime is draining gracefully, forcing termination, or recovering prior intentional shutdown state
- operator-visible output for detached stop/restart should make clear whether active runs were terminated cleanly or left in a recoverable forced-stop posture

## Implementation Steps

1. Extend the durable active-run lease record and inspection/reconciliation helpers in `src/orchestrator/issue-lease.ts` so they can persist and read intentional shutdown posture distinctly from stale-owner detection.
2. Add a small coordination-side shutdown state helper or module if `src/orchestrator/service.ts` would otherwise absorb too many inline state branches.
3. Update the orchestrator shutdown flow so a stop signal transitions each active run through `shutdown-requested` and records whether it drained gracefully or required forced termination.
4. Extend the runner contract in `src/runner/service.ts` and local runner implementations so shutdown interruption is surfaced distinctly from generic failure, while preserving existing spawn/visibility events.
5. Update restart reconciliation so a persisted shutdown posture follows an intentional-shutdown recovery path rather than the generic stale-owner/orphan path.
6. Project the new posture into status snapshots, logs, and issue artifacts without leaking policy into runner or tracker modules.
7. Add focused tests for shutdown state transitions, local termination behavior, restart recovery, and observability output.

## Tests And Acceptance Scenarios

### Unit

- shutdown signal transitions an active run from `active` to `shutdown-requested`
- a graceful runner exit after shutdown is classified as intentional shutdown, not normal failure
- a forced local termination after grace timeout is recorded as `shutdown-forced`
- restart reconciliation distinguishes intentional shutdown records from generic stale-owner records
- status snapshot mapping shows shutdown posture distinctly from failure/cancelled/watchdog states

### Integration

- local runner receives a coordinated stop request and exits through the shutdown path with the new runner contract
- existing lease persistence remains readable and cleanup stays idempotent when shutdown and reconciliation race

### End-to-end

- detached factory stop during an active run leaves the issue recoverable and operator-visible as intentional shutdown, not generic failure
- detached factory restart after intentional shutdown reconciles the prior shutdown posture and resumes/repairs the `running` issue cleanly
- watchdog-driven failure still reports as watchdog/failure rather than shutdown when no stop signal occurred

## Acceptance Scenarios

1. Operator runs `symphony factory stop` while a local issue is mid-run.
   - The orchestrator records intentional shutdown, attempts graceful termination, and leaves a recoverable local record.
2. The runner exits promptly after the stop request.
   - Status/artifacts show intentional shutdown rather than an ordinary failed attempt.
3. The runner does not exit within the shutdown grace window.
   - The runtime escalates to forced termination, records that posture, and still leaves restart-recoverable facts.
4. Symphony starts again after the intentional stop.
   - Recovery interprets the persisted shutdown posture distinctly from a crash/orphan and proceeds through the intended recoverable path.

## Exit Criteria

- active local runs have an explicit coordination-owned shutdown transition
- shutdown-interrupted runs are persisted with recoverable intentional-shutdown posture
- runner execution supports bounded graceful termination for local shutdown
- status/logs/artifacts distinguish intentional shutdown from crash, watchdog failure, and generic runner failure
- unit, integration, and end-to-end coverage prove the shutdown path and restart recovery seam
- local checks pass:
  - `pnpm format`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`

## Deferred

- remote-runner graceful shutdown support
- broader tracker-facing lifecycle semantics for paused/stopped work
- general retry/recovery refactors unrelated to intentional shutdown posture
- workspace cleanup/retention policy improvements not required for shutdown correctness

## Decision Notes

- The local lease/run record is the right storage seam because issue `#19` already made it the durable source of truth for active-run ownership. Adding shutdown posture there avoids a second coordination state store.
- The tracker should remain minimally involved in this slice. The meaningful distinction here is local intentional shutdown versus crash/failure, and that distinction belongs in orchestration state, not tracker transport.
- If the shutdown path adds several counters or booleans in `BootstrapOrchestrator`, extract a named shutdown-state helper rather than extending ad hoc maps in `state.ts`.
