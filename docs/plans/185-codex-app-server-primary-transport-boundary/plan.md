# Issue 185 Plan: Finish Codex App-Server As The Primary Transport Boundary

## Status

- plan-ready

## Goal

Finish the Codex runner transition from "uses app-server internally" to "treats app-server as the primary structured transport boundary" by making startup, continuation turns, approvals, unsupported protocol requests, malformed protocol input, shutdown, and transport failure classification explicit runner-layer concerns behind a stable normalized session/event contract.

## Scope

- harden the Codex app-server session boundary inside `src/runner/`
- extract or isolate protocol parsing, request/response handling, and transport-state transitions so they are not fused into one ad hoc session file
- formalize transport-level failure classes for:
  - startup / initialize failures
  - thread-start failures
  - turn-start failures
  - malformed protocol payloads
  - unsupported requests / unsupported tools
  - approval requests and approval-handling failures
  - unexpected process exit during an active request or turn
- make approval handling explicit and well-tested instead of implicit or silently ignored
- make unsupported request handling explicit and well-tested instead of relying on generic fallthrough behavior
- preserve provider-neutral runner/orchestrator boundaries by keeping the orchestrator consuming normalized events, visibility, and results rather than raw app-server messages
- tighten observability so session status surfaces clearly describe Codex app-server transport facts and transport failures in normalized form
- add focused unit and integration coverage for the transport boundary and its failure classes

## Non-goals

- SSH or other remote Codex transports
- tracker lifecycle, review-loop, or landing-policy changes
- continuation-turn policy redesign
- dynamic tool implementation beyond the minimum explicit unsupported handling needed for protocol correctness
- a new provider kind or a broad runner-contract redesign beyond the narrow Codex transport seam required here
- workspace contract redesign or recovery/lease redesign

## Current Gaps

- `src/runner/codex-app-server-session.ts` currently mixes subprocess lifecycle, request serialization, stdout line buffering, notification parsing, turn resolution, and visibility updates in one file
- the current session handles `turn/*` notifications, but protocol-level approvals and unsupported requests are not treated as first-class normalized transport decisions
- malformed startup payloads are handled more strictly than malformed in-turn payloads, but the failure taxonomy is still implicit in message strings rather than a named transport classification surface
- unexpected protocol methods mostly disappear unless they happen to map onto existing turn notifications
- current tests cover startup, malformed thread responses, malformed stream lines, unexpected response ids, timeouts, and turn failures, but they do not lock in explicit approval behavior or unsupported request behavior
- observability already publishes app-server pid/thread/turn facts, but it does not yet make transport-state transitions and transport failure classes explicit enough for future remote reuse of the same boundary

## Decision Notes

- Keep Codex app-server transport logic sealed inside `src/runner/`; do not leak app-server methods into the orchestrator.
- Treat protocol startup, approval handling, streaming, and shutdown as execution-layer transport concerns, not coordination policy.
- Prefer a small protocol/session decomposition inside the runner layer over further patching the current monolithic session file.
- Keep the public runner-facing surface normalized and provider-aware, but do not broaden this issue into a general remote transport framework.
- Unsupported protocol requests should fail or respond explicitly at the transport boundary; they must not stall the session silently.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the local abstraction mapping from `docs/architecture.md`.

- Policy Layer
  - belongs: deciding that Codex app-server is the primary transport seam for the `codex` provider and that approval / unsupported-request semantics are normalized transport behavior
  - does not belong: JSON message parsing, line buffering, subprocess I/O, or request id handling
- Configuration Layer
  - belongs: validating and deriving Codex command/runtime settings needed to start the app-server transport cleanly
  - does not belong: tracker lifecycle behavior, review policy, or transport runtime state transitions
- Coordination Layer
  - belongs: continuation-turn sequencing, retry reactions, and consuming normalized runner failures/results
  - does not belong: app-server method handling, protocol parsing, approval request decoding, or unsupported-request replies
- Execution Layer
  - belongs: app-server startup, session initialization, thread creation, turn start, approval handling, unsupported request handling, malformed protocol handling, shutdown, and transport failure classification
  - does not belong: tracker handoff policy, retry budgeting, or review-loop policy
- Integration Layer
  - belongs: unchanged in this slice; tracker adapters continue to consume normalized runner outcomes only
  - does not belong: Codex protocol details or transport-state bookkeeping
- Observability Layer
  - belongs: surfacing normalized app-server transport facts, status transitions, approvals, and transport failures for operators and artifacts
  - does not belong: reimplementing protocol parsing or reconstructing transport state from raw stdout independently

## Architecture Boundaries

### Belongs in this issue

- `src/runner/`
  - Codex app-server protocol message classification
  - request/response helpers
  - explicit transport session/state handling
  - approval and unsupported-request handling
  - transport failure classification and normalized error mapping
- `src/runner/service.ts`
  - only the minimum stable event/session/result shape updates needed to expose normalized transport facts cleanly
- `src/orchestrator/`
  - only narrow consumption updates if normalized runner visibility/session metadata gains explicit transport details
