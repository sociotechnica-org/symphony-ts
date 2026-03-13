# Issue 137 Plan: Factory Detached Run Ack

## Status

- plan-ready

## Goal

Restore the supported detached factory control path so `symphony factory start` and `symphony factory restart` launch a live worker through the same explicit startup contract that `symphony run` now requires.

This slice should keep the fix in the factory-control layer: the detached launcher must encode the `run` acknowledgment contract instead of assuming undocumented operator intervention.

## Scope

- update the detached factory launch path in `src/cli/factory-control.ts` so it passes the required `run` guardrails acknowledgment flag
- keep the detached session command explicit and testable rather than inlined as an opaque shell fragment
- add unit coverage proving the launch contract includes the required acknowledgment flag
- add integration or e2e coverage that exercises `factory start` and `factory restart` through the official control surface and observes a healthy runtime
- verify the status surface reaches `running` after startup instead of timing out on an immediately exiting worker

## Non-Goals

- redesigning the detached `screen` session model
- changing the user-facing guardrails banner wording
- changing the `run` command’s acknowledgment policy
- broader factory packaging or runtime-refresh work tracked elsewhere
- unrelated status, watchdog, tracker, or TUI changes

## Current Gaps

- `src/cli/index.ts` requires `--i-understand-that-this-will-be-running-without-the-usual-guardrails` for `run`
- `src/cli/factory-control.ts` still launches `pnpm tsx bin/symphony.ts run` without that flag
- `factory start` therefore waits for a healthy detached runtime that never appears because the worker exits after printing the acknowledgment banner
- `factory restart` inherits the same broken launch contract because it reuses `startFactory()`
- current tests cover detached start/stop state transitions but do not lock the exact detached `run` invocation shape

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned contract that detached factory control must satisfy the explicit `run` startup requirements
  - does not belong: changing human review workflow, tracker lifecycle policy, or runner safety messaging
- Configuration Layer
  - belongs: any fixed CLI-launch constants needed to keep the detached command contract explicit and reusable
  - does not belong: new workflow fields or hidden config-based bypasses for the `run` acknowledgment
- Coordination Layer
  - belongs: factory-control start/restart behavior that waits for a healthy detached runtime and reports timeout versus success correctly
  - does not belong: orchestrator retry, reconciliation, or issue handoff policy
- Execution Layer
  - belongs: the exact detached `screen` command used to launch `bin/symphony.ts run`
  - does not belong: tracker mutations, prompt construction, or status rendering
- Integration Layer
  - belongs: the local host-process boundary around `screen`, `pnpm`, `tsx`, and the `bin/symphony.ts` entrypoint
  - does not belong: tracker transport or normalization changes
- Observability Layer
  - belongs: proving the control surface sees a live worker and readable status snapshot after startup
  - does not belong: new status schemas or unrelated dashboard work

## Architecture Boundaries

### Factory control / coordination seam

Belongs here:

- building the detached launch command
- starting and restarting the detached session
- waiting for control status to become healthy

Does not belong here:

- changing orchestrator runtime policy
- teaching the status layer about acknowledgment semantics

### CLI execution seam

Belongs here:

- the detached invocation shape for `bin/symphony.ts run`
- explicit reuse of the same required acknowledgment flag across start paths

Does not belong here:

- fallback prompts, interactive confirmation, or implicit environment-based bypasses

### Observability seam

Belongs here:

- reading the existing status snapshot and process liveness to confirm startup success

Does not belong here:

- new persistent control-state files
- operator docs as the primary fix

### Tracker / workspace / runner seams

Untouched except as existing dependencies of the launched runtime:

- tracker adapters should not learn about detached launch flags
- workspace code should not absorb detached process-management policy
- runner implementations should continue to see a normal `run` invocation once the detached worker is up

## Slice Strategy And PR Seam

This issue should stay one reviewable PR focused on the detached launch contract:

1. make the required `run` acknowledgment flag explicit in factory control
2. add coverage for the exact detached invocation
3. prove `factory start` and `factory restart` observe a healthy runtime through the current status surface

Deferred from this PR:

- any redesign of detached process management
- alternative service managers
- broader factory upgrade workflows
- changes to `run` safety policy itself

