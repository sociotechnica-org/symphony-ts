# Issue 187 Plan: Add SSH Stdio Transport For Remote Codex App-Server Sessions

## Status

- plan-ready

## Goal

Add the first real remote execution transport by launching one `codex app-server` session over SSH stdio on a selected worker host, while keeping the Symphony orchestrator local and preserving the existing runner, continuation-turn, lease, and reconciliation contracts introduced by `#182`, `#183`, `#184`, and `#185`.

The resulting slice should let one worker run:

- choose a configured remote worker host,
- prepare or reuse a remote execution workspace on that host,
- start Codex app-server remotely over SSH stdio,
- keep all continuation turns on the same remote host and workspace for that worker run,
- and surface the remote host plus remote session identity through status and artifacts.

## Scope

- add typed workflow config for remote worker-host selection and SSH-backed Codex remote execution
- extend the workspace layer with a concrete remote SSH workspace-preparation path that can create or reuse a per-issue remote checkout on one configured host
- add a Codex SSH stdio live-session transport that speaks the existing app-server protocol over an SSH subprocess instead of a local child process in the workspace
- keep one remote workspace target and one Codex thread pinned across continuation turns for the lifetime of a worker run
- thread remote host and remote session identity through execution-owner, status, and issue-artifact observability
- add focused unit/integration coverage plus at least one end-to-end mocked remote-host workflow
- document the new workflow config and operating constraints in README and any directly relevant runtime docs

## Non-goals

- multi-host scheduling, load balancing, or remote-worker pools with dynamic selection policy beyond one explicit configured host per run
- tracker transport, normalization, or lifecycle-policy changes
- redesigning retry budgets, follow-up budgets, review-loop policy, or landing policy
- hosted remote task backends, agent daemons, SSH connection multiplexers, or a generalized remote command framework for every runner
- cross-host lease ownership transfer or remote process recovery beyond the existing transport-aware ownership model
- remote workspace retention policy beyond the minimum behavior required for this slice

## Current Gaps

- `src/domain/workflow.ts` and `src/config/workflow.ts` do not expose any typed worker-host or remote-execution configuration.
- `src/workspace/local.ts` is still the only concrete workspace manager, so the `remote` workspace target in `src/domain/workspace.ts` is currently inert.
- `src/runner/codex.ts` always creates `CodexAppServerSession`, and `src/runner/codex-app-server-session.ts` always spawns a local `codex app-server` child process against a local workspace path.
- `src/runner/local-execution.ts` and `src/runner/local-session-description.ts` still assume local execution as the only concrete subprocess boundary.
- Coordination and observability already carry transport-aware execution-owner metadata, but no concrete runner currently emits a real `remote-stdio-session` with a real remote workspace host.
- Current tests lock in remote-capable contract shapes, but they do not prove that an SSH-backed remote Codex session can start, continue, and publish remote host/session identity through the normal orchestration flow.

## Decision Notes

- Keep this issue as one execution-layer slice: one concrete remote backend for the existing `codex` provider, not a repo-wide remote-runner abstraction rewrite.
- Reuse the Codex app-server protocol boundary from `#185`. The new transport should swap the underlying stdio carrier from local child stdio to SSH stdio, not fork a second protocol surface.
- Keep remote-host choice explicit in config and explicit in the prepared workspace target. The orchestrator should not infer host selection from ad hoc command strings.
- Keep continuation-turn pinning as execution/session state, not tracker policy. One worker run gets one selected host, one prepared remote workspace, and one reusable Codex thread unless the run fails terminally.
- Keep remote workspace preparation in the workspace layer, not embedded inside the Codex runner, so the runner consumes a normalized remote target rather than inventing its own host/path model.
- Do not broaden this slice into generic remote support for Claude or generic-command runners.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule that remote Codex execution happens through explicit worker-host config, a remote prepared workspace target, and an SSH stdio transport that preserves one host/workspace/thread per worker run
  - does not belong: SSH subprocess argument construction, git commands, protocol parsing, or tracker writes
- Configuration Layer
  - belongs: parsing and validating worker-host configuration, remote execution selection, SSH options, and any required remote workspace-root defaults
  - does not belong: live host selection state, remote git workspace mutation, or app-server runtime events
- Coordination Layer
  - belongs: consuming normalized remote execution-owner facts, preserving continuation turns on the existing live session, and reacting to remote transport failures through existing retry/reconciliation paths
  - does not belong: SSH command composition, remote filesystem setup, or Codex protocol handling
