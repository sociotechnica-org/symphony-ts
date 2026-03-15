# Issue 13 Plan: Production Hardening And Recovery Architecture

## Status

- approved

## Goal

Define the Phase 6 recovery and operations architecture for `symphony-ts` so follow-up issues can land as narrow, reviewable PRs without mixing orchestration policy, tracker quirks, runner transport, and observability formatting in the same slice.

This issue is the architecture and decomposition record for the phase umbrella. It is not the implementation vehicle for all Phase 6 deliverables.

## Scope

- define the operator-visible runtime rules for shutdown, restart recovery, retries, stalled-run handling, cleanup, and retention
- map the Phase 6 work to the Symphony abstraction levels used in `docs/architecture.md`
- document the current runtime gaps against that target shape
- define the coordination-owned runtime state model that follow-up issues must preserve
- define a phase-level failure-class matrix for restart, retry, ownership, and waiting-state decisions
- define the local durability and observability contracts needed for production-credible operation
- decompose the phase into named follow-up seams, including already-open child issues and remaining gaps

## Non-Goals

- implementing graceful shutdown, retry/backoff redesign, recovery, cleanup, or status changes in this issue
- redesigning tracker transport or normalization
- introducing remote execution, hosted control planes, or external persistence
- replacing the current local-first detached factory control path
- collapsing multiple Phase 6 seams into one broad implementation PR

## Current Gaps

The repo has made progress on individual hardening slices, but the phase architecture is still implicit:

- `src/orchestrator/state.ts` still aggregates several distinct runtime concerns through loose maps and sets rather than one named recovery-oriented runtime-state model
- run ownership exists locally through `src/orchestrator/issue-lease.ts`, but restart-time ownership, reconciliation posture, and cleanup behavior are not yet described as one phase contract
- watchdog recovery exists as a bounded liveness path, but the relationship between watchdog recovery, retry queues, waiting states, and terminal failure is not documented at the phase level
- status surfaces already project runtime state, but the minimum operator-visible fields for recovery and restart posture are spread across issue plans instead of being recorded as one Phase 6 contract
- workspace retention and terminal cleanup policy are not yet framed as a coordination-plus-execution seam with explicit ownership boundaries
- structured JSON logging exists, but the recovery/failure diagnostics expectations for daily operation and hosted-style environments are not yet codified in one plan
- the repo has open child slices such as `#19` and `#96`, but the remaining follow-up seams are not yet written down as a coherent Phase 6 roadmap

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone and no sibling checkout is available from this workspace, so this plan uses the mapping in `docs/architecture.md`.

### Policy Layer

Belongs here:

- operator-visible rules for retryable vs terminal failures
- restart and shutdown expectations
- definitions of healthy waiting, unhealthy stall, blocked, recovered, and terminal states
- the requirement that observability surfaces project coordination-owned truth

Does not belong here:

- tracker payload parsing
- runner subprocess spawning details
- TUI-only string formatting

### Configuration Layer

Belongs here:

- explicit runtime controls such as retry/backoff budgets, stall windows, cleanup/retention knobs, and observability sampling knobs
- typed workflow config under `src/config/` that enables or disables recovery behaviors without storing runtime facts

Does not belong here:

- persisted recovery state
- tracker-provider conditionals
- ad hoc booleans that compensate for missing coordination state

### Coordination Layer

Belongs here:

- orchestrator-owned runtime state and transitions
- retry queue ownership and backoff decisions
- reconciliation between tracker-visible and runtime-visible facts
- restart recovery posture
- waiting/blocked/failed/completed classification
- shutdown sequencing and recovery decisions

Does not belong here:

- tracker transport details
- runner-specific process-launch code
- presentation-only view formatting

This is the primary layer for Phase 6.

### Execution Layer

Belongs here:

- workspace lifecycle hooks
- runner process control, cancellation hooks, and structured execution outcomes
- cleanup hooks that coordination invokes through clear service contracts

Does not belong here:

- global retry policy
- tracker-facing lifecycle classification
- policy decisions about when a failure is terminal

### Integration Layer

Belongs here:

- normalized tracker issue and PR state
- read/write operations needed for reconciliation
- tracker-specific transport, normalization, and edge policy kept separate from each other

Does not belong here:

- compensating for local recovery bugs in adapter branches
- hidden retry state encoded in transport code

### Observability Layer

Belongs here:

