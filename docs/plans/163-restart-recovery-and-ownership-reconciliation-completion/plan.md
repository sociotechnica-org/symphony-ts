# Issue 163 Plan: Restart Recovery And Ownership Reconciliation Completion

## Status

- plan-ready

## Goal

Complete the restart-time recovery contract for locally owned runs so a factory restart does not treat inherited `symphony:running` work as an implicit happy-path continuation. On startup, the factory should inspect durable local ownership facts, normalized tracker handoff facts, and live process facts, then make an explicit per-issue decision to adopt, recover, requeue, or terminate inherited work while publishing an operator-visible reconciling/degraded posture.

This issue is the follow-up seam after `#13`, `#19`, `#127`, `#130`, and `#162`: ownership persistence and stale-lease cleanup exist, but the coordination contract for restart-time decisions is still incomplete and too implicit.

## Scope

- define the startup reconciliation contract for inherited locally owned work
- add an explicit coordination-owned restart recovery state model and decision result per inherited running issue
- classify inherited runs using local lease facts, live-process probes, and normalized tracker handoff state before normal dispatch proceeds
- encode explicit outcomes for:
  - adopt existing healthy ownership
  - recover intentional shutdown residue
  - requeue stale/dead ownership
  - terminate orphaned runner processes before repair
  - stop retrying and terminate tracker work that is already in a terminal/handed-off state
- publish restart-recovery posture in the runtime status surface so operators can distinguish healthy startup, reconciling startup, and degraded recovery
- cover the decision matrix with unit, integration, and e2e tests

## Non-Goals

- redesigning tracker transport or normalization
- replacing the existing local lease persistence format with a new durable store
- changing runner spawn/cancellation transport beyond the minimum data already exposed through lease state
- broad watchdog, retry-budget, or continuation-turn redesign outside the startup recovery seam
- solving multi-host or remote-worker ownership; this issue remains local-first

## Current Gaps

- `src/orchestrator/service.ts` performs startup ownership reconciliation by calling `LocalIssueLeaseManager.reconcile`, but the result is mostly reduced to “lease cleared” side effects and a generic log/status action
- the orchestrator does not yet model restart recovery as an explicit runtime state machine with named decisions, so startup posture is not inspectable beyond logs
- the coordination layer does not distinguish “healthy inherited live owner”, “dead owner with live orphaned runner”, “stale running label but PR already handed off”, and “intentional shutdown residue” as first-class recovery outcomes
- startup and status surfaces already support degraded/unavailable startup snapshots, but they do not yet project restart-time reconciliation as a distinct operator-visible posture
- current tests prove stale lease cleanup and a happy-path stale-running recovery, but they do not cover the full decision matrix called for in the issue summary
- the current code still couples restart repair to local lease cleanup more than to an explicit normalized handoff decision contract

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in `docs/architecture.md`.

### Policy Layer

Belongs here:

- the repo-owned rule that inherited `symphony:running` work must be explicitly classified at restart instead of silently resumed
- the allowed restart outcomes: adopt, recover, requeue, terminate
- the operator-visible requirement that restart recovery exposes reconciling/degraded posture until decisions complete

Does not belong here:

- PID probing details
- tracker API requests
- TUI-only wording

### Configuration Layer

Belongs here:

- none by default for this issue; the restart contract should work from existing workflow/runtime config
- only a narrowly scoped knob if an existing hard-coded startup recovery bound proves insufficient and must become explicit

Does not belong here:

- persisted recovery facts
- tracker-provider conditionals
- recovery branching encoded as config booleans instead of coordination state

### Coordination Layer

Belongs here:

- the restart recovery state machine
- classification of inherited runs from local/tracker/runtime facts
- decisions to adopt, clear, retry, fail, or suppress rerun because handoff is already terminal
- publication of recovery posture into runtime status

Does not belong here:

- tracker transport parsing
- runner process launch mechanics
- human-facing formatting logic

### Execution Layer

Belongs here:

- existing lease persistence and process-liveness facts consumed by restart recovery
- terminating an orphaned local runner process when coordination decides cleanup is required

Does not belong here:

- tracker lifecycle policy
- deciding whether a handed-off PR should suppress rerun

### Integration Layer

Belongs here:

- normalized tracker handoff facts used by restart recovery, via existing tracker service contracts
- any narrow tracker service additions needed to express “already terminal / awaiting-human / merged / failed” without leaking provider-specific details into the orchestrator

Does not belong here:

- local lease inspection
- startup posture state
- provider-specific branching inside orchestrator recovery code

### Observability Layer

Belongs here:

- recovery posture projection in persisted status
- operator-facing summaries of per-issue restart decisions
- structured logs for the facts and outcome of each recovery decision

