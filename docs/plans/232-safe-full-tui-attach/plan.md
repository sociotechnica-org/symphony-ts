# Issue 232 Plan: Safe Full-TUI Attach For Detached Factory Instances

## Status

- plan-ready

## Goal

Add a supported way to recover the live full-screen Symphony TUI for an already-running detached factory instance without handing the operator terminal directly to the worker-owned `screen` session.

This slice should preserve the existing detached-control model:

- `factory status --json` remains the canonical source of truth
- `factory watch` remains the supported read-only live monitor
- the new attach path becomes the explicit richer foreground-TUI recovery tool when operators need the real full-screen dashboard instead of the summarized watch surface

## Scope

- add a first-class `symphony factory attach` command for a selected instance
- broker a safe attach boundary between the operator terminal and the detached runtime session so operator interrupt keys detach the client instead of stopping the worker
- resolve attach targets through the existing instance-scoped detached session identity contract
- keep the attach path limited to local detached runtime integration and operator-facing docs/tests
- add focused unit and integration coverage for attach-session resolution, signal handling, terminal cleanup, and degraded-control cases
- update operator docs and skills to distinguish `factory status`, `factory watch`, and `factory attach`

## Non-goals

- changing tracker transport, normalization, or lifecycle policy
- changing orchestrator retry, continuation, reconciliation, lease, or handoff behavior
- replacing GNU Screen as the detached-runtime backend
- redesigning the dashboard/TUI layout
- introducing a remote terminal protocol or hosted attach service
- making `factory attach` the new canonical source of truth over `factory status --json`
- broadening this issue into operator-loop packaging or dashboard aggregation work

## Current Gaps

- the supported detached observation path today is `factory watch`, which is intentionally safe but does not expose the actual full-screen foreground TUI
- the only practical way to recover the real TUI today is raw `screen -r` against the detached session, which is explicitly unsupported because the operator terminal shares the worker's direct terminal boundary
- current factory-control code can resolve and inspect the detached `screen` session safely, but it has no brokered attach client
- CLI parsing and docs currently expose only `start`, `stop`, `restart`, `status`, and `watch`
- tests cover the safe watch client but not a richer attach path with explicit signal isolation and terminal restoration rules

## Decision Notes

- Keep `factory attach` as an explicit, opt-in operator command instead of overloading `factory watch`. The two commands have different contracts: read-only snapshot polling versus richer live TUI recovery.
- Keep the attach boundary local and brokered. Do not normalize raw `screen -r` back into the operator procedure.
- Reuse the existing selected-instance contract and detached session naming from `#216`; this issue should not reopen multi-instance identity design.
- Prefer a PTY-broker attach client that can intercept local control keys and terminal signals before they reach the detached worker. Do not assume GNU Screen alone can provide the required safety boundary.
- If host-specific terminal helpers are required, isolate them behind a small attach-integration helper so the command contract stays testable.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that full-TUI recovery for a detached instance must go through a safe brokered attach path rather than raw worker-terminal attach
  - belongs: the rule that `factory status --json` remains canonical and `factory watch` remains the default safe live monitor
  - does not belong: `screen` argv details, PTY plumbing, or OS signal wiring
- Configuration Layer
  - belongs: fixed CLI-level attach defaults and any small typed attach options that stay internal to the command contract for this slice
  - does not belong: new `WORKFLOW.md` settings unless implementation proves a persistent repo-owned config seam is necessary
- Coordination Layer
  - belongs: selecting the targeted detached session for the chosen instance and defining how the attach client starts, detaches, and reports degraded conditions
  - does not belong: orchestrator polling, dispatch, retries, review-loop policy, or runtime-state redesign
- Execution Layer
  - belongs: launching the local attach broker, allocating the child terminal boundary, forwarding resize/input/output, and preventing client interrupts from reaching the worker session
  - does not belong: workspace lifecycle or runner behavior changes
- Integration Layer
  - belongs: GNU Screen attach invocation, host terminal capability probing if needed, and any local PTY helper integration used to broker the attach safely
  - does not belong: tracker API changes or mixed tracker/runtime policy
- Observability Layer
  - belongs: clear operator-facing output for attach failures, degraded session selection, and docs that position attach relative to status/watch
  - does not belong: canonical snapshot schema changes unless the attach UX proves an actual read-model gap

## Architecture Boundaries

### CLI / factory-control seam

Belongs here:

- `factory attach` argument parsing and dispatch
- selected-instance resolution using the existing factory-control path helpers
- attach preflight checks against current detached control state