- structured logs
- operator-facing status surfaces
- projections of runtime state such as running entries, retry entries, waiting reasons, and recovery posture
- token and cost reporting where runner events provide it

Does not belong here:

- becoming the source of truth for orchestration state
- inferring tracker lifecycle by bypassing normalized coordination state

## Architecture Boundaries

### `src/orchestrator/`

Owns:

- runtime state machines for active runs, retries, waiting states, recovery, and shutdown
- reconciliation logic between tracker state, local durable state, and live execution facts
- decisions to wait, retry, recover, fail, or complete

Does not own:

- tracker transport parsing
- workspace filesystem mutations beyond coordination through `WorkspaceManager`
- runner-specific command construction
- status formatting

### `src/runner/`

Owns:

- process launch, cancellation, timeout, and structured runner events
- runner-visible token/cost/session telemetry where available

Does not own:

- issue retry budgets
- tracker-facing lifecycle semantics
- restart reconciliation policy

### `src/workspace/`

Owns:

- deterministic workspace creation/reuse
- retention and cleanup hooks invoked by coordination policy

Does not own:

- tracker lifecycle decisions
- retry policy
- status projection policy

### `src/tracker/`

Owns:

- tracker transport
- normalization into stable internal issue and handoff snapshots
- tracker writes required by reconciliation

Does not own:

- watchdog policy
- retry queue ownership
- restart recovery branching based on local runtime facts

### `src/observability/`

Owns:

- canonical status/read models derived from runtime state
- structured logs and issue/session artifacts
- operator-facing dashboard, control, and reporting projections

Does not own:

- orchestration transitions
- lease ownership
- tracker mutation side effects

### `src/config/`

Owns:

- explicit runtime configuration values for recovery-related behavior

Does not own:

- persisted leases, retry entries, or recovery counters

## Slice Strategy And PR Seams

Issue `#13` should remain one planning PR whose output is this architecture record plus any minimal issue-thread handoff needed for review. Follow-up implementation must land through narrow seams.

What lands in this issue:

- the checked-in Phase 6 architecture plan
- the phase runtime-state model and failure-class matrix
- a decomposition into reviewable child seams

What is deliberately deferred:

- all runtime behavior changes
- documentation/runbook updates beyond what is necessary to anchor the plan
- any tracker, runner, workspace, or observability code changes

Why this seam is reviewable:

- it improves the repo-owned planning contract without widening into runtime implementation
- it gives later issues explicit boundaries so review comments can focus on code rather than missing architecture

## Follow-Up Seam Map

Existing child slices already under this umbrella:

1. `#19` supervised run ownership and orphan reconciliation
2. `#96` stalled runner watchdog and bounded auto-recovery

Remaining named follow-up seams for Phase 6:

1. graceful shutdown and in-flight termination
2. restart recovery and ownership reconciliation completion
3. retry/backoff runtime state and retry queue projection
4. workspace retention and terminal cleanup policy
5. structured observability and status projection for recovery posture
6. token/cost accounting projection from runner events
7. rate-limit and transient-failure handling policy
8. operator runbooks, failure drills, and stability/concurrency testing

Recommended implementation order:

1. complete ownership/restart supervision foundations
2. complete watchdog/retry recovery seams
3. add graceful shutdown and cleanup policy
4. tighten observability and diagnostics around those coordination states
5. finish operator docs and failure-drill coverage against the resulting runtime

## Runtime State Model

Phase 6 needs one explicit coordination-owned model even if individual child issues only implement parts of it. Follow-up slices should extend toward this model rather than invent local counters or one-off flags.

### Active Run Lifecycle States

1. `queued`
   - work is eligible but not yet owned by a local active run
2. `preparing`
   - tracker claim, workspace preparation, and local ownership acquisition are in progress
3. `running`
   - a live runner session is executing and emitting events
4. `awaiting-external`
   - no local runner is active because the issue is intentionally waiting on a human or external system
   - examples: plan review, PR review, CI, landing command
5. `retry-scheduled`
   - the current attempt ended in a retryable condition and a due-at backoff entry exists
6. `reconciling`
   - the orchestrator is reconciling tracker-visible state, lease state, and live-process facts after startup, restart, or poll repair
7. `recovering`
   - the orchestrator is actively repairing an orphaned, stalled, or interrupted run
8. `cleanup-pending`
   - a terminal outcome is decided and workspace/artifact retention or cleanup is still in progress
9. `completed`
   - the issue reached a successful terminal handoff
10. `failed-terminal`
   - the issue reached a non-retryable or budget-exhausted terminal failure