Does not belong here:

- becoming the source of truth for restart policy
- inferring tracker handoff by bypassing normalized coordination state

## Architecture Boundaries

### `src/orchestrator/`

Owns:

- the restart recovery coordinator and runtime-state transitions
- sequencing: inspect inherited state before normal ready-issue dispatch
- per-issue recovery decisions and side effects orchestrated through service interfaces

Does not own:

- tracker payload parsing
- raw process-spawn mechanics
- UI formatting

### `src/orchestrator/issue-lease.ts`

Owns:

- lease persistence
- owner/runner liveness probing
- low-level stale-runner termination and lock cleanup

Does not own:

- tracker-aware restart policy
- deciding whether inherited work should be adopted or requeued
- status-surface wording

### `src/tracker/`

Owns:

- normalized handoff state used by recovery
- tracker writes needed when restart decides to requeue, fail, or finalize inherited work

Does not own:

- lease cleanup
- PID probes
- startup posture state machine

### `src/observability/`

Owns:

- restart recovery projection in runtime status
- structured decision logging fields

Does not own:

- recovery branching
- direct tracker or lease mutations

## Slice Strategy And PR Seam

This issue should land as one coordination-focused PR:

1. extract an explicit restart recovery model and decision result
2. teach startup orchestration to use normalized tracker handoff plus local lease facts to choose the correct outcome
3. project restart recovery posture into status/log surfaces
4. add targeted unit/integration/e2e coverage for the decision matrix

Deferred from this PR:

- any redesign of tracker transport/normalization internals
- broader retry/backoff runtime-state refactors
- remote execution ownership semantics
- unrelated TUI polish beyond consuming the new recovery posture

Why this seam is reviewable:

- it keeps the change centered on coordination policy plus observability projection
- it reuses the existing lease and tracker contracts where possible instead of widening into runner or tracker transport work
- it closes the Phase 6 restart seam without mixing in separate retry, landing, or cleanup initiatives

## Runtime State Machine

This issue changes restart-time orchestration behavior, so the state model must be explicit.

### Factory-Level Restart Recovery States

1. `idle`
   - no startup recovery has begun
2. `reconciling`
   - the factory is inspecting inherited running work before normal dispatch
3. `degraded`
   - at least one inherited issue could not be reconciled cleanly; startup continues in degraded posture with the problem surfaced
4. `ready`
   - startup recovery is complete and normal dispatch may proceed

Allowed transitions:

- `idle -> reconciling`
- `reconciling -> ready`
- `reconciling -> degraded`
- `degraded -> ready`

The orchestrator should not dispatch new ready work before the recovery pass exits `reconciling`.

### Per-Issue Restart Recovery States

1. `inspecting`
   - local lease and tracker handoff facts are being read
2. `adopted`
   - inherited ownership is still healthy and remains under supervision
3. `recovered-shutdown`
   - intentional shutdown residue was acknowledged and cleared without rerun
4. `requeued`
   - stale/dead ownership was repaired and the issue remains eligible for continued tracker-driven work
5. `terminated`
   - orphaned local runner process was terminated as part of recovery
6. `suppressed-terminal`
   - inherited local ownership was stale, but tracker handoff facts already show the work in a terminal or handed-off state, so rerun is suppressed
7. `degraded`
   - inspection or repair could not complete safely; operator-visible degraded posture is required

Allowed high-level transitions:

- `inspecting -> adopted`
- `inspecting -> recovered-shutdown`
- `inspecting -> requeued`
- `inspecting -> terminated -> requeued`
- `inspecting -> suppressed-terminal`
- `inspecting -> degraded`

Decision note:

- `terminated` is an observed side-effect state in the decision path, not the final issue lifecycle. It exists so tests and observability can prove that a live orphaned runner was actively stopped before rerun or suppression.

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Running issue has live owner lease for the current factory process | valid lease, owner alive, runner state consistent | issue still `running`, no terminal handoff | `adopted`; keep supervising without clearing the lease |
| Running issue has dead owner and live orphaned runner | stale lease, owner dead, runner alive | issue still `running`, no terminal handoff | terminate orphaned runner, clear stale lease, mark `requeued` |
| Running issue has dead owner and no live runner | stale or invalid lease, no live runner | issue still `running`, no terminal handoff | clear stale lease, mark `requeued` |
| Running issue has recovered shutdown record from prior graceful stop | shutdown lease, owner dead | tracker still `running` or recoverable | `recovered-shutdown`; clear residue and let existing retry/handoff logic continue |
| Running issue has no local lease at all | missing lease | tracker still `running`, no terminal handoff | explicit no-local-owner recovery path; decide requeue/fail from tracker handoff and retry policy rather than silent ignore |
| Running issue has stale local ownership but tracker already reports merge-ready / awaiting-human / merged / terminal failure | stale or missing lease | terminal or handed-off lifecycle snapshot | `suppressed-terminal`; do not start a new run just to repair old local state |
| Lease inspection or tracker handoff refresh fails | unreadable local record, probe failure, or tracker read failure | incomplete or unavailable | mark factory recovery `degraded`, surface issue-level degraded decision, do not silently dispatch as healthy |