- Execution Layer
  - belongs: remote workspace preparation, SSH stdio process/session transport, local SSH subprocess lifecycle, normalized remote transport metadata, and remote-host-pinned live-session behavior
  - does not belong: tracker handoff policy or landing/review decisions
- Integration Layer
  - belongs: unchanged in this slice; tracker adapters continue consuming normalized runner outcomes only
  - does not belong: worker-host configuration, SSH transport details, or remote workspace semantics
- Observability Layer
  - belongs: surfacing selected remote worker host, remote workspace identity, remote session/thread facts, and SSH-backed transport kind in status/artifacts/logging
  - does not belong: inventing transport semantics that the workspace or runner did not already normalize

## Architecture Boundaries

### `src/config/`

Owns:

- typed workflow parsing for remote worker hosts and runner-side remote execution selection
- validation that the configured remote execution shape is internally coherent

Does not own:

- host scheduling state
- SSH process management
- remote workspace creation

### `src/domain/workspace.ts` and `src/workspace/`

Own:

- a concrete remote workspace target/source shape for one SSH worker host
- preparation and cleanup of the per-issue remote checkout/workspace identity
- explicit workspace host/path/workspace-id facts used later by the runner and observability

Do not own:

- Codex protocol requests
- tracker policy
- remote transport session state

### `src/runner/`

Owns:

- the SSH stdio carrier for Codex app-server
- reusing the existing Codex app-server protocol/session logic across local and remote stdio carriers
- normalized `remote-stdio-session` transport metadata, including remote host/session identity where available

Does not own:

- workspace selection policy
- tracker mutations
- retry or continuation budgeting

### `src/orchestrator/`

Owns:

- passing the prepared remote workspace through the run session
- keeping the current live session for continuation turns
- persisting normalized remote execution-owner metadata already emitted by workspace and runner layers

Does not own:

- SSH command generation
- remote workspace bootstrapping details
- Codex app-server protocol parsing

### `src/observability/`

Owns:

- rendering and persisting remote worker-host, workspace-target, and remote transport/session metadata

Does not own:

- remote state transitions
- recovery policy

## Layering Notes

- `config/workflow`
  - resolves worker-host and remote-execution settings explicitly
  - does not become a place to stash live chosen-host/session state
- `tracker`
  - remains unchanged
  - does not learn about SSH, hostnames, or remote workspace paths
- `workspace`
  - owns how a remote checkout is prepared and identified
  - does not own Codex app-server stdio behavior
- `runner`
  - owns how to speak Codex app-server over SSH stdio against a prepared remote workspace target
  - does not choose which issue runs on which host
- `orchestrator`
  - owns continuation sequencing and failure handling using normalized session facts
  - does not reconstruct remote host/path semantics from raw strings
- `observability`
  - owns clear projection of remote execution facts
  - does not become the source of truth for remote-session state

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one remote-execution seam:

1. add typed worker-host config and remote execution selection for Codex
2. add one concrete SSH-backed remote workspace manager path for prepared workspaces
3. add one concrete SSH stdio transport for Codex app-server using the existing protocol/session boundary
4. update observability and tests so remote host/session identity is inspectable end to end

Deferred from this PR:

- generic remote transports for other runners
- multi-host scheduling policy
- remote cancellation/recovery beyond what the existing transport-aware ownership contract already supports
- non-SSH remote transports
- remote worker pools or long-lived remote agents

This seam remains reviewable because it stays inside config/workspace/runner/observability plus narrow orchestration plumbing. It does not combine tracker work, retry-state redesign, or broad provider-neutral transport refactoring.

## Runtime State Model

This issue adds stateful remote execution behavior that depends on continuation turns staying on one host/workspace/session. The plan therefore requires an explicit execution-layer state machine.

### State variables

- `selectedHost`
  - validated worker host chosen from workflow config for the run
- `preparedWorkspace`
  - normalized prepared workspace target for that host
- `sshTransportState`
  - local SSH subprocess / stdio carrier lifecycle
- `codexSessionState`
  - existing app-server session state from the Codex transport boundary
- `backendThreadId`
  - one Codex thread id reused for continuation turns
- `turnNumber`
  - current Symphony turn number within the worker run

### States

1. `selecting-host`
   - config has been resolved and the worker host for this run is being chosen