### Recovery Posture States

These are orthogonal to the active run lifecycle and should stay explicit rather than being inferred from retries alone.

1. `healthy`
   - local ownership, tracker state, and runner liveness agree
2. `waiting-expected`
   - the issue is blocked on an expected external condition
3. `stalled-suspected`
   - progress signals are missing beyond threshold but recovery has not yet been executed
4. `orphaned`
   - tracker says running or local state exists, but there is no healthy owner/runner relationship
5. `restart-recovery`
   - the process has restarted and is actively reconciling inherited state
6. `degraded`
   - the runtime can continue, but one recovery or observability dependency is impaired
7. `terminal`
   - no further automated recovery is expected for this issue/run

### Allowed Transitions

- `queued -> preparing -> running`
- `running -> awaiting-external`
- `running -> retry-scheduled`
- `running -> recovering -> running`
- `running -> cleanup-pending -> completed`
- `running -> cleanup-pending -> failed-terminal`
- `awaiting-external -> running`
- `awaiting-external -> reconciling`
- `retry-scheduled -> preparing`
- `reconciling -> running`
- `reconciling -> awaiting-external`
- `reconciling -> retry-scheduled`
- `reconciling -> cleanup-pending`
- `recovering -> retry-scheduled`
- `recovering -> cleanup-pending`

Invalid transitions that follow-up issues should avoid:

- execution code deciding `failed-terminal` directly from raw runner exit without coordination policy
- tracker adapters inventing `recovering` or `orphaned` semantics internally
- observability surfaces inferring recovery posture from stale snapshots instead of receiving it from coordination state
- overloading one counter for retry budget, continuation budget, and watchdog recovery budget

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected coordination decision |
| --- | --- | --- | --- |
| Factory receives shutdown while runner is active | active run ownership, runner PID/session, shutdown signal | issue still in running lifecycle | move to `cleanup-pending`; attempt graceful runner cancellation; preserve recoverable state if shutdown interrupts completion |
| Process restarts and finds a `running` issue with healthy owner and live runner | durable lease/ownership, live PID, current runtime not authoritative yet | issue marked running | classify as `reconciling`; do not double-dispatch; either adopt or explicitly recover per ownership contract |
| Process restarts and finds `running` issue with stale owner and dead runner | stale lease, dead owner PID, no runner | issue marked running, no terminal PR state | classify `orphaned`; requeue through retry path if budget remains, otherwise fail terminally |
| Process restarts and finds `running` issue with stale owner but live orphaned runner | stale owner PID, live runner PID | issue marked running | terminate orphaned runner through execution seam, then reconcile to retry or terminal failure |
| Runner exits with transient failure and retry budget remains | run result, retry counters, watchdog/recovery counters | issue still eligible | enqueue `retry-scheduled` entry with bounded backoff and visible failure summary |
| Runner exits with non-retryable failure or retry budget exhausted | run result, exhausted counters | issue still active or waiting | move to `cleanup-pending`, then `failed-terminal`; publish actionable diagnostics |
| No runner progress beyond stall threshold but recovery budget remains | watchdog state, liveness probe, runner PID | issue still active | classify `stalled-suspected`; abort and move through `recovering` to `retry-scheduled` |
| Issue is waiting on plan review / PR review / CI | no local runner, normalized blocked reason | waiting lifecycle present | classify `awaiting-external` + `waiting-expected`; do not consume retry budget |
| Status snapshot missing or stale after restart | no current snapshot or stale publication metadata | tracker may still show active work | keep orchestration truth in coordination; mark observability `degraded`/`restart-recovery`, not terminal |
| Workspace cleanup fails after terminal outcome | terminal issue result, cleanup error | tracker may already reflect terminal state | keep terminal issue outcome, record `cleanup-pending`/degraded cleanup diagnostics, and surface operator actionability |

## Storage And Persistence Contract

Phase 6 should preserve a narrow local durability contract:

- tracker state remains the system of record for issue lifecycle visible to collaborators
- local durable state exists only for runtime ownership, recovery, startup reconciliation, status snapshots, and artifacts needed to recover or inspect the local factory
- durable local recovery state should live in focused coordination modules, not inside config or tracker transport files
- persisted files must be reconstructible and inspectable after an unclean stop
- status snapshots and dashboards remain derived views, not authoritative runtime state
- workspace retention metadata should describe what may be cleaned or kept without becoming a second issue-lifecycle database

