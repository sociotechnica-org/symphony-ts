# Issue 280 Plan: Stop-The-Line Factory Halt For Severe Failures

## Status

- plan-ready

## Goal

Give operators a first-class, durable stop-the-line control path for one Symphony instance so they can intentionally halt new dispatch when continuing automation would be harmful, optionally stop the detached factory process, and later require an explicit resume before any new work starts again.

The intended outcome of this slice is:

1. operators can pause an instance with an explicit reason through the supported factory control surface
2. the halt state survives detached-runtime restarts and `factory stop` / `factory start`
3. the orchestrator treats the halt as an instance-owned dispatch gate rather than a tracker-side label convention
4. `factory status`, persisted status JSON, and the TUI make the halted reason and resume requirement obvious
5. docs and tests cover when and how to stop the line safely

## Scope

This slice covers:

1. a durable instance-owned factory halt record under the instance runtime artifact tree
2. additive CLI control actions for `symphony factory pause` and `symphony factory resume`
3. an orchestrator dispatch gate that blocks new ready/rerun dispatch while a halt record is active
4. status/TUI/read-model changes that surface intentional halt posture and reason
5. operator guidance updates for severe failure patterns, pause/resume procedure, and optional detached stop-after-pause workflow
6. unit, integration, and end-to-end coverage for pause, restart persistence, and resume

## Non-Goals

This slice does not include:

1. automatic halt triggers based on failure heuristics or dependency analysis
2. tracker-specific pause labels, new GitHub/Linear state transitions, or tracker transport changes
3. killing already-running issue sessions as part of `factory pause`
4. redesigning detached factory `start` / `stop` / `restart` control-state classification beyond additive halt visibility
5. general operator notebook or `.ralph/` persistence for runtime truth
6. a broader scheduler/dependency-management feature for prerequisite-aware queueing

## Current Gaps

Today Symphony lacks an intentional instance-wide halt contract:

1. `src/cli/factory-control.ts` exposes only `start`, `stop`, `restart`, and `status`, so operators cannot persist a deliberate pause distinct from an unhealthy or stopped runtime
2. the only global dispatch gate in `src/orchestrator/service.ts` is transient `dispatchPressure`, which is retry-class driven and self-clearing instead of operator-owned and durable
3. `src/orchestrator/status-state.ts` and `src/observability/status.ts` have no explicit halted factory posture or reason field, so `blocked` currently conflates expected per-issue waits with instance-wide stop-the-line behavior
4. the TUI and `factory status` cannot tell operators that dispatch is intentionally halted pending human reconciliation
5. existing operator docs cover `factory stop` for runtime shutdown but not “pause now, optionally stop the detached runtime, then resume explicitly later”

## Decision Notes

1. Keep the first slice on an instance-owned halt contract, not tracker labels or operator scratchpads. The runtime needs one durable source of truth that survives restart even when no operator loop is running.
2. Add `factory pause` and `factory resume` instead of overloading `factory stop`. That keeps “keep the process alive but stop dispatch” separate from “stop the detached process entirely,” while still allowing operators to run `factory stop` after pausing.
3. Preserve the existing `factory stop` semantics for intentional process shutdown. The supported stop-the-line workflow becomes “pause with reason, then optionally stop.”
4. Treat the halt as a dispatch gate, not as a forced cancellation path for already-running sessions. Immediate termination of active runs is a different operational decision and would widen this PR into shutdown/recovery policy.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the repo-owned rule that stop-the-line is an explicit operator action requiring a durable reason and explicit resume
2. the rule that halted state blocks new dispatch without pretending the runtime is degraded
3. the rule that `factory pause` may be followed by `factory stop`, but restart must not clear the halt automatically

Does not belong here:

1. tracker label hacks that emulate halt state
2. provider-specific failure heuristics for auto-halting
3. shell-only folklore outside the checked-in control contract

### Configuration Layer

Belongs here:

1. typed derivation of the halt-record path from existing instance paths
2. any additive read/write helpers needed so factory control and the orchestrator can resolve the same durable halt artifact