2. `preparing-remote-workspace`
   - remote checkout/workspace path is being created or refreshed on the selected host
3. `remote-workspace-ready`
   - normalized remote workspace target is ready for execution
4. `starting-ssh-transport`
   - local SSH subprocess is starting and binding stdio to the remote app-server command
5. `initializing-session`
   - Codex app-server protocol initialization and thread start are in flight over SSH stdio
6. `ready`
   - one live remote Codex thread exists and can accept a turn
7. `running-turn`
   - a turn is executing over the live SSH stdio transport
8. `waiting`
   - the live remote session is healthy but paused on an external boundary such as approval or review wait
9. `turn-complete`
   - a turn completed successfully and the same host/workspace/thread remain available
10. `failed`

- remote workspace preparation, SSH transport, or Codex app-server failed

11. `closing`

- the live session is shutting down and cleanup is running

12. `closed`

- no reusable remote session remains for the run

### Allowed transitions

- `selecting-host -> preparing-remote-workspace`
- `preparing-remote-workspace -> remote-workspace-ready`
- `preparing-remote-workspace -> failed`
- `remote-workspace-ready -> starting-ssh-transport`
- `starting-ssh-transport -> initializing-session`
- `starting-ssh-transport -> failed`
- `initializing-session -> ready`
- `initializing-session -> failed`
- `ready -> running-turn`
- `running-turn -> waiting`
- `running-turn -> turn-complete`
- `running-turn -> failed`
- `waiting -> running-turn`
- `waiting -> turn-complete`
- `waiting -> failed`
- `turn-complete -> ready`
  - continuation turn on the same host/workspace/thread
- `turn-complete -> closing`
- `failed -> closing`
- `closing -> closed`

### Contract rules

- one worker run selects one configured host and must not silently migrate to another host mid-run
- one worker run prepares one remote workspace target and all continuation turns use that same target
- one worker run reuses one live Codex thread when continuation turns continue after a successful turn
- remote workspace facts must come from the workspace layer, not be reconstructed from SSH command strings in the runner
- the orchestrator continues to react only to normalized runner/workspace metadata; it does not branch on raw SSH output

## Failure-Class Matrix

| Observed condition                                                                    | Local facts available                                                | Normalized execution facts available                                  | Expected decision                                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Remote worker host config is missing or malformed                                     | resolved workflow config                                             | no valid host selection                                               | fail config resolution before dispatch                                                                             |
| Selected host is valid but remote workspace bootstrap command fails                   | selected host, SSH stderr                                            | remote workspace target not ready                                     | fail the run before runner startup; existing retry policy handles the attempt outcome                              |
| Remote workspace prepares successfully                                                | selected host, remote path/workspace id                              | `workspace.target.kind=remote` with host/workspace identity           | continue into SSH app-server startup                                                                               |
| SSH subprocess starts but cannot connect/authenticate                                 | local SSH pid, stderr                                                | `transport=remote-stdio-session` may be partial or absent             | classify as runner startup failure; no local workspace fallback                                                    |
| SSH stdio comes up and Codex initializes/thread-start succeeds                        | local SSH pid                                                        | `transport=remote-stdio-session`, remote host, backend thread id      | persist remote execution-owner metadata and run the turn                                                           |
| Turn completes and continuation is required                                           | same selected host, same remote workspace target, live session state | same remote target and backend thread id                              | reuse the existing live session for the next turn                                                                  |
| SSH transport dies during an active turn                                              | local SSH pid exited, stderr                                         | remote host and backend thread may already be known                   | fail the turn and let existing retry policy decide; do not silently cold-start on another host within the same run |
| Restart recovery sees remote execution ownership with no local remote process control | persisted execution owner                                            | `transport=remote-stdio-session`, remote host/workspace/session facts | use existing remote-capable recovery path; do not invent local kill semantics                                      |
| Status/artifact readers load a remote run snapshot                                    | snapshot JSON                                                        | remote workspace target and `remote-stdio-session` transport facts    | render remote host/session identity cleanly without assuming local workspace path or runner pid                    |

## Storage / Persistence Contract

- reuse the existing execution-owner schema from `#184`
- ensure remote runs persist:
  - `transport.kind = remote-stdio-session`
  - remote worker host identity through workspace endpoint metadata
  - remote workspace id/path hint from the prepared workspace target
  - backend session/thread identity from the Codex session description
