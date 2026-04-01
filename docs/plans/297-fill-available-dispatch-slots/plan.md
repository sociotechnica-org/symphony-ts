# Issue 297 Plan: Fill Available Dispatch Slots While Another Runner Turn Is Active

## Status

- plan-ready

## Goal

Let the factory keep polling and dispatching additional ready work up to `polling.max_concurrent_runs` even while another locally started runner turn is still active.

The intended outcome of this slice is:

1. one live active run consumes only one local dispatch slot
2. the poll loop continues on schedule while background runs remain active
3. a free slot is filled by the next eligible ready issue instead of waiting for the active run to finish
4. slot accounting stays explicit and inspectable instead of depending on whether the current poll is still awaiting a promise
5. tracker policy, tracker transport, and runner transport remain unchanged

## Scope

This slice covers:

1. orchestration poll-loop behavior for locally active runs when `maxConcurrentRuns > 1`
2. explicit local slot-accounting/runtime-state updates needed so capacity stays correct while runs continue in the background
3. status/observability updates only if needed to keep `activeLocalRuns` and live-run visibility accurate after the orchestration change
4. focused unit coverage for slot accounting and continued polling with an active run
5. at least one realistic end-to-end regression scenario that proves a second ready issue dispatches while the first run is still active
6. small doc updates where the checked-in operator/runtime guidance should describe the now-enforced concurrency behavior more explicitly

## Non-Goals

This slice does not include:

1. changing tracker label semantics or handoff lifecycle policy
2. changing runner continuation-turn behavior, app-server transport, or prompt construction
3. broad shutdown/watchdog/recovery redesign outside the slot-accounting seam required here
4. remote-worker scheduling changes beyond preserving the existing host-dispatch contract
5. broader queue-priority or dependency-promotion policy changes
6. introducing a new durable coordination store beyond the current local runtime state and lease/status artifacts

## Current Gaps

Today the orchestration loop still couples polling progress to dispatched run completion:

1. `src/orchestrator/service.ts` computes available slots from `this.#state.runningIssueNumbers.size`, dispatches work, and then `await`s `Promise.all(runs)` before `runOnce()` returns
2. `runLoop()` waits for `runOnce()` to finish before sleeping and starting the next poll, so one long-running live runner turn can delay all future polling
3. `runningIssueNumbers` currently mixes local active-run bookkeeping with per-dispatch lease lifetime in a way that becomes fragile once dispatch promises are allowed to outlive the poll cycle
4. the current implementation proves parallel dispatch inside one poll, but it does not prove continued polling while a prior dispatched run remains active in the background
5. the issue symptom matches that shape exactly: with `max_concurrent_runs: 2`, one live running issue blocked dispatch of another ready issue until the live turn ended

## Decision Notes

1. Keep the seam in the orchestrator. The bug is coordination behavior, not tracker policy and not runner transport.
2. Make local slot state explicit. Do not let one set or counter continue to mean “lease held”, “background promise exists”, and “capacity consumed” unless code and tests make those transitions explicit.
3. Preserve existing normalized tracker behavior. Running issues still take precedence in queue ordering and reconciliation; the fix is about continued polling, not changing issue ordering policy.
4. Prefer a small focused runtime-state helper if the service code would otherwise gain more inline counters/flags. This follows the repo rule against hiding orchestration behavior in loose maps and branches.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that one live active run should consume one slot, not stall unrelated free capacity
2. the rule that ready work should continue dispatching while other runs are legitimately active
3. the rule that tracker running-state inspection still happens every poll even when no dispatch capacity remains

Does not belong here:

1. promise-lifecycle plumbing
2. lease-manager filesystem details
3. runner transport mechanics

### Configuration Layer

Belongs here:

1. the existing `polling.max_concurrent_runs` contract as the capacity ceiling this issue must honor

Does not belong here:

1. new workflow fields for this fix
2. tracker-specific concurrency overrides
3. background task bookkeeping

### Coordination Layer

Belongs here:

1. explicit local slot reservation and release rules
2. decoupling poll cadence from dispatched-run completion
3. dispatch decisions that combine queue ordering, local slot usage, factory halt state, and dispatch-pressure state
4. explicit transitions for scheduled, active, and completed local dispatch work

Does not belong here:

1. tracker transport parsing
2. runner-specific event parsing
3. status rendering logic beyond consuming normalized state

### Execution Layer

Belongs here:

1. unchanged workspace preparation and runner execution once a slot has been reserved and a dispatch begins
2. preserving the current execution lifecycle for each individual run

Does not belong here:

1. deciding whether another ready issue should start
2. defining poll cadence
3. tracker reconciliation policy

### Integration Layer

Belongs here:

1. unchanged tracker reads for ready/running issues and unchanged tracker claim semantics
2. unchanged runner transport/session contracts