Does not belong here:

1. free-form halt reasoning hidden only in prompts or notebooks
2. tracker lifecycle policy
3. TUI rendering logic

### Coordination Layer

Belongs here:

1. reading the durable halt record during poll/dispatch
2. projecting halted state into runtime status and last-action summaries
3. preserving a clean distinction between halted dispatch and transient dispatch pressure

Does not belong here:

1. tracker API parsing
2. runner shutdown implementation for active sessions
3. ad hoc file-path derivation inline in `service.ts`

### Execution Layer

Belongs here:

1. CLI control actions that create, clear, and inspect the halt record through the factory-control seam
2. optional operator workflow of `factory pause` followed by `factory stop`

Does not belong here:

1. retry policy
2. tracker normalization
3. report aggregation or notebook persistence

### Integration Layer

Belongs here:

1. no tracker transport or normalization changes in this slice
2. existing tracker reads continue unchanged while the orchestrator decides locally whether to dispatch

Does not belong here:

1. encoding halt state as GitHub/Linear labels or comments
2. mixing halt policy into tracker adapters
3. new external-system mocks beyond what e2e tests already use

### Observability Layer

Belongs here:

1. additive status snapshot fields for halt reason and operator-visible posture
2. `factory status` / JSON / TUI rendering that clearly names intentional halt versus degraded runtime
3. operator docs and drills that explain how to inspect and resume a halted instance

Does not belong here:

1. becoming the only durable halt storage contract
2. tracker mutations
3. a second competing runtime-control state machine outside the orchestrator/control seam

## Architecture Boundaries

### `src/domain/workflow.ts` plus new focused halt-state helper

Owns:

1. deriving the instance-owned halt artifact path under the existing runtime tree
2. a small typed halt-record contract and read/write helpers

Does not own:

1. CLI parsing
2. dispatch decisions
3. TUI copy

### `src/cli/factory-control.ts` and `src/cli/index.ts`

Owns:

1. `factory pause` and `factory resume` command behavior
2. rendering halt details through the existing factory control status surface
3. preserving existing start/stop/restart semantics while making halt visibility explicit

Does not own:

1. tracker mutations
2. poll-loop gating rules
3. notebook updates

### `src/orchestrator/service.ts`

Owns:

1. reading current halt state during poll/dispatch and blocking new work accordingly
2. publishing a coherent status action / active-issue summary when the instance is halted

Does not own:

1. halt-file serialization details
2. tracker-specific halt persistence
3. forced termination of active runs in this slice

### `src/orchestrator/status-state.ts` and `src/observability/status.ts`

Owns:

1. additive runtime snapshot fields for halt state and reason
2. a stable read model that distinguishes halted instance posture from ordinary blocked waits

Does not own:

1. creating or deleting the halt record
2. tracker transport
3. CLI argument parsing

### `src/observability/tui.ts`

Owns:

1. surfacing halt status and reason in the operator-facing live view

Does not own:

1. deciding when the factory is halted
2. persistence
3. command execution

### `docs/guides/operator-runbook.md`, `docs/guides/failure-drills.md`, and `README.md`

Owns:

1. canonical operator procedure for pause, optional stop, status inspection, and resume
2. severe-failure examples that warrant stop-the-line intervention

Does not own:

1. runtime truth
2. CLI implementation
3. tracker semantics

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one vertical stop-the-line seam:

1. add one instance-owned halt-record contract
2. expose that contract through `factory pause|resume|status`
3. teach the orchestrator/status/TUI layers to honor and display the halt
4. update operator docs and drills for the new supported workflow
5. cover the behavior with focused unit/integration/e2e tests

Deferred from this PR:

1. auto-halt policy based on repeated failures, dependency violations, or watchdog trends
2. forced cancellation of active runs when pausing
3. tracker-visible halt state or issue-level intervention artifacts for instance-wide pauses
4. richer campaign/operator reporting for pause/resume events

Why this seam is reviewable:

1. it keeps tracker transport and normalization untouched
2. it uses one new runtime artifact boundary instead of smearing state into notebooks or tracker labels
3. it yields a user-visible operator capability without reopening unrelated retry or shutdown recovery work

