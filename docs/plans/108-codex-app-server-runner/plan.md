# Issue 108 Plan: Spec-Aligned Codex App-Server Runner

## Status

- plan-ready

## Goal

Replace the current Codex `exec` / `exec resume` continuation transport with a spec-aligned long-lived `codex app-server` subprocess that performs `initialize`, `thread/start`, and `turn/start` once per worker-run session boundary, while keeping continuation policy and tracker lifecycle handling in the orchestrator.

## Scope

- add a Codex app-server transport implementation that launches one long-lived `codex app-server` subprocess for one worker run
- implement the session protocol boundary for:
  - startup handshake (`initialize` / `initialized`)
  - `thread/start`
  - `turn/start`
  - turn completion and failure notifications
  - process shutdown on run completion, failure, abort, timeout, or cancellation
- keep one Codex thread alive across continuation turns within the same worker run
- preserve the existing continuation-turn orchestrator policy from `#99`, but route it through the app-server live session instead of `codex exec resume`
- project app-server process pid, Codex thread id, turn id, and derived session identity into the existing run/session observability surfaces
- add unit and integration coverage for startup, continuation turns, malformed protocol messages, turn failures, max-turn exhaustion, and shutdown/cleanup
- document how the app-server path relates to the prior CLI-resume implementation for `agent.runner.kind: codex`

## Non-goals

- runner-selection UX or config surface expansion from `#90`
- Claude Code changes from `#91`
- tracker transport, normalization, or handoff-policy changes
- remote/background worker lifecycle from `#15`
- a provider-neutral redesign beyond the execution-layer seam already introduced in `#89`
- changing continuation-turn policy semantics from `#99` except where the transport contract requires explicit handling

## Current Gaps

- `src/runner/local-live-session.ts` currently models Codex continuity by rebuilding a fresh subprocess command for each turn and using `codex exec resume <session-id>` for continuation turns
- `src/runner/codex-resume-command.ts` and `src/runner/codex-session-discovery.ts` are transport-specific workarounds for the lack of a live app-server session
- `src/runner/service.ts` exposes a live session contract, but it does not yet distinguish app-server process ownership, thread identity, or transport-level turn notifications
- `src/runner/local-execution.ts` assumes a one-command-per-turn execution shape rather than a long-lived stdout protocol stream
- orchestrator continuation logic already exists in `src/orchestrator/service.ts` and `src/orchestrator/continuation-turns.ts`, but its session metadata still reflects CLI-resume semantics instead of explicit `thread/start` / `turn/start`
- tests cover continuation via reused backend session id, but not an app-server handshake, line-buffered protocol parsing, malformed stdout handling, or explicit app-server shutdown

## Decision Notes

- For `agent.runner.kind: codex`, this issue should replace the current `exec/resume` path with an app-server-native live session rather than introduce a second user-facing selection knob.
- The legacy CLI-resume helpers may remain temporarily as internal code only if needed to preserve a reviewable migration seam, but they should no longer be the primary Codex execution path after this PR.
- The existing continuation-turn orchestration from `#99` stays intact. This issue swaps the execution transport, not the coordination policy.
- The app-server client should use the concrete protocol shapes exposed by the installed Codex CLI generator and stay close to `SPEC.md` section 10.2 / 10.3 semantics instead of inventing a local pseudo-protocol.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: deciding that Codex continuation in `symphony-ts` is app-server-native for the `codex` runner and that continuation prompts remain lightweight
  - does not belong: JSON line parsing, request ids, or subprocess stdio management
- Configuration Layer
  - belongs: validating the Codex launch command shape and any app-server-specific defaults that remain internal to the runner
  - does not belong: tracker reconciliation or app-server event interpretation
- Coordination Layer
  - belongs: deciding whether another turn should run after each successful turn, enforcing `agent.max_turns`, and reacting to runner failures/timeouts
  - does not belong: constructing `thread/start` requests or parsing `turn/completed`
- Execution Layer
  - belongs: launching `codex app-server`, handshake/request sequencing, stdout/stderr handling, turn streaming, and process cleanup
  - does not belong: tracker lifecycle policy or issue handoff decisions