Does not belong here:

1. local slot accounting
2. background poll scheduling
3. compensating for orchestration races with tracker-specific behavior

### Observability Layer

Belongs here:

1. keeping `activeLocalRuns`, running-ticket visibility, and queue/status snapshots correct after polling continues during active runs
2. logging the new dispatch/slot transitions clearly enough to explain why capacity is or is not available

Does not belong here:

1. being the source of truth for slot state
2. inventing fallback capacity calculations separate from the orchestrator

## Architecture Boundaries

### `src/orchestrator/service.ts`

Owns:

1. poll scheduling
2. queue selection
3. coordination between explicit local slot state, leases, dispatch pressure, and halt state
4. background dispatch task lifecycle and cleanup

Does not own:

1. tracker transport changes
2. runner protocol changes
3. observability-only derived capacity rules

### New or extracted focused orchestrator runtime-state helper(s)

Owns:

1. explicit local slot reservation/release transitions
2. distinguishing “slot consumed by an active local dispatch” from unrelated tracker running counts
3. any tracked background-dispatch promise bookkeeping if needed to keep `service.ts` legible

Does not own:

1. tracker queue ordering
2. prompt/runner behavior
3. status formatting

### `src/orchestrator/status-state.ts` and related status snapshot wiring

Owns:

1. projecting the active local run count and active issue surface from the normalized orchestration state

Does not own:

1. primary slot-allocation decisions
2. reconstructing background dispatch state from tracker labels alone

### Tests

Own:

1. proving the continued-polling behavior under a blocked/long-running first run
2. proving the slot-accounting edge cases for dispatch start, completion, and failure

Do not own:

1. introducing tracker-specific workarounds that hide orchestration races

## Layering Notes

- `config/workflow`
  - owns the existing concurrency limit input
  - does not gain new knobs for this bug fix
- `tracker`
  - keeps supplying normalized ready/running issue lists and claim operations
  - does not absorb orchestration slot policy
- `workspace`
  - keeps preparing per-issue execution state after dispatch starts
  - does not reserve global capacity
- `runner`
  - keeps executing one issue run at a time per dispatched session
  - does not decide whether more issues should start
- `orchestrator`
  - owns local-capacity accounting, background dispatch lifecycle, and poll cadence
  - must not lean on tracker running counts as a proxy for local available slots
- `observability`
  - reports the orchestrator’s chosen slot state and active runs
  - does not infer capacity independently

## Slice Strategy And PR Seam

This should fit in one reviewable PR by staying on one orchestration seam:

1. make poll cycles non-blocking with respect to already-dispatched active runs
2. introduce explicit local slot accounting/background task tracking as needed to keep that behavior correct
3. update focused tests and narrow docs/status wording on the same seam

Deferred from this PR:

1. larger restart-recovery or shutdown refactors unless they are directly required by the new background-dispatch lifecycle
2. queue-priority redesign
3. tracker contract changes
4. runner transport redesign

This seam is reviewable on its own because it changes one observable factory behavior: continued filling of available dispatch slots while prior work remains active.

## Runtime State Machine

This issue changes long-running orchestration behavior, so slot-consumption state must be explicit.

### Local dispatch slot states

1. `idle`
   - no local slot reserved for the issue
2. `reserved`
   - the orchestrator has decided to dispatch the issue and capacity is consumed for that in-flight local work
3. `claiming-or-resuming`
   - local coordination work is underway: lease acquisition, tracker claim or running-issue inspection, and run startup bookkeeping
4. `active`
   - the issue has a live locally owned dispatch path still running, including continuation turns or waiting inside the run lifecycle
5. `releasing`
   - terminal cleanup/failure/shutdown is unwinding and the slot is about to become available again

### Allowed transitions

1. `idle -> reserved`
   - poll cycle chooses the issue for dispatch because capacity exists
2. `reserved -> claiming-or-resuming`
   - background dispatch task starts and begins local coordination work
3. `claiming-or-resuming -> active`
   - the issue reaches its live locally owned execution path
4. `claiming-or-resuming -> releasing`
   - claim/inspection/startup fails after the slot was reserved
5. `active -> releasing`
   - run completes, waits out of the live path, fails terminally, or shuts down
6. `releasing -> idle`
   - cleanup finishes and the slot becomes available for a later poll

### Contract Rules

1. slot reservation must happen before a later poll can observe the slot as free
2. poll cadence must not depend on background dispatch promises finishing
3. a slot consumed by one issue must not allow a second issue to over-dispatch during claim/startup races
4. tracker running counts and local slot counts are related observability facts, not interchangeable control inputs
5. halt and dispatch-pressure rules still block new `idle -> reserved` transitions, but they do not stop inspection of already active running issues

