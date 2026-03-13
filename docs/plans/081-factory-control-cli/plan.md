# Issue 81 Plan: Factory Control CLI

## Status

- plan-ready

## Goal

Add a checked-in `symphony factory` control surface that operators can run from the repository root to start, stop, restart, and inspect the active local factory without remembering `.tmp/factory-main` or using ad hoc `screen` and `pkill` commands.

The first slice should preserve the current detached local-process model and make its runtime checkout, wrapper session, and process-tree cleanup explicit behind one CLI seam.

## Scope

- add `symphony factory start`
- add `symphony factory stop`
- add `symphony factory restart`
- add `symphony factory status`
- make those commands work from the repository root by locating the active runtime checkout under `.tmp/factory-main`
- centralize detached-session startup and process-discovery logic in checked-in code instead of operator notes or shell history
- terminate the active factory process tree, including stray `bin/symphony.ts run` and factory-owned `codex exec --dangerously-bypass-approvals-and-sandbox` children
- cover the control path with focused unit tests and a narrow integration-style process test where practical
- document the operator-facing command usage in `README.md`

## Non-goals

- replacing the detached local-process model with launchd, systemd, or another service manager
- redesigning the orchestrator, tracker lifecycle, retry policy, or status snapshot schema
- building a TUI, dashboard, or continuous log streaming surface
- supporting remote factory control
- solving runtime checkout refresh/update workflows beyond using the current checked-out `.tmp/factory-main`
- changing issue/PR handoff policy or tracker integration behavior

## Current Gaps

- the root CLI only exposes `run` and `status`; operators still have to know when to `cd .tmp/factory-main`
- detached factory startup currently depends on manual `screen` invocation and an implicit session name
- clean shutdown is manual and error-prone because killing the `screen` wrapper can leave the `pnpm`, `tsx`, `bin/symphony.ts run`, or `codex exec` processes alive
- the active runtime checkout path lives in operator notes and shell commands rather than a checked-in contract
- status is available only if the operator manually points the command at the runtime checkout that owns `.tmp/status.json`
- there is no single place to improve future pause/resume or richer control behavior

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: repo-owned operator contract that `symphony factory` controls the local runtime checkout at `.tmp/factory-main` and uses the existing detached-session operating model
  - does not belong: tracker-specific lifecycle policy or review-loop decisions
- Configuration Layer
  - belongs: resolving the repository root, runtime checkout path, workflow path, and any fixed control defaults such as the detached session name
  - does not belong: reparsing tracker payloads or embedding process-tree traversal policy inside workflow loading
- Coordination Layer
  - belongs: a small control-state read model for deciding whether the factory is running, stopped, stale, or partially orphaned
  - does not belong: orchestrator polling, retry, reconciliation, or issue handoff logic
- Execution Layer
  - belongs: starting the detached wrapper, discovering the process tree, and terminating factory-owned subprocesses cleanly
  - does not belong: tracker mutations, prompt rendering, or status formatting rules
- Integration Layer
  - belongs: shelling out to `screen`, `ps`, and the existing `pnpm tsx bin/symphony.ts ...` entrypoint as local machine integrations
  - does not belong: mixing those host-process details into tracker adapters or the orchestrator service
- Observability Layer
  - belongs: reading the existing `.tmp/status.json` snapshot from the active runtime checkout, rendering operator-facing status output, and distinguishing healthy stopped state from operator failure
  - does not belong: inventing a second status snapshot schema or coupling control behavior to `.ralph` notes

## Architecture Boundaries

### CLI / control seam

Belongs here:

- parsing `symphony factory <start|stop|restart|status>` arguments
- resolving the outer repository root versus the runtime checkout root
- mapping command results to operator-facing output and exit codes

Does not belong here:

- raw `ps` parsing
- status snapshot parsing details
- orchestrator logic

### Configuration / repo-root resolution

Belongs here:

- deriving the active runtime checkout path from the repo root
- locating the runtime `WORKFLOW.md` and status snapshot without requiring the operator to `cd`

Does not belong here:

- session management
- subtree kill logic

### Execution / process control

Belongs here:

- detached `screen` startup using the existing `pnpm tsx bin/symphony.ts run` command
- process discovery for the wrapper session, `bin/symphony.ts run`, and factory-owned runner children
- clean shutdown sequencing and escalation when a process ignores termination

Does not belong here:

- tracker reads
- status rendering
- workflow parsing beyond what is needed to launch the runtime

### Observability

Belongs here:

- reusing the existing factory status snapshot contract for `factory status`
- reporting when the wrapper is missing, when the worker PID is stale, and when stop/start actions succeed

Does not belong here:

- a second persistent control-state file for this first slice
- `.ralph/status.json` as a source of truth

### Tracker / orchestrator

Untouched except for consuming their existing public surfaces:

- tracker policy stays at the edge and should not learn about `screen` or detached process management
- orchestrator status snapshot semantics stay unchanged; control code reads them but does not redefine them

## Slice Strategy And PR Seam

This issue should stay one reviewable PR by landing one narrow operator-control slice:

1. extend the checked-in CLI with a `factory` command group
2. add a focused local control module for runtime-root resolution, process discovery, detached startup, and shutdown
3. reuse the current status snapshot for `factory status`
4. add focused tests and README usage updates

Deliberately deferred from this PR:

- runtime checkout refresh/update workflows
- pause/resume semantics distinct from stop/start
- richer logs/dashboard integration
- service-manager support
- multiple named factories or remote control

This seam is reviewable because it changes operator control only. It does not redesign orchestrator state, tracker policy, or runtime observability contracts.

## Runtime State Model

This feature is stateful enough to require an explicit control-state model, but it should remain a read model over local host-process facts plus the existing status snapshot.

### Control States

1. `stopped`
   - no active factory wrapper, worker, or runner process is present
2. `starting`
   - `factory start` has launched the detached wrapper and is waiting for the worker/status snapshot to appear
3. `running`
   - detached wrapper and live worker exist; status snapshot is readable
4. `degraded`
   - some but not all expected facts exist, for example:
   - wrapper missing but worker or runner still alive
   - wrapper present but status snapshot unreadable or stale
   - status snapshot points at dead worker PID while factory-owned descendants still exist
5. `stopping`
   - `factory stop` is terminating the wrapper and then any remaining factory-owned descendants

### Allowed Transitions

- `stopped -> starting`
- `starting -> running`
- `starting -> degraded`
- `running -> stopping`
- `running -> degraded`
- `degraded -> stopping`
- `degraded -> starting`
- `stopping -> stopped`
- `stopping -> degraded`

### Decision Facts

The control seam should decide state from:

- resolved repo root and runtime checkout path
- `screen -ls` results for the named session
- local process table matches for the runtime checkout command tree
- the existing factory status snapshot and `worker.pid`

The control seam should not depend on:

- tracker issue labels
- `.ralph/status.json`
- undocumented shell aliases

## Failure-Class Matrix

| Observed condition                                                    | Local facts available                             | Status snapshot facts available             | Expected decision                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| No screen session, no `bin/symphony.ts run`, no `codex exec` child    | process table only                                | snapshot may be absent or stale             | report `stopped`; `factory status` exits zero because idle/stopped is not an operator failure               |
| Screen session present and worker process alive                       | wrapper pid, worker pid                           | readable snapshot with matching live worker | report `running`; `factory status` mirrors current runtime status                                           |
| Screen session gone but worker or runner still alive                  | orphaned child pids                               | snapshot may still be readable              | report `degraded`; `factory stop` kills remaining descendants and exits zero on successful cleanup          |
| Screen session present but worker pid from snapshot is dead           | wrapper pid, maybe intermediate `pnpm`/`tsx` pids | readable but stale snapshot                 | report `degraded`; `factory status` exits non-zero because the operator surface found a broken runtime      |
| `factory start` finds an already running healthy factory              | wrapper and live worker already present           | readable snapshot                           | return a no-op success and print the active runtime information                                             |
| `factory start` launches screen but worker never appears              | wrapper pid may exist briefly                     | missing or unchanged snapshot               | fail the command and report startup failure with next-step guidance                                         |
| `factory stop` terminates wrapper but `codex exec` remains alive      | orphan runner pid                                 | snapshot may still show active run          | continue process-tree cleanup, escalate signal if needed, and fail only if descendants remain after timeout |
| Multiple candidate runtime checkouts or session owners are discovered | repo-root scan results conflict                   | one or more snapshots may exist             | fail loudly and require operator intervention rather than guessing                                          |

## Storage / Persistence Contract

- no new durable control-state file in this first slice
- runtime status continues to come from `.tmp/factory-main/.tmp/status.json`
- control decisions are derived from live host-process inspection plus the existing status snapshot
- any transient startup/shutdown wait logic stays in memory inside the command invocation

## Observability Requirements

- `factory status` should show the resolved runtime checkout path so operators can verify which checkout is active
- `factory status` should reuse the existing human-readable and JSON status snapshot output where possible
- `factory status` should exit non-zero only for real operator failures such as unreadable runtime metadata, broken runtime state, or ambiguous process ownership; a cleanly stopped factory should not be treated as failure
- `factory start` and `factory stop` should print concise action summaries, including session name and key PIDs when available
- logs remain owned by the existing runtime; this issue may print a minimal pointer to the runtime checkout or snapshot file, but should not introduce log streaming