Does not belong here:

- raw PTY event loops embedded inline inside unrelated start/stop/status logic
- tracker or orchestrator policy

### Attach broker seam

Belongs here:

- one focused attach client module that owns:
  - child attach process creation
  - local terminal mode setup and restoration
  - input/output forwarding
  - resize propagation
  - interception of local detach/interrupt keys and signals
- explicit distinction between "client detached" and "worker stopped"

Does not belong here:

- detached-runtime lifecycle management beyond attach preflight
- snapshot rendering logic already owned by `factory watch` / status surfaces

### Screen / host integration seam

Belongs here:

- constructing the attach command for the resolved detached session
- encapsulating host-specific PTY-wrapper details when a raw child process cannot safely own the operator terminal directly
- surfacing actionable errors when the attach helper or `screen` backend is unavailable

Does not belong here:

- attach policy decisions
- repo-wide terminal abstraction unrelated to this feature

### Observability and docs seam

Belongs here:

- documenting when to use `factory status`, `factory watch`, and `factory attach`
- explaining that `factory attach` is richer than `watch` but still brokered so `Ctrl-C` detaches the client only
- making degraded attach failure modes explicit in CLI output and docs

Does not belong here:

- TUI redesign
- unrelated operator-loop behavior changes

### Tracker / workspace / runner seams

Untouched for this slice:

- tracker adapters should not learn about attach
- workspace code should not absorb attach plumbing
- runner implementations should continue to see the same runtime environment as today

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR on one detached-runtime operator seam:

1. add one explicit `factory attach` command
2. implement one isolated brokered attach client
3. reuse existing instance-scoped detached session resolution
4. lock the behavior with focused tests and operator docs

Deferred from this PR:

- replacing Screen with another session backend
- richer interactive attach controls beyond safe detach and resize handling
- remote attach or web-based TUI access
- broader operator loop/dashboard changes
- any orchestrator-side TUI state publication redesign

This seam is reviewable because it stays in CLI/factory-control, a small attach helper, host integration, tests, and docs. It does not mix tracker edges, orchestrator retry state, or broad TUI redesign.

## Attach Client Runtime State Model

This issue does not change the detached factory runtime state machine. It adds a brokered attach-client state model.

### States

1. `preflight`
   - resolve the selected instance and inspect detached control state
2. `attach-ready`
   - exactly one healthy target session is available for brokered attach
3. `attaching`
   - the local attach broker launches the child attach boundary
4. `attached`
   - full-screen TUI bytes and resize/input events flow through the broker
5. `detaching`
   - the operator requests local detach or the client receives an interrupt/termination signal
6. `detached`
   - the client exits after restoring the local terminal without stopping the worker
7. `attach-failed`
   - preflight, child attach launch, or terminal restoration fails clearly

### Allowed transitions

- `preflight -> attach-ready`
- `preflight -> attach-failed`
- `attach-ready -> attaching`
- `attaching -> attached`
- `attaching -> attach-failed`
- `attached -> detaching`
- `detaching -> detached`
- `attached -> attach-failed`

### Contract rules

- attach targets exactly one selected instance's detached session
- `Ctrl-C`, `SIGINT`, and local terminal teardown must detach the client without intentionally forwarding those control signals to the worker-owned session
- the attach client must restore local terminal state on all normal detach paths
- degraded preflight states remain explicit; the command should not guess across multiple matching sessions or silently fall back to raw `screen -r`

## Failure-Class Matrix

| Observed condition | Local facts available | Detached-control facts available | Expected decision |
| --- | --- | --- | --- |
| Target instance has one healthy detached session | selected workflow path, local TTY, attach helper/backend available | `factory status` equivalent reports one matching session | start brokered attach and render the full TUI |
| Target instance is stopped | selected workflow path, local TTY | no matching session / stopped control state | fail clearly and direct the operator to `factory start` or `factory status` |
| Target instance is degraded with multiple matching sessions | selected workflow path | degraded control snapshot with multiple matching sessions | fail clearly; require operator cleanup through existing control path rather than attaching ambiguously |
| Operator presses `Ctrl-C` while attached | local client receives interrupt byte/signal | worker session remains otherwise healthy | detach the client, restore terminal state, leave detached runtime alive |
| Operator terminal resizes while attached | local width/height change | active detached session | propagate resize through the broker so the foreground TUI reflows |
| Attach helper/PTY wrapper is unavailable on host | host command/path probe fails | detached session may still be healthy | fail clearly with actionable local-host guidance; do not fall back to unsafe raw attach |
| Attach child exits unexpectedly while worker remains alive | attach subprocess exit status / EOF | detached control still shows live session | report attach failure locally; do not stop the worker |
| Local terminal restoration fails during detach | raw-mode / stdio restore error | detached worker may still be healthy | report degraded local cleanup clearly while prioritizing worker safety |