## Runtime State Machine

This issue changes long-running orchestration behavior, so it needs an explicit state model.

### Durable halt state

The instance-owned halt record should model:

1. `clear`
   - no halt record exists; dispatch may proceed normally
2. `halted`
   - halt record exists with reason, actor/source metadata if available, and `haltedAt`
3. `resumed`
   - operationally equivalent to `clear`; resume clears the record and records a status action in current runtime memory/output

### Control and runtime interaction states

1. `running + clear`
   - detached runtime healthy, dispatch open
2. `running + halted`
   - detached runtime healthy, active runs may continue/settle, new dispatch blocked until resume
3. `stopped + halted`
   - detached runtime intentionally stopped after pause; restart must re-enter `running + halted`
4. `degraded + halted`
   - runtime-control health is broken, but the halt record remains durable and visible
5. `running + clear + dispatch-pressure`
   - existing transient pause behavior; separate from stop-the-line state

### Allowed transitions

1. `clear -> halted`
   - `factory pause --reason ...`
2. `halted -> clear`
   - `factory resume`
3. `running + clear -> running + halted`
   - pause while detached runtime stays alive
4. `running + halted -> stopped + halted`
   - operator optionally runs `factory stop` after pausing
5. `stopped + halted -> running + halted`
   - operator later runs `factory start` / `factory restart`; runtime starts but keeps dispatch halted
6. `running + halted -> degraded + halted`
   - ordinary detached-runtime failure while halt remains in force
7. `degraded + halted -> running + halted`
   - runtime repaired/restarted; halt still active until explicit resume

### Contract rules

1. halt blocks new dispatch from ready queue and retry queue alike
2. halt does not silently clear on start, restart, poll completion, or retry expiration
3. halt and transient dispatch pressure are independent facts; status must surface both when both exist
4. resume clears only the halt record; it does not wipe retry state, restart recovery state, or tracker lifecycle state

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Operator pauses a healthy detached runtime | halt record can be written; worker alive | ordinary ready/running issues | write halt record, keep runtime alive, block new dispatch, publish halted status with reason |
| Operator pauses, then stops detached runtime | halt record exists; control becomes stopped | unchanged tracker ready/running facts | stop process normally; on later start keep halted posture until resume |
| Factory starts while halt record already exists | halt record readable at startup; worker alive | ready/running issues may exist | start runtime, publish halted posture immediately, do not dispatch new work |
| Halt record exists and one active run is still finishing | halt readable; active local run count > 0 | corresponding running issue still present | allow current run/reconciliation path to finish, but do not dispatch additional work |
| Halt record missing/corrupt while operator requested pause | write/read helper errors | tracker unchanged | surface degraded control/runtime error clearly; do not pretend halt succeeded |
| Runtime degraded while halt record exists | halt readable; detached control degraded | tracker may still show running issues | report degraded control plus halted reason; require repair and explicit resume before new dispatch |
| Resume requested while runtime is stopped | halt record exists; control stopped | tracker may show ready/running issues | clear halt record; report stopped but no longer halted; later start may dispatch normally |
| Dispatch pressure active and halt record also exists | halt readable; transient dispatch pressure active | retries/ready issues present | treat halt as stronger persistent gate, but surface both halt reason and pressure detail for observability |

## Storage / Persistence Contract

The halt state is durable instance-owned runtime state, not operator-local notebook state.

Proposed contract:

1. add one additive halt artifact under the existing instance runtime tree, for example under `.var/factory/`
2. store normalized fields only:
   - `version`
   - `state` or implicit presence
   - `reason`
   - `haltedAt`
   - optional `source` / `actor` summary when the CLI can provide it
3. use one shared parser/writer so factory control and orchestrator do not reimplement JSON/file rules independently
4. absence means `clear`
5. malformed content is treated as explicit degraded state, not ignored silently

## Observability Requirements

