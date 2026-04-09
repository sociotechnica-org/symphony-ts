# Issue 336 Plan: Refactor BootstrapOrchestrator into Explicit Coordination Modules

## Status

- plan-ready

## Goal

Refactor [`BootstrapOrchestrator`](../../../src/orchestrator/service.ts) from a
single control-plane sink into a thin composition root over named coordination
modules, while preserving the current tracker, workspace, runner, and status
behavior.

The end state for this slice is not a new orchestration algorithm. It is a
clearer orchestration architecture:

- the top-level orchestrator reads as a small sequencing shell
- stateful coordination flows live in named modules with explicit inputs and
  outputs
- ordinary poll/dispatch, claimed-issue handling, run execution, and handoff /
  landing decisions stop living as one intertwined method family
- startup/recovery/reporting coordination remains explicit instead of being
  interleaved with ordinary dispatch flow

## Scope

- extract named coordination modules from
  [`src/orchestrator/service.ts`](../../../src/orchestrator/service.ts)
- make the ordinary poll tick read like a short coordination script rather than
  a long policy sink
- separate queue construction / slot accounting from claimed-issue execution
- separate claimed-issue lifecycle handling from active-run execution
- separate landing orchestration from general lifecycle refresh
- separate startup / restart-recovery / terminal-reporting coordination from
  ordinary dispatch sequencing
- preserve existing normalized tracker / workspace / runner boundaries
- add module-focused tests so major coordination behavior no longer requires
  standing up the whole service

## Non-goals

- changing tracker lifecycle semantics or GitHub-specific policy
- redesigning the TUI or status snapshot schema
- redesigning retry policy, watchdog policy, or workspace retention semantics
- introducing distributed orchestration or new runner transports
- changing prompt-construction semantics or workflow/config contracts
- moving issue-artifact schema construction out of the orchestrator in this
  slice unless a tiny helper extraction is required to keep module boundaries
  legible

## Current Gaps

- [`src/orchestrator/service.ts`](../../../src/orchestrator/service.ts) is still
  about 5,000 lines and owns poll sequencing, dispatch gating, issue claiming,
  handoff refresh, landing execution, run launch, failure handling,
  restart-recovery coordination, terminal reporting coordination, watchdog
  coordination, and status publication
- `#runOnceInner()` mixes tracker polling, ready-queue ordering, halt and
  dispatch-pressure gating, startup recovery, queue merge, status mutation, and
  background dispatch scheduling
- `#processClaimedIssue()` and `#runIssue()` mix lease orchestration, lifecycle
  refresh, host reservation, workspace prep, prompt building, runner launch,
  turn-loop control, retry handling, and status mutation
- startup and terminal-reporting coordination are distinct concerns but still
  live in the same service class as ordinary dispatch control
- most orchestration tests still enter through the full service, which keeps
  module-level behavior harder to exercise directly

## Decision Notes

- Keep this refactor inside the coordination layer. The goal is not to move
  tracker, workspace, runner, or observability policy into new places; the goal
  is to stop letting one service method family own all coordination concerns.
- Prefer typed function modules over introducing another large stateful class.
  Each extracted module should accept explicit service dependencies plus the
  named orchestrator-state slices it mutates.
- Keep effectful orchestration separate from pure decision helpers. Queue
  ordering, transition classification, and lifecycle branching should remain
  testable without spinning up a runner process.
- Keep issue-artifact creation and status-snapshot persistence as service-owned
  side effects unless a small helper extraction is needed. Issue `#338` is the
  primary observability seam; this issue should not silently absorb it.
- If the full extraction starts mixing queueing, lifecycle, recovery, and
  observability edits too broadly in one PR, narrow the implementation to the
  ordinary poll/dispatch plus claimed-issue / run / handoff path first and
  defer the remaining service-hosted coordinators to a follow-up issue.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the repository-owned rule that orchestration logic should be
    expressed through explicit coordination seams and named transitions
  - belongs: the rule that tracker-specific quirks stay outside the orchestrator
  - does not belong: provider-native transport parsing or runner subprocess
    specifics