- `src/observability/`
  - only narrow updates needed to persist/render the new normalized Codex transport facts
- tests under `tests/unit/` and any targeted integration coverage needed for the Codex runner seam
- README or runner docs only where the primary Codex transport boundary needs to be clarified

### Does not belong in this issue

- tracker transport, normalization, or policy changes
- review-loop or landing-flow changes
- workspace lifecycle redesign
- remote execution or SSH transport
- dynamic tool support beyond explicit unsupported handling
- a repo-wide runner abstraction rewrite

## Layering Notes

- `config/workflow`
  - owns typed runner config and command validation
  - does not own app-server protocol negotiation or approval decisions
- `tracker`
  - owns normalized issue / PR lifecycle
  - does not learn about Codex app-server methods or approval payloads
- `workspace`
  - owns workspace preparation and local target identity
  - does not own Codex protocol I/O
- `runner`
  - owns app-server subprocess control, protocol normalization, transport-state transitions, and explicit approval / unsupported handling
  - does not decide tracker policy, retries, or follow-up lifecycle
- `orchestrator`
  - owns continuation turns, retry policy, and high-level reactions to normalized runner outcomes
  - does not parse protocol payloads or branch on raw app-server methods
- `observability`
  - owns status/artifact projection of normalized transport facts
  - does not infer transport semantics that the runner did not already normalize

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam at the Codex execution transport boundary:

1. isolate the app-server protocol/session logic inside focused `src/runner/` modules
2. formalize normalized transport-state and failure handling for the Codex session
3. expose only the minimum extra normalized facts needed by orchestrator/observability consumers
4. add transport-focused tests and minimal docs updates

This stays reviewable because it does not combine:

- Codex transport work with tracker changes
- Codex transport work with retry/reconciliation redesign
- Codex transport work with workspace or remote-execution changes
- Codex transport work with broad provider-neutral contract refactors unrelated to the Codex app-server seam

If a small structural refactor is needed first, it should remain fully inside `src/runner/` and exist only to keep the transport seam explicit and testable.

## Runtime State Model

This issue changes stateful long-lived execution behavior at the runner transport boundary, so the plan requires an explicit app-server session state machine.

### State variables

- `sessionState`
  - normalized Codex transport state for one live session
- `threadId`
  - Codex thread id created once per worker run
- `activeRequest`
  - current request awaiting a response, if any
- `activeTurn`
  - current turn in progress, if any
- `latestTurnId`
  - latest acknowledged Codex turn id
- `latestTurnNumber`
  - latest successful Symphony turn number
- `transportFailureClass`
  - normalized failure classification when the transport fails
- `closingReason`
  - normal completion, shutdown, timeout, or abort

### States

- `idle`
  - no app-server process launched
- `starting-process`
  - subprocess spawned, awaiting protocol initialization
- `initializing`
  - `initialize` request in flight
- `starting-thread`
  - initialized session, `thread/start` in flight
- `ready`
  - transport is healthy and waiting for a turn
- `starting-turn`
  - `turn/start` request in flight
- `streaming-turn`
  - turn started and protocol notifications/stream events are flowing
- `awaiting-approval`
  - transport is paused on an explicit approval request
- `turn-succeeded`
  - terminal successful turn observed
- `turn-failed`
  - terminal failure observed for the active turn or transport
- `closing`
  - shutdown/cleanup started
- `closed`
  - process fully terminated and session no longer usable

### Allowed transitions

- `idle -> starting-process`
- `starting-process -> initializing`
- `starting-process -> turn-failed`
  - process launch or immediate startup failure
- `initializing -> starting-thread`
- `initializing -> turn-failed`
  - malformed or failed initialize response
- `starting-thread -> ready`
- `starting-thread -> turn-failed`
  - malformed or failed thread-start response
- `ready -> starting-turn`
- `starting-turn -> streaming-turn`
- `starting-turn -> turn-failed`
  - malformed or failed turn-start response
- `streaming-turn -> awaiting-approval`
  - explicit approval request received
- `awaiting-approval -> streaming-turn`
  - approval response sent successfully
- `awaiting-approval -> turn-failed`
  - unsupported approval request or malformed approval payload
- `streaming-turn -> turn-succeeded`
  - `turn/completed`
- `streaming-turn -> turn-failed`
  - `turn/failed`, `turn/cancelled`, malformed terminal payload, unsupported request, or process death
- `turn-succeeded -> ready`
  - continuation turn may start on the same thread
- `turn-succeeded -> closing`
  - worker run is ending
- `turn-failed -> closing`
- `closing -> closed`

### Coordination rules