1. persisted status snapshots must include explicit halt state and reason, not only a generic `blocked` summary
2. `factory status` human output must make intentional halt legible even when control state is `running` or `stopped`
3. `factory status --json` must expose enough structure for automation and operator tooling to distinguish:
   - halted vs transient dispatch pressure
   - halted vs degraded
   - halted reason and timestamp
4. the TUI should show halt posture and reason in the same operator-visible recovery/status area rather than burying it in logs only
5. docs should name the halt artifact as canonical runtime truth and keep `.ralph/` as optional operator notes only

## Implementation Steps

1. Add a focused halt-state module that derives the instance halt artifact path and provides typed read/write/clear helpers with validation.
2. Extend CLI parsing in `src/cli/index.ts` for `factory pause --reason <text>` and `factory resume`.
3. Update `src/cli/factory-control.ts` to:
   - inspect current halt state
   - write/clear halt records
   - render halt detail in factory control status output and JSON
   - keep `start` / `stop` / `restart` semantics otherwise unchanged
4. Extend runtime status state and snapshot contracts to carry halt posture and reason.
5. Update `src/orchestrator/service.ts` poll/dispatch flow so a current halt record blocks new dispatch while still reconciling/publishing status.
6. Update `src/observability/status.ts` and `src/observability/tui.ts` to render the halted posture clearly.
7. Update operator docs and failure drills to teach:
   - when to stop the line
   - `factory pause --reason ...`
   - optional `factory stop`
   - `factory resume`
8. Add focused tests across unit, integration, and e2e layers.

## Tests And Acceptance Scenarios

### Unit

1. halt-state parser/writer tests for valid, missing, and malformed halt records
2. CLI arg parsing tests for `factory pause --reason` and `factory resume`
3. factory-control tests proving pause/resume mutate status output correctly and survive stop/start inspection
4. status-state/rendering tests proving intentional halt is distinct from generic `blocked` and degraded states
5. TUI projection tests for halt posture/reason if the existing TUI snapshot projection needs additive fields

### Integration

1. CLI integration covering `factory pause --reason ...`, `factory status --json`, `factory resume`
2. detached control integration where pause is recorded, `factory stop` runs, and a later `factory start` still reports halted until resume

### End-to-End

1. bootstrap-factory e2e scenario where:
   - the factory pauses with a reason while issues remain ready
   - the persisted status snapshot reports halted posture
   - no new issue dispatches while halted
   - after resume, normal dispatch continues
2. restart persistence scenario where:
   - halt is set
   - factory is stopped and restarted
   - status still shows halted
   - resume is required before any queued work starts

## Acceptance Scenarios

1. Severe release failure discovered mid-run:
   - operator runs `symphony factory pause --reason "Prerequisite ticket failed; stop the line until release is reconciled."`
   - status/TUI immediately show the instance is intentionally halted with that reason
   - no additional ready issues dispatch
2. Operator needs to stop the detached runtime overnight:
   - operator pauses first, then runs `symphony factory stop`
   - the next day `symphony factory start` reports the runtime as running but still halted
   - work does not resume until `symphony factory resume`
3. Active run already in flight when pause happens:
   - the existing run can settle normally
   - the factory does not launch any new issue after that
4. Halt artifact is corrupted:
   - control/status surfaces report degraded halt-state readability rather than silently clearing it

## Exit Criteria

1. operators have a supported `factory pause` and `factory resume` workflow with required reason capture
2. halt state persists across detached-runtime stop/start until explicit resume
3. the orchestrator blocks new dispatch while halted without requiring tracker-specific labels
4. `factory status`, `factory status --json`, and the TUI clearly show the intentional halt and reason
5. docs and drills describe severe-failure stop-the-line procedure
6. relevant unit, integration, and e2e tests pass locally

## Deferred To Later Issues Or PRs

1. automatic halt heuristics triggered by repeated failure patterns
2. per-issue or campaign reporting for instance-wide pause/resume interventions
3. forced cancellation of active runs as part of the pause workflow
4. tracker-visible halt markers or tracker-backed dependency gating
5. richer operator-loop/notebook integration for halt narratives beyond linking to runtime status