Implications for follow-up issues:

- ownership and lease data belong under `src/orchestrator/`
- retry queue persistence, if added, belongs to a named runtime-state contract rather than free-form JSON blobs hidden in observability
- artifacts under `.var/` remain inspectable evidence, not the source of retry/recovery decisions

## Observability Requirements

At minimum, the Phase 6 architecture requires operator-visible projection of:

- running work and its current lifecycle stage
- retry/backoff queue entries and next due times
- last known runner/update context
- waiting or blocked reasons that distinguish healthy waiting from unhealthy stalls
- recovery posture such as restart reconciliation, orphan recovery, watchdog recovery, and degraded cleanup
- failure summaries with actionable diagnostics
- token and cost tracking where runner events provide it
- structured JSON logs suitable for local terminals and hosted log ingestion

Rules:

- status surfaces must project coordination-owned truth
- observability can report stale or unavailable state, but it must not decide recovery policy
- logging fields for recovery should be stable enough to correlate a run across shutdown, restart, retry, and cleanup

## Tests And Acceptance Scenarios

Because this issue is the architecture/decomposition slice, the primary deliverable is the checked-in plan. Follow-up implementation issues should use the scenarios below as the phase acceptance baseline.

Required test categories for child slices:

- unit coverage for explicit state transitions and failure classification
- integration coverage for orchestrator plus tracker/runner/workspace seams
- end-to-end coverage for restart, retry, shutdown, cleanup, and observability paths using mocks or local harnesses rather than real external systems

Named phase acceptance scenarios:

1. Operator restarts the factory during an active run.
   - Expected: runtime narrative remains inspectable; active work is reconciled instead of silently abandoned or duplicated.
2. Runner stalls without exiting.
   - Expected: operator can see the stall reason and recovery posture; bounded recovery or terminal failure is explicit.
3. Human-review waiting state persists overnight.
   - Expected: status surfaces show expected waiting, not failure or hidden idleness.
4. Retryable transient failure happens repeatedly.
   - Expected: retry visibility shows due time, budget consumption, and final terminal decision when exhausted.
5. Terminal success or failure occurs with cleanup work pending.
   - Expected: the issue outcome remains clear while cleanup posture and retention decisions stay inspectable.
6. Detached runtime restarts and status snapshots are temporarily unavailable.
   - Expected: observability reports degraded/unavailable state without misrepresenting old runtime data as current truth.

## Implementation Steps

This issue's implementation steps are planning and decomposition steps:

1. Record the Phase 6 architecture, state model, failure matrix, and boundaries in this checked-in plan.
2. Cross-check the plan against existing child issues and identify which seams already have plans (`#19`, `#96`) versus which still need follow-up issues.
3. Post the `plan-ready` handoff on issue `#13` with direct links to this plan on branch `symphony/13`.
4. Stop for explicit human `approved` or `waived` handoff before any substantial implementation.
5. After approval, create or update narrow child issues/plans for the remaining seams rather than coding directly under the umbrella issue.

## Exit Criteria

This issue is complete for its current planning slice when:

- the Phase 6 architecture is documented in a checked-in plan under `docs/plans/013-production-hardening-recovery-architecture/plan.md`
- the plan maps the phase to policy, configuration, coordination, execution, integration, and observability layers
- the plan names scope, non-goals, current gaps, architecture boundaries, implementation steps, tests, acceptance scenarios, exit criteria, and deferrals
- the plan includes an explicit runtime state model and failure-class matrix for recovery-oriented behavior
- the plan decomposes the phase into narrow follow-up seams instead of one broad implementation PR
- the reviewed plan is committed, pushed, and posted to the GitHub issue through the required `plan-ready` protocol

## Deferred To Later Issues Or PRs

- graceful shutdown implementation details
- restart recovery implementation details beyond existing slices
- retry queue/state refactors
- workspace retention and terminal cleanup implementation
- structured recovery/status projection implementation
- token/cost tracking implementation gaps
- operator runbooks, drills, and concurrency/stability validation

## Decision Notes

- Issue `#13` should remain the architecture anchor for Phase 6, not the place where multiple runtime seams are implemented together.
- Existing child slices such as `#19` and `#96` should remain narrow and should be updated against this plan rather than merged into a broader recovery PR.
- Follow-up plans under this phase should treat the status surface as a projection of coordination state and should avoid broad patches that mix tracker transport, runtime policy, runner behavior, and cleanup mechanics.
