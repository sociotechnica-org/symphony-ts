# Issue 139 Plan: Safe Detached Factory Watch

## Status

- plan-ready

## Goal

Provide a safe supported way to observe the detached local factory without attaching the operator terminal directly to the worker-owned `screen` session.

This slice should make the normal observation path safe by default: `Ctrl-C` in the watch client should stop the watch client, not the detached `symphony run` worker.

## Scope

- document the current unsafe behavior of raw `screen -r symphony-factory`
- add a first-class detached observation command in the existing factory-control CLI
- implement a watch loop that renders detached factory control/status data without attaching to the worker terminal
- make the watch loop stop cleanly on `SIGINT`/`SIGTERM` without calling `factory stop`
- add focused tests for CLI parsing, watch rendering/loop behavior, and interrupt handling
- update operator-facing docs and skills to point to the safe watch path instead of raw `screen -r`

## Non-Goals

- redesigning the detached runtime launch mechanism
- replacing `screen` with another service manager
- changing orchestrator retry, reconciliation, or issue handoff policy
- redesigning the status TUI for all runtime modes
- adding write/control operations to the watch path beyond read-only observation

## Current Gaps

- the detached runtime is commonly observed by running `screen -r symphony-factory`
- attaching this way gives the operator terminal direct foreground ownership of the worker process
- an accidental `Ctrl-C` while attached can send `SIGINT` to the detached `symphony run` process and stop the factory
- current checked-in docs prefer the factory-control surface for start/stop/status, but there is no first-class safe live watch command
- operators therefore still have an incentive to use raw `screen` attach when they want continuous visibility

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned operator contract that detached observation must be safe by default and should not rely on raw worker-terminal attach
  - does not belong: changing plan-review workflow, tracker lifecycle semantics, or runner provider policy
- Configuration Layer
  - belongs: CLI-level watch defaults such as refresh interval if kept internal and fixed for this slice
  - does not belong: new `WORKFLOW.md` settings for watch behavior unless the implementation proves a repo-owned config seam is required
- Coordination Layer
  - belongs: detached factory-control watch behavior, including the explicit signal boundary between the watch client and the detached worker
  - does not belong: orchestrator dispatch, retry budgeting, reconciliation, or worker shutdown policy
- Execution Layer
  - belongs: the local process behavior of the watch command itself as a separate client process
  - does not belong: workspace management or runner subprocess changes
- Integration Layer
  - belongs: local host integration with the existing factory status snapshot and process/screen inspection already used by `factory status`
  - does not belong: tracker transport, normalization, or remote API changes
- Observability Layer
  - belongs: rendering a live operator-facing watch surface from the existing control/status snapshot
  - does not belong: changing the canonical snapshot schema unless the watch surface proves a missing read-side field

## Architecture Boundaries

### Factory control / coordination seam

Belongs here:

- a safe `factory watch` command that polls the detached control surface
- signal handling that terminates the watch client without stopping the worker
- reuse of `inspectFactoryControl()` as the source of truth for watch snapshots

Does not belong here:

- worker-terminal attach
- detached runtime startup/shutdown redesign
- orchestrator runtime policy changes

### Observability seam

Belongs here:

- rendering a readable continuous watch view from the existing control/status snapshot
- lightweight watch-specific framing such as refresh timing or clear-screen behavior

Does not belong here:

- new tracker-derived policy
- unrelated TUI redesign or richer live runner telemetry work beyond what the current snapshot already exposes

### CLI seam

Belongs here:

- argument parsing and command dispatch for `symphony factory watch`
- process-local `SIGINT`/`SIGTERM` handling for the watch client

Does not belong here:

- hidden fallback behavior that shells into `screen -r`
- implicit operator control actions on interrupt

### Tracker / workspace / runner seams

Untouched for this slice:

- tracker adapters should not learn about detached observation commands
- workspace code should not absorb watch-loop or signal-boundary behavior
- runners should continue to run exactly as they do today under the detached worker

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on one detached observation seam:

1. add a safe first-class watch command on top of existing factory control/status data
2. prove the watch client exits on interrupt without invoking worker shutdown
3. update docs so operators use the safe path instead of raw `screen -r`

Deferred from this PR:

- replacing `screen`
- introducing a supervisor in front of the worker
- broad factory-control packaging changes from `#136`
- live log streaming or interactive control features

This seam is reviewable because it stays in CLI/factory-control plus operator docs and tests. It does not mix tracker transport, orchestrator state, watchdog behavior, or runner internals.

## Runtime State Model

This issue does not change the detached factory runtime state machine itself. It adds a separate watch-client state model:

1. `idle`
   - `symphony factory watch` starts and performs the first control inspection
2. `rendering`
   - the client renders the current detached control/status snapshot
3. `sleeping`
   - the client waits for the next poll interval
4. `stopping`
   - the client receives `SIGINT` or `SIGTERM` and stops its own loop
5. `stopped`
   - the client exits without calling `factory stop` and without signaling detached worker pids

Allowed transitions:

- `idle -> rendering`
- `rendering -> sleeping`
- `sleeping -> rendering`
- `idle|rendering|sleeping -> stopping -> stopped`

Healthy waiting vs broken behavior:

- healthy: detached runtime may be `running`, `stopped`, or `degraded`; the watch client still renders what the control surface reports
- broken: watch client swallows an interrupt but continues polling, or it triggers detached-worker shutdown as part of interrupt handling

## Failure-Class Matrix

| Observed condition | Local facts available | Snapshot facts available | Expected decision |
| --- | --- | --- | --- |
| Detached runtime is healthy and watch starts normally | watch client pid only; existing `screen`/worker process tree remains untouched | readable control snapshot with `running` state | render live watch view; `Ctrl-C` stops only the watch client |
| Detached runtime is stopped before watch starts | no session/process tree | stopped or missing snapshot | render stopped/degraded state as today; watch keeps polling until operator exits |
| Detached runtime is degraded while watching | existing control problems from process/snapshot inspection | degraded control snapshot | render degraded state; watch exits non-zero only if the command contract chooses to on normal completion, not on interrupt |
| Operator presses `Ctrl-C` while watching | watch client receives `SIGINT`; detached worker remains a separate process tree | last rendered snapshot unchanged until next launch of watch/status | stop the watch loop and exit cleanly without calling `stopFactory()` or signaling worker pids |
| Watch render/read hits a transient inspection error | error from control inspection | snapshot unavailable or unreadable | render/report the current control error using the existing control semantics; keep the failure isolated to the watch client |

## Storage / Persistence Contract

- no new durable files
- no new local coordination state
- reuse the existing factory status snapshot and control inspection as read-only inputs

## Observability Requirements

- operators must have a documented supported command for continuous detached observation that does not attach to the worker terminal
- watch rendering should clearly identify that it is reading the detached control/status surface, not the raw worker terminal
- tests should prove interrupt handling stops the watch client only

## Implementation Steps

1. Add a `factory watch` CLI action and keep its argument surface minimal for this slice, likely `--json` unsupported and a fixed poll interval.
2. Introduce a small watch-loop helper in the CLI/factory-control boundary that:
   - polls `inspectFactoryControl()`
   - clears and redraws the terminal for human mode
   - installs `SIGINT`/`SIGTERM` handlers that only stop the watch loop
3. Reuse `renderFactoryControlStatus()` for the content body unless a tiny watch-specific wrapper is needed for framing.
4. Add unit coverage for argument parsing and dispatch of the new watch command.
5. Add watch-loop tests that prove:
   - the loop renders snapshots repeatedly
   - `SIGINT` stops the loop
   - interrupt handling does not call `stopFactory()` or any worker-targeting signal path
6. Update `README.md`, `docs/guides/self-hosting-loop.md`, and `skills/symphony-operator/SKILL.md` to document `symphony factory watch` as the supported live observation path and to call out raw `screen -r` as unsafe for normal monitoring.
7. Manually validate a detached runtime by starting the factory, running the new watch command, sending `Ctrl-C` to the watch client, and confirming `factory status` still reports a live detached runtime.

## Tests And Acceptance Scenarios

### Unit

- `parseArgs()` accepts `symphony factory watch`
- `runCli()` dispatches the watch action and installs watch-loop shutdown behavior
- watch-loop helper exits when its abort/stop path is triggered by `SIGINT`
- watch-loop helper does not invoke `stopFactory()` or any process-signal dependency on interrupt

### Integration / e2e

- a detached runtime can be observed continuously through `symphony factory watch` without attaching to `screen`
- after interrupting the watch client, `symphony factory status` still reports the detached runtime as healthy/running

### Acceptance Scenarios

1. An operator starts the detached factory, runs `pnpm tsx bin/symphony.ts factory watch`, and sees the live detached control/status surface update without attaching to the worker terminal.
2. While the watch command is running, the operator presses `Ctrl-C`; the watch command exits, and a subsequent `pnpm tsx bin/symphony.ts factory status` still shows the detached factory alive.
3. An operator reading the checked-in docs sees `factory watch` as the supported live observation path and is warned that raw `screen -r symphony-factory` is unsafe for normal monitoring.

## Exit Criteria

- a supported safe detached watch path exists in the checked-in CLI
- interrupting the watch client does not stop the detached worker
- docs and operator guidance point to the safe watch path instead of raw fragile attach
- tests cover the interrupt boundary for the watch surface

## Deferred

- wrapper/supervisor process designs that change detached runtime ownership
- non-`screen` detached backends
- richer live log-follow or read-only attach mechanisms
- broader factory operator-loop packaging tracked under `#136`

## Decision Notes

- Prefer a first-class safe watch command over trying to make raw `screen -r` safe. The current bug is that observation and control share the same terminal boundary; the narrowest fix is to separate them.
- Keep the watch surface read-only for this slice. Mixing observation with stop/restart controls in the same interactive client would blur the signal-safety contract and broaden review scope.