- Integration Layer
  - belongs: unchanged tracker reads/writes already used to derive normalized handoff lifecycle after each turn
  - does not belong: Codex protocol transport or process state
- Observability Layer
  - belongs: recording app-server pid, thread id, turn id, derived backend session identity, and normalized protocol events useful to operators
  - does not belong: deducing tracker policy or reconstructing raw protocol state from logs

## Architecture Boundaries

### Belongs in this issue

- `src/runner/service.ts`
  - extend the live-session metadata and event/result surface only as needed for app-server session identity and process ownership
- `src/runner/`
  - add focused Codex app-server client modules for request serialization, line-buffered protocol parsing, event normalization, and process/session lifecycle
  - update `CodexRunner` to start an app-server-backed live session for both first turn and continuation turns
- `src/orchestrator/service.ts`
  - consume the updated live-session metadata without taking on transport parsing logic
- `src/observability/`
  - persist the normalized app-server session/thread metadata already resolved by the runner
- tests
  - add protocol-focused unit tests and runner/orchestrator integration coverage for the new transport
- docs
  - make the replacement/coexistence status of the CLI-resume path explicit

### Does not belong in this issue

- new tracker states, tracker comments, or tracker normalization changes
- new runner kind or workflow selection UX
- review-loop policy redesign
- remote app-server execution
- generic transport abstractions for every future provider beyond the narrow runner seam this issue needs

## Layering Notes

- `config/workflow`
  - owns runner-kind and command validation
  - does not own app-server lifecycle or handshake retries
- `tracker`
  - continues to normalize issue / PR lifecycle state
  - does not gain knowledge of Codex thread ids or turn ids
- `workspace`
  - continues to prepare one workspace reused across the worker run
  - does not manage app-server protocol messages
- `runner`
  - owns app-server subprocess lifecycle, request/response sequencing, and normalized turn results
  - does not decide whether follow-up lifecycle is actionable
- `orchestrator`
  - owns continuation-turn sequencing and budget enforcement
  - does not parse raw stdout lines from Codex
- `observability`
  - records normalized session facts emitted by runner/orchestrator
  - does not independently infer thread/turn state from raw logs

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by limiting the seam to the Codex execution transport under the existing `codex` runner:

1. add a focused app-server transport client and live-session implementation in `src/runner/`
2. switch the existing `CodexRunner` to that transport
3. update orchestrator and observability consumers only where the new normalized session metadata requires it
4. add transport-focused tests and documentation

This keeps the PR reviewable because it does not combine:

- app-server transport with tracker policy changes
- app-server transport with runner-selection UX
- app-server transport with a provider-neutral redesign
- app-server transport with remote-worker lifecycle work

If a small compatibility layer is needed during migration, it should stay inside `src/runner/` and not leak a second execution model into orchestration policy.

## Runtime State Model

This issue changes stateful long-lived execution behavior and therefore needs an explicit runner-session state model layered beneath the existing orchestrator continuation loop.

### State variables

- `runSessionId`
  - existing Symphony worker-run session id
- `turnNumber`
  - current turn within one worker run
- `threadId`
  - Codex app-server thread id created once per worker run
- `turnId`
  - Codex app-server turn id for the active or latest turn
- `codexAppServerPid`
  - local subprocess pid when available
- `maxTurns`
  - existing per-run continuation budget enforced by orchestrator

### App-server session states

- `idle`
  - no subprocess launched yet
- `starting-process`
  - app-server subprocess spawned, handshake not complete
- `starting-thread`
  - `initialize` / `initialized` completed and `thread/start` is in flight
- `ready`
  - thread established and waiting for the next turn
- `starting-turn`
  - `turn/start` sent and awaiting turn id response
- `streaming-turn`
  - stdout protocol stream is active for the current turn
- `turn-succeeded`
  - `turn/completed` observed
- `turn-failed`
  - `turn/failed`, `turn/cancelled`, timeout, malformed terminal response, or subprocess exit observed
- `closing`
  - shutdown initiated, process drain/cleanup in progress
- `closed`
  - subprocess fully terminated and session cannot run further turns

### Allowed transitions

- `idle -> starting-process`
- `starting-process -> starting-thread`
- `starting-process -> turn-failed`
  - startup or handshake failure