- Configuration Layer
  - belongs: no new configuration surface beyond wiring the existing
    orchestrator dependencies into extracted modules
  - does not belong: `WORKFLOW.md` contract changes, prompt-template changes, or
    tracker/runner config redesign
- Coordination Layer
  - belongs: poll sequencing, queue merge, slot accounting, issue-claim flow,
    run launch orchestration, handoff/landing coordination, retry scheduling,
    restart-recovery coordination, and terminal-reporting coordination
  - does not belong: raw tracker API payload parsing, workspace implementation
    details, or TUI rendering choices
- Execution Layer
  - belongs: existing workspace preparation and runner launch contracts as
    consumed dependencies
  - does not belong: moving workspace or runner implementation logic into the
    orchestrator modules
- Integration Layer
  - belongs: tracker / workspace / runner interfaces consumed by the
    coordination modules
  - does not belong: mixing tracker transport, normalization, and orchestration
    policy in the same extracted module
- Observability Layer
  - belongs: driving status and artifact publication from normalized
    coordination outcomes
  - does not belong: snapshot-schema redesign, renderer redesign, or terminal
    transport behavior

## Architecture Boundaries

### Orchestrator composition-root seam

Belongs here:

- constructing the orchestrator state and service dependencies
- exposing `runOnce`, `runLoop`, `snapshot`, and watchdog entrypoints
- delegating ordinary coordination work to extracted modules
- owning cross-cutting callbacks such as `persistStatusSnapshot`,
  `recordIssueArtifact`, and dashboard notification

Does not belong here:

- inline queue ordering logic
- inline claimed-issue lifecycle branching
- inline runner turn-loop orchestration
- inline restart-recovery decision application

### Poll-cycle coordination seam

Belongs here:

- tracker polling for ready/running/failed issue snapshots
- startup halt / dispatch-pressure gating
- stale active-issue pruning
- startup recovery invocation
- ready-queue ordering and queue merge
- dispatch-slot accounting and dispatch-task startup

Does not belong here:

- workspace preparation
- runner launch
- landing execution
- terminal issue reporting persistence details

### Claimed-issue coordination seam

Belongs here:

- per-issue lease acquisition/release
- claim-vs-running entry handling
- lifecycle refresh for claimed issues
- deciding between complete, hold-for-handoff, landing, or run

Does not belong here:

- queue construction
- low-level runner turn execution
- tracker transport logic

### Active-run coordination seam

Belongs here:

- host reservation continuity
- workspace preparation and prompt construction as consumed dependencies
- run-session creation and runner launch
- turn-loop coordination, continuation decisions, and shutdown handling
- failure classification handoff into retry or terminal failure decisions

Does not belong here:

- tracker fetch of the ready queue
- status rendering or TUI view-model code
- tracker-specific handoff policy beyond the normalized lifecycle contract

### Handoff and landing coordination seam

Belongs here:

- normalized lifecycle observation handling after a run or refresh
- landing eligibility / duplicate-request suppression
- landing execution and post-request lifecycle refresh
- terminal completion when lifecycle reaches `handoff-ready`

Does not belong here:

- raw PR/review/check payload mapping
- run-launch logic
- snapshot rendering policy

### Startup / recovery / reporting seam

Belongs here:

- inherited-running-issue reconciliation at startup
- restart-recovery decision application
- terminal-reporting backlog scan and retry coordination
- startup placeholder vs current-status publication ordering

Does not belong here:

- ordinary ready-queue dispatch logic
- runner turn loops
- TUI presentation policy

### Untouched seams

- tracker adapters remain responsible for normalized issue and lifecycle facts
- workspace and runner implementations remain unchanged except for any tiny
  helper extraction needed to support testability
- observability schema/rendering work stays on the `#338` seam

## Slice Strategy And PR Seam

Target one reviewable PR with one architectural seam: orchestration
decomposition inside `src/orchestrator/`.

Planned landing order inside the PR:

1. introduce a small shared coordinator context that exposes the explicit
   dependencies and orchestrator-state slices needed by extracted modules
2. extract a poll-cycle coordinator for `runOnceInner()` queue construction and
   dispatch startup