## Failure-Class Matrix

| Observed condition                                                                                    | Local facts available                           | Normalized tracker facts available                 | Expected decision                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| One issue is already active locally, one slot remains free, another ready issue exists                | one slot already reserved/active, one slot free | ready issue is still claimable                     | reserve the free slot and dispatch the ready issue on the next poll without waiting for the first run to finish   |
| One issue has been selected for dispatch but is still in claim/startup work when the next poll begins | slot is already reserved for that issue         | tracker may still show ready or newly running      | do not treat the slot as free and do not over-dispatch another issue into the same capacity                       |
| Active local run count already equals `maxConcurrentRuns`                                             | all slots reserved/active                       | ready issues may still exist                       | keep polling/reconciling status, but do not dispatch new ready work                                               |
| Background dispatch fails before the run becomes active                                               | reserved slot plus startup/claim failure        | issue may remain ready or move back out of running | release the slot, record the failure path, and let a later poll reconsider capacity normally                      |
| Factory halt or dispatch pressure becomes active while another run is still active                    | one or more slots active                        | ready issues may exist                             | keep inspecting running work but block new slot reservations until halt/pressure clears                           |
| Shutdown is requested while background runs are active                                                | active slots and abort controllers exist        | tracker state unchanged or running                 | stop reserving new slots, abort active runs through existing shutdown paths, and release slots only after cleanup |

## Storage / Persistence Contract

No new durable external store is needed for this issue.

Required contract:

1. local slot state remains runtime-owned orchestration state
2. status snapshots continue to expose `activeLocalRuns` from the explicit orchestration slot state rather than from tracker running counts
3. existing lease, issue-artifact, and tracker persistence remain the source of truth for issue/run ownership and lifecycle, not a new background-task registry on disk

## Observability Requirements

1. structured logs should explain slot reservation, background dispatch start, slot release, and why dispatch was blocked when capacity is full
2. status snapshots must keep showing active local run count correctly while polls continue during active runs
3. live running entries should remain visible even though the main poll loop no longer waits for their promises before the next cycle
4. if a slot is reserved but the run has not yet reached full active execution, the status path should remain inspectable enough to explain the temporary capacity usage

## Implementation Steps

1. introduce or extract explicit orchestrator runtime state for local slot reservation/background dispatch tracking
2. refactor `runOnce()` so it starts eligible dispatch work up to free capacity and returns without awaiting all active run promises
3. ensure background dispatch completion is observed safely so failures still flow through existing orchestration error handling and do not produce unhandled promise rejections
4. keep shutdown, halt, and dispatch-pressure behavior coherent with the new background-dispatch lifecycle
5. update status/log projection only where the new explicit slot state requires it
6. add focused unit tests for slot reservation, continued polling, and no-overdispatch races
7. add or extend an end-to-end test that reproduces the reported `max_concurrent_runs: 2` scenario with one live active run and one later-ready issue
8. update checked-in docs if the behavior or operator evidence needs clearer wording after the fix lands

## Tests And Acceptance Scenarios

### Unit coverage

1. a long-running first dispatch does not block a later poll from dispatching a second ready issue when one slot remains
2. slot reservation prevents over-dispatch while a selected issue is still in claim/startup work
3. full local capacity blocks new ready dispatch but still allows running-issue inspection/reconciliation
4. slot release after startup failure or run completion makes capacity available to a later poll
5. halt/dispatch-pressure state blocks new reservations even while active runs continue

### Integration / end-to-end coverage

1. with `max_concurrent_runs: 2`, one live runner turn stays active while the factory later claims and starts another ready issue
2. the status snapshot remains inspectable during that overlap and reports both the active run visibility and the consumed local slot count correctly

### Named acceptance scenarios

1. `active-turn-does-not-stall-free-slot`
   - first issue is already in a live runner turn, second issue becomes ready, factory claims the second issue before the first finishes
2. `startup-race-does-not-overdispatch`
   - one issue has consumed a slot but is still in claim/startup, later poll does not start too many additional issues
3. `full-capacity-still-polls`
   - all slots are consumed, factory still refreshes running status and observability without new dispatch

## Exit Criteria

1. the orchestrator keeps polling while previously dispatched runs remain active
2. a free slot is filled by later ready work without waiting for another live run to finish
3. slot accounting is explicit in code and covered by tests
4. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass
5. the reviewed PR stays on the orchestration seam and does not pull in unrelated tracker/runner changes

## Deferred To Later Issues Or PRs

1. any broader refactor of restart recovery, shutdown orchestration, or watchdog ownership beyond what this slot-accounting change directly needs
2. queue-policy changes unrelated to filling free slots
3. durable multi-instance slot coordination
4. runner transport redesign or new tracker backends