- `starting-thread -> ready`
- `starting-thread -> turn-failed`
  - invalid or failed `thread/start`
- `ready -> starting-turn`
- `starting-turn -> streaming-turn`
- `starting-turn -> turn-failed`
  - invalid `turn/start` response
- `streaming-turn -> turn-succeeded`
  - terminal `turn/completed`
- `streaming-turn -> turn-failed`
  - terminal failure/cancelled, timeout, malformed terminal response, or process death
- `turn-succeeded -> ready`
  - same thread reused for next turn
- `turn-succeeded -> closing`
  - worker run ending
- `turn-failed -> closing`
- `closing -> closed`

### Coordination rules

- `thread/start` runs once per worker run and its `threadId` is reused for every continuation turn in that run
- turn 1 uses the full initial prompt; turn 2+ use continuation guidance only
- orchestration still decides whether to continue after each successful turn based on normalized tracker lifecycle and `agent.max_turns`
- runner transport failure closes the live session and hands control back to the existing outer failure/retry path
- exhausting `agent.max_turns` is still an orchestration outcome, not a transport failure

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| `codex app-server` process fails before `initialize` response | workspace path, command, maybe pid | unchanged | fail runner startup, record startup failure, outer retry policy decides next step |
| `initialize` succeeds but `thread/start` response is malformed or missing nested thread id | pid, stdout payload, no thread id | unchanged | treat as runner failure, close subprocess, do not attempt continuation |
| first `turn/start` succeeds and `turn/completed` arrives | pid, thread id, turn id | post-turn lifecycle from tracker | existing orchestrator continuation policy decides continue / wait / complete |
| continuation turn succeeds on same thread | same pid, same thread id, new turn id | actionable follow-up or terminal/waiting lifecycle | continue or stop according to existing policy |
| stdout emits malformed non-terminal JSON line during stream | pid, raw line, active thread/turn ids | unchanged until successful turn end | log malformed diagnostic and continue streaming unless terminal parsing becomes impossible |
| stdout emits malformed terminal payload for `turn/completed` / `turn/failed` semantics | pid, raw line, active turn | unchanged | treat as runner failure, close subprocess, keep state inspectable |
| subprocess exits while turn is in flight | pid, exit status, active thread/turn ids | unchanged | runner failure, close session, outer retry path |
| turn times out while process stays alive | pid, active thread/turn ids | unchanged | interrupt or stop subprocess if supported, mark runner failure, cleanup before returning |
| worker abort/shutdown arrives during active turn | abort signal, pid, active thread/turn ids | unchanged | stop session promptly, clean subprocess, surface aborted run |
| actionable follow-up remains after `agent.max_turns` | healthy session metadata, latest successful turn | actionable lifecycle | orchestrator records explicit max-turn exhaustion outcome; runner closes cleanly |

## Storage / Persistence Contract

- keep the existing Symphony run-session id as the canonical worker-run identifier
- extend runner session metadata to record:
  - `backendSessionId`
    - derived inspectable identity, expected to be `<threadId>-<latestTurnId>` or equivalent normalized form
  - `threadId`
  - `latestTurnId`
  - `codexAppServerPid`
- issue artifacts and status snapshots should persist normalized session facts, not raw protocol payloads
- any artifact schema additions should be backward-compatible for existing report/status readers where practical

## Observability Requirements

- log app-server process start, thread creation, turn start, turn completion/failure, and clean shutdown
- surface app-server pid, Codex thread id, and latest turn id in issue artifacts and any existing session description surfaces that already expose backend session metadata
- preserve enough raw protocol context in logs to debug malformed responses without making observability code parse protocol JSON itself
- failure messages should clearly distinguish:
  - startup handshake failure
  - malformed protocol payload
  - turn timeout / cancellation
  - orchestration max-turn exhaustion

## Implementation Steps

1. Define focused app-server protocol/client helpers under `src/runner/`:
   - request id constants / builders
   - stdout line buffering and JSON parsing
   - response matching for `initialize`, `thread/start`, and `turn/start`
   - notification classification for `turn/completed`, `turn/failed`, `turn/cancelled`, and useful progress events