3. extract claimed-issue plus active-run coordinators for lease, lifecycle,
   run-launch, turn-loop, retry, and terminal transitions
4. extract handoff / landing and startup / reporting coordinators where those
   flows can move without reopening observability architecture
5. trim [`service.ts`](../../../src/orchestrator/service.ts) into a composition
   root plus remaining cross-cutting helpers
6. add direct unit coverage for the extracted coordinators and keep the
   existing orchestrator/e2e suites green

Fallback seam if the PR grows too broad:

1. land only the ordinary poll-cycle plus claimed-issue / active-run /
   handoff-lifecycle coordinators
2. leave startup/restart-recovery and terminal-reporting coordination in
   `service.ts` with minimal call-site cleanup
3. open a focused follow-up issue for the remaining startup/reporting
   extraction

Deferred from this issue unless needed to preserve behavior:

- watchdog-loop decomposition beyond any minimal call-site cleanup
- issue-artifact schema/builder redesign
- status snapshot schema/renderer refactors
- workflow/config or tracker contract changes

This seam is reviewable because it stays inside the orchestrator layer and is
behavior-preserving by design. It does not mix tracker normalization work,
workflow-contract work, or observability rendering redesign.

## Coordination Runtime State Model

This issue does not invent a new runtime algorithm, but it does require an
explicit state model so the extracted coordinators mutate named runtime state
instead of extending `BootstrapOrchestrator` with more opportunistic branches.

### Poll-cycle states

1. `idle`
   - no tracker poll in progress
2. `polling-tracker`
   - ready/running/failed snapshots are being fetched and factory halt state is
     being inspected
3. `reconciling-running`
   - inherited running issues are being reconciled before new dispatch
4. `queue-built`
   - ordered ready queue, running queue, retry queue, and available-slot facts
     are known
5. `dispatching`
   - background dispatch tasks are being reserved and started
6. `reporting`
   - current status snapshot and terminal-reporting reconciliation are being
     flushed
7. `idle-complete`
   - the tick finished without a fatal error
8. `degraded`
   - the tick failed before producing a stable post-poll state

Allowed transitions:

- `idle -> polling-tracker`
- `polling-tracker -> reconciling-running`
- `reconciling-running -> queue-built`
- `queue-built -> reporting`
- `queue-built -> dispatching`
- `dispatching -> reporting`
- `reporting -> idle-complete`
- any state -> `degraded`

### Claimed-issue / active-run states

1. `dispatch-selected`
   - an issue was chosen from the merged queue
2. `lease-held`
   - the local issue lease exists and the issue can be processed safely
3. `lifecycle-inspected`
   - the current normalized handoff lifecycle has been refreshed
4. `handoff-held`
   - lifecycle indicates review/check/landing wait; no run starts
5. `landing-executing`
   - a landing command is being issued for an `awaiting-landing` lifecycle
6. `run-preparing`
   - host reservation, workspace preparation, and prompt construction are in
     progress
7. `run-active`
   - the runner session exists and turn-loop coordination is active
8. `run-failed`
   - the run failed and failure classification is available
9. `retry-queued`
   - retry state was scheduled and the issue is awaiting a future run
10. `terminal-success`
    - lifecycle or merge completion resolved the issue successfully
11. `terminal-failure`
    - retry budget was exhausted or terminal failure policy applied
12. `degraded`
    - coordination could not make a stable decision

Allowed transitions:

- `dispatch-selected -> lease-held`
- `lease-held -> lifecycle-inspected`
- `lifecycle-inspected -> handoff-held`
- `lifecycle-inspected -> landing-executing`
- `lifecycle-inspected -> run-preparing`
- `landing-executing -> lifecycle-inspected`
- `run-preparing -> run-active`
- `run-active -> lifecycle-inspected`
- `run-active -> run-failed`
- `run-failed -> retry-queued`
- `run-failed -> terminal-failure`
- `lifecycle-inspected -> terminal-success`
- any state -> `degraded`

State ownership rules:

- queue-order and slot-accounting facts stay in the poll-cycle coordinator
- lease and claim facts stay in the claimed-issue coordinator
- host reservation, run session, continuation, and retry facts stay in the
  active-run coordinator
- landing-attempt suppression facts stay in `landing-state.ts`
- startup reconciliation facts stay in the startup/recovery coordinator

## Failure-Class Matrix

| Observed condition                                                 | Local facts available                                           | Normalized tracker facts available                                                                                                                             | Expected decision                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Factory halt is active during poll                                 | halt state file readable, available slots known                 | ready/running snapshots may exist                                                                                                                              | build status, inspect running issues only, block new dispatch                               |
| Dispatch pressure is active                                        | active dispatch-pressure state with retry class and resume time | ready/running snapshots may exist                                                                                                                              | keep reporting state fresh, suppress new ready dispatch until pressure expires              |
| Ready issue selected but no remote host is free                    | host-dispatch occupancy and preferred-host facts                | issue is still runnable                                                                                                                                        | hold issue in queued/preparing status, do not start workspace prep, retry on later poll     |
| Claimed issue lifecycle is `handoff-ready`                         | lease held, branch name resolved                                | lifecycle summary and PR facts                                                                                                                                 | clear landing/follow-up state, complete the issue terminally                                |
| Claimed issue lifecycle is review/check wait                       | lease held                                                      | lifecycle kind is `awaiting-system-checks`, `awaiting-human-review`, `awaiting-human-handoff`, `degraded-review-infrastructure`, or `awaiting-landing-command` | persist lifecycle/status/artifact observation, do not start a run                           |
| Claimed issue lifecycle is `awaiting-landing`                      | landing runtime state and last head SHA may exist               | lifecycle includes landing PR facts                                                                                                                            | either execute landing once for the current head SHA or hold the issue in awaiting-landing  |
| Inherited running issue has healthy ownership                      | lease snapshot shows active or shutdown-owned live run          | running issue still exists in tracker                                                                                                                          | adopt ownership facts, do not enqueue a duplicate run                                       |
| Inherited running issue has stale ownership but runnable lifecycle | lease snapshot missing/stale/dead                               | running issue still exists and lifecycle is rerunnable                                                                                                         | reconcile stale lease, retain preferred host if available, requeue for dispatch             |
| Runner launch or turn fails with retry budget remaining            | failure class, run session, preferred host, retry state         | lifecycle is not terminally complete                                                                                                                           | record retry, schedule backoff, clear active issue, preserve retry continuity facts         |
| Runner failure occurs after merge/handoff completion               | failure class and finished-at facts                             | refreshed lifecycle is `handoff-ready` or merged terminal state                                                                                                | suppress retry/failure and complete issue successfully                                      |
| Terminal reporting backlog entry is blocked                        | receipt shows blocked state and retry timing                    | terminal issue artifact exists                                                                                                                                 | schedule reporting retry with backoff and keep terminal status visible                      |
| Coordinator cannot reconcile ownership or lifecycle                | local error / unreadable lease state                            | tracker facts missing or contradictory                                                                                                                         | mark recovery/posture degraded, keep the poll loop alive, avoid unsafe dispatch duplication |

## Persistence And Durable-State Contract

This refactor should preserve the current durable runtime contract. The goal is
to change module ownership, not to silently reshape persisted state.

Durable state touched by this issue:

- local issue leases under the workspace root
- factory halt state under the instance-owned `.var/factory/` tree
- status snapshots written through
  [`src/observability/status.ts`](../../../src/observability/status.ts)
- terminal issue artifacts and reporting receipts under the existing
  observability paths

Contract rules for this slice:

- extracted coordinators may read and write the existing durable artifacts, but
  they must do so through the current lease-manager, status-publication, and
  terminal-reporting helpers
- no on-disk schema or file-layout changes are planned in this issue
- startup/restart-recovery extraction must preserve the current semantics for
  adopting, reconciling, or clearing inherited local ownership
- status publication remains derived from normalized runtime state rather than
  becoming a new coordinator-owned persistence format
- if implementation reveals a need to change a durable artifact contract, stop,
  update this plan, and narrow that work into an explicit follow-up seam rather
  than burying it inside the refactor