## Storage / Persistence Contract

- continue using the existing local lease directory under `.symphony-locks/` as the durable local ownership store
- add a narrow coordination-owned restart recovery record to runtime status rather than creating a second durable lease store
- preserve the existing lease record as the source of local ownership facts; recovery decisions derived from it should be projected through status/log surfaces, not written back as a separate long-lived coordination database
- if a small persisted recovery marker is needed to avoid duplicate startup repair during one worker lifetime, keep it inside orchestrator-owned runtime status/state and avoid widening the lease schema unless tests prove it is necessary

Decision note:

- prefer deriving restart decisions from existing lease plus tracker facts over expanding `run.json` with tracker-specific policy flags

## Observability Requirements

- startup status must make restart reconciliation visible as a real posture, not just a transient log message
- per-issue recovery actions should appear in the runtime status/action history with enough detail to answer:
  - what was inherited
  - what facts were observed
  - what decision was taken
- structured logs should include decision kind, issue number, lease state, owner/runner liveness, and normalized handoff classification
- degraded recovery must remain visible after startup if any issue could not be reconciled cleanly

## Implementation Steps

1. extract a focused restart recovery decision module under `src/orchestrator/` that turns local lease facts plus normalized tracker handoff facts into explicit decision results
2. update `BootstrapOrchestrator` startup flow to run this recovery pass before normal dispatch and to track factory-level recovery posture
3. keep `LocalIssueLeaseManager` focused on lease facts and low-level cleanup; only add helpers there if the decision module needs more explicit snapshots, not tracker policy
4. add any narrow tracker-service read model needed so restart recovery can distinguish recoverable `running` work from terminal/handoff-complete work without embedding GitHub-specific conditions in orchestrator code
5. project recovery posture and per-issue outcomes through status state and structured logs
6. add or refactor test builders/helpers for inherited lease fixtures so the recovery matrix stays readable
7. update README or observability docs if the operator-visible startup posture changes materially

## Tests

### Unit

- decision-module coverage for each recovery outcome in the failure-class matrix
- startup posture transitions: `idle -> reconciling -> ready/degraded`
- suppression of rerun when tracker handoff is already terminal even if local ownership is stale
- adoption path when inherited ownership is still healthy

### Integration

- tracker/orchestrator interaction proving restart recovery consults normalized handoff state instead of only local lease cleanup
- degraded recovery when tracker inspection fails for one inherited running issue while others still reconcile
- status-surface projection of reconciling and degraded restart posture

### End-to-End

- restart with dead owner and live orphaned runner: orphan is terminated, stale ownership is cleared, issue continues through the real workflow
- restart with stale running label but already-handed-off tracker state: no duplicate rerun is started
- restart with unrecoverable inspection problem: factory surfaces degraded posture instead of pretending startup is healthy

## Acceptance Scenarios

1. Healthy inherited ownership
   - a running issue still owned by the current live factory is adopted without clearing its lease or launching duplicate work
2. Dead owner, live orphan
   - startup terminates the orphaned local runner, clears stale ownership, and makes the issue eligible for the correct next tracker-driven step
3. Dead owner, no runner
   - startup clears stale ownership and explicitly requeues or resumes through normal orchestration
4. Terminal tracker handoff already reached
   - startup cleans up stale local ownership but suppresses a duplicate rerun because tracker facts already show the work beyond execution
5. Recovery inspection failure
   - startup remains visibly degraded until the operator can inspect the unresolved issue; normal healthy appearance is not reported

## Exit Criteria

- restart recovery is modeled explicitly in coordination code rather than as implicit stale-lease cleanup
- the orchestrator makes an inspectable per-issue decision for inherited running work before normal dispatch
- startup/status surfaces expose reconciling and degraded recovery posture
- tests cover adopt, recover-shutdown, requeue, terminate-orphan, suppress-terminal, and degraded paths
- the PR remains limited to the restart recovery seam without mixing tracker transport or unrelated runtime refactors

## Deferred To Later Issues Or PRs

- multi-instance or remote-worker ownership reconciliation
- broader retry/backoff redesign
- workspace retention or artifact cleanup policy beyond what restart recovery directly needs
- richer TUI affordances beyond consuming the new recovery posture