- one `thread/start` occurs per worker run; continuation turns reuse that thread
- continuation-turn budgeting remains orchestrator policy and must stay outside the transport layer
- app-server approval/unsupported handling remains runner transport behavior and must not leak into tracker or orchestrator policy
- transport failure closes the live session and returns a normalized runner failure to the existing outer retry path

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| subprocess exits before `initialize` completes | command, workspace, maybe pid, stderr | unchanged | classify as `startup-transport-failure`; close session; hand runner failure to orchestrator |
| `initialize` returns malformed payload or error | pid, raw payload | unchanged | classify as `initialize-transport-failure`; fail startup explicitly |
| `thread/start` returns malformed payload or error | pid, initialized session, raw payload | unchanged | classify as `thread-start-transport-failure`; fail session before any turn starts |
| `turn/start` returns malformed payload or error | pid, thread id, request id | unchanged | classify as `turn-start-transport-failure`; fail active turn |
| approval request is well-formed and supported | pid, thread id, active turn, approval payload | unchanged | emit normalized approval event/state, respond explicitly, continue turn |
| approval request is malformed or unsupported | pid, thread id, active turn, raw payload | unchanged | classify as `approval-transport-failure` or `unsupported-request-failure`; fail active turn without stalling |
| unsupported dynamic tool or other unsupported protocol request arrives | pid, thread id, active turn, request payload | unchanged | send explicit unsupported response when protocol allows, otherwise fail clearly; do not hang |
| non-terminal malformed stream line arrives after turn start | pid, thread id, active turn | unchanged | log and classify as non-terminal malformed stream only if the protocol can safely continue |
| terminal payload such as `turn/completed` / `turn/failed` is malformed | pid, thread id, active turn, raw payload | unchanged | classify as `malformed-terminal-payload`; fail active turn and close session |
| subprocess exits during active turn | pid, thread id, latest turn id | unchanged | classify as `active-turn-transport-failure`; fail turn; outer retry policy decides next step |
| turn times out while process is still alive | pid, thread id, active turn | unchanged | classify as `turn-timeout`; shut down transport; surface normalized timed-out runner failure |
| turn completes successfully | pid, thread id, turn id | post-turn lifecycle from tracker/orchestrator | return success; orchestration decides whether to continue |

## Observability Requirements

- record app-server process spawn, initialize success/failure, thread start, turn start, approval wait/resume, terminal turn result, and shutdown in normalized visibility/logging form
- surface transport state and failure-class information without exposing raw protocol details as the orchestrator contract
- keep app-server pid, backend thread id, latest turn id, and latest turn number inspectable in session/status surfaces
- preserve enough raw payload detail in logs for debugging malformed protocol cases without making downstream layers parse protocol JSON

## Implementation Steps

1. Refactor the Codex app-server session internals into focused runner-layer helpers for:
   - protocol line parsing and JSON decoding
   - request/response correlation
   - notification/request classification
   - explicit transport-state and failure-class mapping
2. Add explicit approval-request and unsupported-request handling in the Codex transport boundary.
3. Update the main session implementation to consume those helpers and expose normalized transport facts/events without leaking raw protocol details upward.
4. Adjust stable runner session/event/result metadata only where needed so orchestrator/observability consumers can see the new normalized transport facts.
5. Update narrow observability/status consumers if needed to render the new Codex transport facts and failures clearly.
6. Add or extend targeted tests for startup, approvals, unsupported requests, malformed payloads, turn terminal paths, timeout/shutdown, and continuation-turn reuse.
7. Update minimal docs to state that Codex uses app-server as its primary transport boundary.

## Tests And Acceptance Scenarios

### Unit tests

- successful initialize -> thread/start -> turn/start -> turn/completed flow still reuses one thread across continuation turns
- approval request handling succeeds for the supported path and resumes the active turn
- malformed approval payload fails explicitly with the expected transport classification
- unsupported request / unsupported tool handling does not stall the session and fails or responds explicitly as designed
- malformed `initialize`, `thread/start`, and `turn/start` responses classify correctly
- malformed terminal notifications fail the turn explicitly
- non-terminal malformed stream lines only continue when the protocol state is still recoverable
- process exit during startup and during an active turn classify correctly
- timeout and shutdown still clean up the app-server process

### Integration coverage

- existing Codex runner integration remains green with the refactored app-server transport
- orchestrator/status consumers still consume normalized runner output without any raw protocol branching

### Acceptance scenarios

1. A normal local Codex run starts one app-server subprocess, creates one Codex thread, completes multiple continuation turns, and surfaces normalized transport/session metadata.
2. An app-server approval request is handled explicitly and visibly at the runner boundary without involving tracker/orchestrator policy.
3. An unsupported request or malformed protocol payload fails clearly and inspectably instead of stalling or being silently ignored.
4. The orchestrator still reacts only to normalized runner outcomes and remains ignorant of raw app-server methods.

## Exit Criteria

- Codex app-server is treated in code and tests as the primary structured transport boundary for the `codex` runner
- approval handling, unsupported request handling, malformed protocol handling, and shutdown behavior are explicit and well-tested
- transport failure classes and state transitions are explicit enough to support future local or remote reuse of the same boundary
- orchestrator and tracker layers remain insulated from raw app-server protocol details

## Deferred To Later Issues Or PRs

- SSH-backed or otherwise remote Codex app-server transport reuse
- dynamic tool support beyond explicit unsupported handling
- broader remote-execution contracts beyond the narrow Codex transport seam
- continuation-turn policy changes
- tracker/review-loop/landing behavior changes