## Storage / Persistence Contract

- no new durable runtime files are required for this slice
- no tracker-side or orchestrator durable state changes are introduced
- attach state is process-local to the brokered client and exits with that client
- existing detached status/startup snapshots remain the canonical read-side evidence before and after attach

## Observability Requirements

- `factory attach` must fail with explicit, operator-readable messages when the target instance is stopped, degraded, ambiguous, or unsupported on the current host
- docs must state that `factory status --json` remains canonical, `factory watch` remains the supported read-only monitor, and `factory attach` is the richer foreground TUI recovery tool
- tests must prove that local detach/interrupt paths do not invoke factory stop behavior
- if the attach client prints a local banner or detach hint, keep it minimal so it does not obscure the full-screen TUI

## Implementation Steps

1. Extend CLI parsing and dispatch to accept `symphony factory attach [--workflow <path>]`.
2. Add a focused attach module near factory-control that:
   - resolves the selected instance through the existing factory-control helpers
   - performs detached-control preflight
   - launches a brokered child attach boundary for the resolved `screen` session
   - owns local terminal mode setup, resize forwarding, detach/interrupt handling, and cleanup
3. Add a small host integration helper for the brokered attach path so tests can stub:
   - child attach process creation
   - local terminal raw-mode interactions
   - resize and signal listeners
4. Keep `factory watch` unchanged as the polling read-only surface; do not collapse the two contracts.
5. Update README and operator docs/skills to explain the three supported detached observation modes:
   - `factory status --json` for truth
   - `factory watch` for safe read-only monitoring
   - `factory attach` for safe full-TUI recovery
6. Add regression coverage for command parsing, attach preflight, safe detach-on-`Ctrl-C`, resize forwarding, and terminal restoration.

## Tests And Acceptance Scenarios

### Unit tests

- `parseArgs()` accepts `symphony factory attach`
- CLI dispatch calls the new attach command without changing existing start/stop/status/watch behavior
- attach preflight rejects stopped and degraded multi-session control states
- attach client intercepts local `SIGINT` / detach key handling and does not call `stopFactory()`
- attach client restores local terminal state on normal detach and child-exit paths
- attach client forwards resize events to the child attach boundary

### Integration tests

- a mocked healthy detached session can be attached through the broker with the resolved instance-scoped session name
- interrupting the attach client leaves detached control healthy and does not terminate the worker-owned session
- attach startup fails clearly when the host helper or backend is unavailable

### End-to-end acceptance scenarios

1. Given a detached factory is already running, when the operator runs `pnpm tsx bin/symphony.ts factory attach --workflow <path>`, then the real full-screen TUI appears through the supported brokered path.
2. Given the operator is attached through `factory attach`, when they press `Ctrl-C`, then the attach client exits and a subsequent `factory status` still shows the detached runtime alive.
3. Given two detached instances exist, when the operator attaches to one selected workflow, then only that instance's detached session is targeted.
4. Given detached control is degraded or ambiguous, when the operator runs `factory attach`, then the command refuses unsafe attach and points the operator back to `factory status` / cleanup.

## Exit Criteria

- a supported `factory attach` command exists for detached instances
- attach uses the selected instance-scoped detached session identity and refuses ambiguous/degraded targets
- local detach/interrupt handling does not stop the detached worker
- local terminal cleanup is reliable and tested
- docs clearly distinguish canonical status, safe watch, and safe full-TUI attach

## Deferred

- replacing Screen
- read/write permission models inside Screen itself
- remote or browser-based TUI attach
- richer interactive attach shortcuts beyond the minimum safe detach contract
- broader observability redesign or dashboard feature work

## Decision Notes

- Prefer one explicit attach command over telling operators to use raw `screen -r`. The product gap is not "operators need to remember a shell incantation"; it is that the supported control surface lacks a safe foreground-TUI recovery path.
- Prefer a brokered attach client over claiming Screen alone provides the needed safety boundary. The repo should own the safety contract in code and tests.
- Keep the initial attach slice narrow. Solving safe full-TUI recovery does not require tracker changes, orchestrator redesign, or a new supervisor architecture.