- keep local SSH subprocess pid, if any, as optional local control metadata only when it is safe and meaningful
- status and issue-artifact snapshots must remain parseable for existing local runs while adding the new remote fields

## Observability Requirements

- active issue status must show the remote worker host when the workspace target is remote
- runner/session status must distinguish `remote-stdio-session` from local Codex app-server transports
- issue artifacts must retain remote host, workspace identity, backend session/thread ids, and any local SSH control pid separately
- structured logs for remote startup failures should identify the selected host and remote workspace path/workspace id without requiring raw SSH command inspection

## Implementation Steps

1. Extend `src/domain/workflow.ts` and `src/config/workflow.ts` with typed remote worker-host / Codex remote-execution config and validation.
2. Add execution-layer domain helpers for remote worker-host identity and any SSH options that should be normalized before runtime use.
3. Implement a concrete remote workspace preparation path under `src/workspace/` that:
   - selects the configured host
   - creates or refreshes a per-issue remote checkout/workspace
   - returns a `PreparedWorkspace` with `target.kind = remote`
4. Refactor the Codex app-server session boundary so the protocol logic can run over either:
   - local child stdio, or
   - an SSH-backed stdio carrier
5. Implement the SSH stdio carrier and wire `CodexRunner` to choose it when the prepared workspace target is remote and the config selects remote Codex execution.
6. Ensure live-session descriptions emit normalized remote transport metadata and backend thread/session identity.
7. Update orchestration plumbing only as needed so continuation turns reuse the existing remote live session and persist the correct execution-owner/session facts.
8. Update status and issue-artifact projection/parsing to render remote host/workspace/session details clearly.
9. Add focused tests for config parsing, remote workspace preparation, SSH transport/session behavior, orchestration continuation pinning, and status/artifact parsing.
10. Add or update README/runtime docs for remote Codex worker-host configuration and operational constraints.

## Tests And Acceptance Scenarios

### Unit tests

- workflow parsing accepts valid remote worker-host config and rejects malformed host/SSH settings
- remote workspace preparation returns a normalized remote target with host/workspace identity
- Codex SSH session emits `remote-stdio-session` transport metadata and backend thread identity on successful startup
- continuation turns reuse the same selected host, prepared workspace target, and backend thread id
- status and issue-artifact parsers render remote host/session facts without assuming a local workspace path

### Integration tests

- mocked SSH remote workspace bootstrap succeeds and the runner executes Codex app-server over the SSH stdio carrier
- startup failure, SSH auth/connection failure, and mid-turn SSH drop classify as runner failures without corrupting the workspace/ownership contract

### End-to-end coverage

- one orchestrator run against mocked remote-host helpers:
  - claims the issue
  - prepares a remote workspace
  - starts remote Codex app-server over SSH stdio
  - completes at least one continuation turn on the same remote host/workspace/thread
  - publishes status/artifact snapshots with remote host/session identity

### Acceptance scenarios

1. A configured remote Codex worker host executes one worker run entirely over SSH stdio while the local orchestrator remains in control.
2. When a second turn is needed, Symphony reuses the same remote host, remote workspace target, and Codex thread instead of re-selecting a host or creating a new session.
3. If remote startup or SSH transport fails, the run fails through the normal runner/orchestrator failure path without tracker-policy changes or hidden local fallback.
4. Operator-facing status and artifacts identify the remote host and remote session/thread facts distinctly from local pid-based metadata.

## Exit Criteria

- remote Codex execution can be selected through checked-in workflow config
- a remote prepared workspace target is real, not just a type placeholder
- Codex app-server can run over SSH stdio against that remote workspace
- continuation turns stay pinned to one remote host/workspace/thread for the worker run
- execution-owner, status, and artifact surfaces expose remote host/session identity cleanly
- local behavior remains green for existing local Codex runs
- relevant unit, integration, and end-to-end tests pass

## Deferred To Later Issues Or PRs

- generic remote execution for Claude Code and generic-command runners
- dynamic host scheduling or worker pools
- remote cancellation/recovery RPC beyond current transport-aware local safety rules
- remote workspace retention policy refinement and cleanup hardening
- non-SSH remote transports or hosted remote backends

## Decision Log

- 2026-03-19: Initial draft for issue `#187`. Keeps the seam at one concrete remote Codex backend over SSH stdio and avoids mixing tracker changes or a repo-wide remote-runner redesign into the same PR.