## Implementation Steps

1. Add a focused factory-control module, for example under `src/cli/` or `src/factory/`, that:
   - resolves the repo root and active runtime checkout path
   - defines typed control-state snapshots
   - discovers the detached wrapper and related process tree
2. Extend `src/cli/index.ts` argument parsing to support:
   - `symphony factory start`
   - `symphony factory stop`
   - `symphony factory restart`
   - `symphony factory status`
3. Implement `factory start` by:
   - resolving the runtime checkout under `.tmp/factory-main`
   - launching the current detached `screen` session against `pnpm tsx bin/symphony.ts run`
   - waiting for a live worker or readable status snapshot
4. Implement `factory stop` by:
   - locating the wrapper session and all runtime-owned descendants
   - terminating the wrapper first
   - terminating remaining worker/runner descendants until none remain or timeout is reached
5. Implement `factory restart` as `stop` then `start`, preserving helpful summaries for no-op stop or already-running start cases
6. Implement `factory status` by:
   - resolving the runtime checkout from the repo root
   - reading the existing status snapshot when present
   - combining it with live process facts to classify `stopped`, `running`, or `degraded`
   - mapping that result to exit status
7. Add unit tests for argument parsing, runtime-root resolution, state classification, exit-code behavior, and process-discovery parsing
8. Add a narrow integration-style test for detached start/stop behavior using fixture subprocesses or a fake session/process model where practical
9. Update `README.md` with the operator-facing control commands and clarify that the root checkout controls `.tmp/factory-main`

## Tests And Acceptance Scenarios

### Unit

- `parseArgs` accepts the new `factory` subcommands and rejects invalid combinations
- repo-root resolution finds `.tmp/factory-main` from the outer checkout and does not require `cd` into the runtime
- status classification distinguishes `stopped`, `running`, and `degraded` from process facts plus snapshot facts
- `factory status` exits zero for healthy stopped and healthy running states, and non-zero for degraded or unreadable runtime states
- stop planning collects wrapper, worker, and runner pids without targeting unrelated local Codex processes

### Integration

- starting from the repo root launches the detached session against `.tmp/factory-main` and produces a readable status snapshot
- stopping from the repo root tears down the wrapper plus remaining runtime-owned descendants
- restart composes the two operations without leaving duplicate sessions

### End-to-End Operator Scenarios

1. From the outer repo root, the operator runs `symphony factory start` and the factory starts in the runtime checkout without manually changing directories.
2. While the factory is active, `symphony factory status` reports the same effective runtime information as `pnpm tsx bin/symphony.ts status` inside `.tmp/factory-main`.
3. After `symphony factory stop`, no factory-owned `bin/symphony.ts run` or `codex exec --dangerously-bypass-approvals-and-sandbox` process remains.
4. If the wrapper or worker state is broken, `symphony factory status` reports a degraded state and exits non-zero so automation can notice the operator failure.

### Repo Gate

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. Operators can use checked-in `symphony factory start|stop|restart|status` commands from the repository root instead of manual `screen` and `pkill` sequences.
2. The command surface preserves the current local operating model by controlling `.tmp/factory-main` rather than redesigning the runtime.
3. `factory stop` removes stray factory-owned runner or worker processes instead of only killing the wrapper session.
4. `factory status` reports the live runtime checkout status and treats a clean stop differently from a broken runtime.

## Exit Criteria

- the CLI exposes the four required `factory` subcommands
- commands work from the repository root against the active `.tmp/factory-main` runtime checkout
- start/stop/restart use the existing detached local-process strategy under the hood
- stop leaves no factory-owned `bin/symphony.ts run` or runner child process behind in normal operation
- status reuses the current runtime status snapshot and has clear, tested exit-code semantics
- README usage is updated and the relevant tests pass

## Deferred To Later Issues Or PRs

- service-manager integration
- multiple runtime checkouts or named environments
- pause/resume distinct from stop/start
- direct log tailing or richer dashboard surfaces
- runtime checkout refresh/update commands
- persistent operator history beyond the existing runtime status and issue-artifact contracts

## Decision Notes

- The control seam should prefer a fixed repo-owned runtime checkout contract (`.tmp/factory-main`) over trying to infer arbitrary checkouts from operator notes. That is the minimum change that removes operator memorization without inventing new runtime metadata.
- Process discovery should treat `screen` as wrapper mechanism, not source of truth. The source of truth for runtime health is the combination of live child processes plus the existing status snapshot.
- This first slice should avoid wiring `.ralph` files into production control logic. They are operator aids, not runtime contracts.