## Implementation Steps

1. Add a small internal coordinator context contract under `src/orchestrator/`
   that exposes:
   - shared dependencies (`tracker`, `workspaceManager`, `runner`,
     `promptBuilder`, `logger`, lease manager, status persistence, artifact
     writer)
   - the named orchestrator state slices each module needs
   - narrow callbacks for cross-cutting side effects
2. Extract a poll-cycle coordinator module for:
   - ready/running/failed polling
   - halt / dispatch-pressure gating
   - stale active-issue pruning
   - ready-queue ordering and merged-queue construction
   - dispatch task reservation/startup
3. Extract a claimed-issue coordinator module for:
   - ready vs running issue entrypoints
   - issue lease handling
   - lifecycle inspection and branch selection
   - branching to completion, handoff hold, landing, or run
4. Extract an active-run coordinator module for:
   - host reservation continuity
   - workspace prep and prompt build
   - run-session creation and runner launch
   - turn-loop coordination, continuation handling, and shutdown flow
   - failure classification and retry / terminal transitions
5. Extract a handoff / landing coordinator module for:
   - lifecycle refresh after run/landing
   - landing execution and duplicate suppression
   - terminal completion through normalized lifecycle
6. Extract startup / recovery / terminal-reporting coordination where it stays
   within this PR seam without reopening observability architecture
7. Update [`src/orchestrator/service.ts`](../../../src/orchestrator/service.ts)
   to compose the modules and retain only the top-level loop, snapshot surface,
   watchdog entrypoints, and shared helper wiring
8. Add or refactor tests so module behavior can be covered through builders and
   narrow fakes instead of full-service setup where possible

## Tests And Acceptance Scenarios

### Unit coverage

- poll-cycle coordinator:
  - orders ready issues with retries and running issues preserved
  - suppresses new dispatch when factory halt or dispatch pressure is active
  - fills all currently available local-dispatch slots without double-reserving
- claimed-issue coordinator:
  - completes immediately on `handoff-ready`
  - holds issues in review/check wait states without launching a run
  - routes `awaiting-landing` through landing coordination instead of run
- active-run coordinator:
  - reserves/releases remote hosts correctly around workspace prep and runner
    launch
  - classifies runner failures into retry vs terminal failure without mutating
    unrelated state
  - preserves preferred-host continuity across retries
- startup/recovery coordinator:
  - adopts healthy inherited runs
  - requeues stale ownership when lifecycle is still runnable
  - marks recovery degraded when facts are contradictory or unreadable

### Integration and existing orchestrator coverage

- keep the current orchestrator unit suites green, especially:
  - dispatch slot filling and retry scheduling
  - landing execution / suppression behavior
  - restart-recovery adoption and suppression behavior
  - terminal issue reporting reconciliation
- add focused tests for any new coordinator-context helpers or builders

### End-to-end acceptance scenarios

- GitHub bootstrap e2e still drives a ready issue through run, PR/handoff, and
  completion with unchanged behavior
- linear e2e still proves the orchestrator consumes normalized tracker facts
  without GitHub-specific coordination branches
- restart with inherited running issues still avoids duplicate dispatch and
  surfaces the expected recovery posture

## Exit Criteria

- [`src/orchestrator/service.ts`](../../../src/orchestrator/service.ts) shrinks
  substantially and reads as a composition root instead of a control-plane sink
- ordinary poll/dispatch, claimed-issue handling, active-run execution,
  handoff/landing, and startup/reporting coordination live in named modules
- extracted modules expose explicit inputs/outputs and mutate named runtime
  state instead of relying on hidden service-local branching
- no tracker transport or normalization logic leaks into the orchestrator
  modules
- relevant unit, integration, and e2e suites pass unchanged in behavior

## Deferred To Later Issues Or PRs

- further watchdog-loop decomposition if this issue does not need it
- artifact-schema or status-rendering redesign work on the `#338` seam
- workflow/config decomposition on the `#339` seam
- operator-loop decomposition on the `#340` seam
- broader runtime-contract work such as normalized dependency graphs on the
  `#337` seam