This seam is reviewable because it stays inside factory control plus tests. It does not mix tracker, orchestrator, watchdog, or documentation restructuring.

## Runtime State Model

This issue reuses the existing factory-control state model from issue `#81`. No new state machine is introduced because the behavioral change is limited to the detached launch command, but the affected transitions are:

1. `stopped -> starting`
   - `factory start` launches the detached session with the explicit `run` acknowledgment flag
2. `starting -> running`
   - the detached worker stays alive long enough to produce a healthy status snapshot
3. `starting -> degraded`
   - the detached worker exits early, including the regression case where the acknowledgment flag is missing
4. `running -> stopping -> stopped -> starting -> running`
   - `factory restart` uses the same corrected launch contract after the stop phase

The control seam should continue deciding health from:

- detached `screen` session presence
- local process-tree liveness
- readable factory status snapshot with a live worker pid

## Failure-Class Matrix

| Observed condition                                                          | Local facts available                                             | Status snapshot facts available            | Expected decision                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Detached launch includes ack flag and worker stays alive                    | `screen` session plus `pnpm/tsx/bin/symphony.ts run` process tree | readable snapshot with live worker pid     | report `running`; `factory start` succeeds                                          |
| Detached launch omits ack flag and worker exits after banner                | session may appear briefly, then process tree disappears          | no healthy snapshot appears before timeout | `factory start` fails with startup timeout; test should catch this regression       |
| `factory restart` stops prior runtime and relaunches with corrected command | old process tree gone, new session/process tree appears           | new healthy snapshot appears               | report `running`; restart succeeds                                                  |
| Session exists but snapshot never becomes healthy for another reason        | wrapper and maybe intermediate processes exist                    | missing or stale snapshot                  | report `degraded` and fail startup as today; this issue does not change that policy |

## Storage / Persistence Contract

- no new durable files
- no status schema changes
- the only contract change is the detached process invocation shape used by factory control

## Observability Requirements

- startup tests must prove the control surface reaches `running` for the detached path
- regression coverage must fail if the acknowledgment flag is removed from the detached launch path
- restart coverage must prove the same corrected launch path is reused on `factory restart`

## Implementation Steps

1. Extract or centralize the detached `run` argv in `src/cli/factory-control.ts` so the launch contract is explicit and easy to assert in tests.
2. Update the default detached launcher to append `--i-understand-that-this-will-be-running-without-the-usual-guardrails`.
3. Add unit coverage for the launch command contract, preferably by asserting the args passed to the process-launch dependency rather than relying only on process-table strings.
4. Extend existing factory-control tests to cover startup success and restart through the corrected launch path.
5. If current e2e coverage does not already exercise detached factory control, add a narrow integration-style test that launches through the official `factory start` path and verifies the runtime becomes healthy instead of exiting immediately.
6. Update any operator-facing docs only if the touched tests or code make an explicit command example stale.

## Tests And Acceptance Scenarios

### Unit

- factory-control launch builds `pnpm tsx bin/symphony.ts run --i-understand-that-this-will-be-running-without-the-usual-guardrails`
- `startFactory()` passes that launch contract through its launch dependency
- `restart` reuses the same corrected start path rather than building a separate command shape

### Integration / e2e

- `symphony factory start` launches a detached worker that stays alive long enough for control status to become `running`
- `symphony factory restart` stops the active detached runtime and starts a new healthy detached runtime through the same path
- removing the acknowledgment flag would cause startup health verification to fail, so the regression is covered by test expectations rather than operator memory

## Exit Criteria

- detached factory start succeeds through the official control surface
- detached factory restart succeeds through the same corrected launch path
- startup health verification reaches `running` instead of timing out for the acknowledgment regression case
- regression coverage locks the detached `run` contract

## Deferred

- any refactor of the detached session mechanism beyond what is needed to make the launch contract explicit
- changes to the `run` banner or acknowledgment policy
- broader operator runtime-refresh or packaging improvements tracked separately

## Decision Notes

- Keep the fix in factory control rather than weakening `run`’s explicit acknowledgment contract. The bug is contract drift between the control plane and the worker CLI.
- Prefer an explicit detached argv constant or helper over repeating a raw `execFile` argument list inline. That keeps the launch contract visible, testable, and less likely to drift again.