2. Add an app-server-backed live session implementation for Codex that:
   - launches `codex app-server`
   - performs the startup handshake once
   - reuses one `threadId`
   - runs multiple turns on the same subprocess
   - shuts down cleanly on normal completion and abnormal termination
3. Update `CodexRunner` to use the app-server live session for first turn and continuation turns.
4. Remove `codex exec resume` from the primary Codex path and either delete or explicitly demote the legacy CLI-resume helpers so the relationship is clear in code.
5. Update runner session description / observability persistence to include app-server pid and thread/turn identity.
6. Keep orchestrator continuation logic transport-agnostic, updating only the metadata plumbing it consumes.
7. Add tests for protocol parsing, session lifecycle, orchestrator integration, and max-turn exhaustion on the new transport.
8. Update README and any runner docs to state that `agent.runner.kind: codex` now uses `codex app-server` rather than `codex exec resume`, and note any residual coexistence if internal compatibility code remains.

## Tests And Acceptance Scenarios

### Unit tests

- app-server startup handshake sends `initialize`, `initialized`, `thread/start`, then `turn/start` in order
- `thread/start` extracts nested `thread.id` and stores it for continuation turns
- continuation turns send another `turn/start` on the same live thread and do not rerun `thread/start`
- malformed stdout line handling buffers partial lines and ignores/logs non-terminal malformed lines without crashing the stream
- malformed startup or terminal payloads fail explicitly and clean up the subprocess/session
- timeout, cancellation, and subprocess-exit cases produce runner failures and cleanup
- runner session description exposes normalized `backendSessionId`, `threadId`, `latestTurnId`, and pid metadata

### Integration tests

- orchestrator first turn on the Codex runner starts one app-server session, completes one turn, and records session metadata
- orchestrator actionable follow-up path performs continuation turns on the same thread/process
- orchestrator max-turn exhaustion remains explicit and does not get conflated with transport failure
- shutdown/abort path closes the app-server subprocess and leaves inspectable artifacts

### Acceptance scenarios

1. A worker run starts Codex through `codex app-server`, performs the startup handshake, and completes the first turn successfully.
2. After actionable follow-up is detected, the same worker run sends continuation guidance through another `turn/start` on the same `threadId` without spawning a fresh Codex subprocess.
3. If the app-server returns malformed startup or terminal data, Symphony fails the run explicitly and cleans up the subprocess instead of silently cold-starting a replacement turn.
4. If actionable work remains after `agent.max_turns`, the run records explicit exhaustion while still shutting down the app-server session cleanly.
5. Issue artifacts and status surfaces identify the live app-server-backed session by pid/thread/turn metadata.

## Exit Criteria

- `agent.runner.kind: codex` runs through a long-lived `codex app-server` subprocess for one worker run
- continuation turns reuse the same app-server process and `threadId`
- startup handshake, turn completion/failure handling, and shutdown are explicit and tested
- observability surfaces expose normalized app-server session/thread identity
- docs clearly state whether the CLI-resume path was replaced or remains only as internal compatibility code
- the change remains one reviewable PR centered on the execution-layer seam

## Deferred To Later Issues Or PRs

- workflow-level UX for selecting between multiple Codex transport strategies, if ever needed
- remote or background app-server lifecycle
- richer provider-neutral streaming event contracts for non-Codex backends
- tracker/status UX improvements beyond the narrow metadata additions required here
- any follow-up cleanup to fully remove legacy CLI-resume code if a temporary compatibility layer is retained in this PR

## References

- `docs/plans/099-runner-continuation-turn-loop/plan.md`
- `docs/plans/089-provider-neutral-runner-contract/plan.md`
- `/Users/jessmartin/Documents/code/symphony/SPEC.md`
- `/Users/jessmartin/Documents/code/symphony/elixir/WORKFLOW.md`
- `/Users/jessmartin/Documents/code/symphony/elixir/lib/symphony_elixir/codex/app_server.ex`

## Revision Notes

- 2026-03-12: Initial plan created for issue `#108`. Narrows the slice to replacing the current Codex `exec/resume` transport with an app-server-native live session under the existing `codex` runner seam.
