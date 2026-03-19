# Issue 186 Plan: Add Codex Dynamic-Tool Support For Tracker-Native Client-Side Tools

## Status

- plan-ready

## Goal

Add the first explicit dynamic-tool path for Codex app-server sessions so Symphony can advertise one tracker-native client-side tool, execute it through a focused runner-side tool boundary, return normalized results to Codex, and reject unsupported dynamic-tool requests without stalling the live session.

## Scope

- extend the Codex app-server startup/session path to advertise a minimal dynamic-tool surface to the connected Codex client
- introduce a focused dynamic-tool executor boundary inside `src/runner/` rather than embedding tracker calls directly in the app-server session class
- add one read-only tracker-native tool as the first shipped surface
- normalize tool success and failure payloads before returning them to Codex
- keep tool-request observability explicit in runner visibility/logging and issue artifacts
- reject unsupported tool names, malformed tool-call payloads, and unsupported interactive tool flows clearly without hanging the session
- preserve existing approval handling, turn streaming, and tracker orchestration semantics outside the dynamic-tool seam

## Non-goals

- arbitrary shell access or repository-local file tools exposed through dynamic tools
- a general plugin framework for arbitrary client-side tools
- tracker lifecycle or review/landing policy changes
- broad prompt-contract redesign
- remote Codex app-server execution
- write-capable tracker tools
- multi-tool bundles beyond the first reviewable tracker-native slice

## Current Gaps

- `src/runner/codex-app-server-session.ts` currently treats `item/tool/call` as an unsupported request and fails the turn immediately
- the runner has no dedicated tool-execution boundary; any future dynamic-tool work would otherwise force tracker access directly into the app-server session transport class
- the existing `Tracker` interface is oriented around orchestration control actions, not on-demand read-only tool queries for an active agent turn
- tracker sanitization already exists for prompt summaries in `src/tracker/prompt-context.ts`, but there is no reusable normalized tracker-tool result contract that keeps runtime tool output aligned with the repo trust boundary
- observability humanizes dynamic-tool events in the TUI, but the runner does not yet produce successful dynamic-tool call results or normalized tool-failure summaries
- test coverage locks in unsupported-request failure behavior for `item/tool/call`, but there is no coverage for successful dynamic-tool advertisement, execution, or normalized result serialization

## Decision Notes

- Keep the transport seam in `src/runner/`: Codex protocol parsing, request dispatch, tool-call response writing, and in-turn failure handling remain runner concerns.
- Introduce a separate read-only tracker tool service instead of expanding the orchestration `Tracker` interface with ad hoc tool semantics.
- Reuse repository-owned tracker normalization rules for tool output so the first tool does not become a loophole around the prompt trust boundary.
- Keep the first tool narrow and high-leverage: read-only tracker context for the current issue/branch/PR state, not arbitrary issue search or mutation.
- Unsupported or malformed dynamic-tool requests must respond explicitly and terminate the active tool request path without leaving the live session hanging.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the local abstraction mapping from `docs/architecture.md`.

- Policy Layer
  - belongs: deciding that Symphony exposes an explicit tracker-native dynamic-tool seam to Codex and that the first tool is read-only and trust-boundary-aware
  - does not belong: JSON-RPC request parsing, schema validation, or tracker transport calls
- Configuration Layer
  - belongs: deriving any fixed runner-side dynamic-tool advertisement shape and validating that only supported Codex sessions opt into it
  - does not belong: tracker query execution, tool-call result formatting, or orchestration state transitions
- Coordination Layer
  - belongs: unchanged in this slice; orchestration still reacts only to normalized runner outcomes and tracker handoff state
  - does not belong: raw tool-call protocol handling, tracker-tool response construction, or app-server request dispatch
- Execution Layer
  - belongs: app-server startup advertisement, tool-call request routing, tool execution boundary invocation, response serialization, and turn-level failure handling
  - does not belong: tracker lifecycle policy or PR handoff decisions
- Integration Layer
  - belongs: a focused read-only tracker-tool service plus tracker-specific normalization for the first tool result
  - does not belong: Codex protocol parsing or runner session-state bookkeeping
- Observability Layer
  - belongs: surfacing dynamic-tool advertisement, tool-call start/completion/failure, tool name, and normalized summaries in logs/status/artifacts
  - does not belong: re-parsing tracker payloads or reconstructing tool results independently of the runner/integration layers

## Architecture Boundaries

### Belongs in this issue

- `src/runner/`
  - dynamic-tool advertisement for Codex app-server startup
  - request classification for `item/tool/call` and `item/tool/requestUserInput`
  - a focused tool executor interface used by `CodexAppServerSession`
  - normalized tool success/failure result serialization back to Codex
- `src/tracker/`
  - a narrow read-only tracker tool broker/service for the first tool
  - tracker-specific normalization helpers that shape safe tool output
- wiring in CLI/runtime composition
  - only enough dependency injection to let the Codex runner receive the tracker tool service
- targeted observability and tests
- minimal docs updates describing the supported first tool and the explicit non-goals

### Does not belong in this issue

- tracker claim/retry/landing policy changes
- generic cross-runner tool support for Claude Code or generic-command runners
- a broad new shared runtime service locator
- arbitrary tracker search or write tools
- app-server remote transport refactors
- repo-wide prompt-boundary changes unrelated to the first dynamic-tool seam

## Layering Notes

- `config/workflow`
  - owns any static config defaults or validation needed to turn on the supported Codex dynamic-tool surface
  - does not own tracker reads or tool-call dispatch
- `tracker`
  - owns read-only tracker-tool data acquisition and normalization into stable result payloads
  - does not parse Codex request envelopes or decide runner transport behavior
- `workspace`
  - remains untouched in this slice
  - does not learn about dynamic-tool metadata
- `runner`
  - owns app-server protocol handling, tool-call routing, response writing, and normalized transport failure mapping
  - does not reach directly into GitHub CLI commands or tracker-specific normalization logic
- `orchestrator`
  - remains unaware of raw dynamic-tool methods and only consumes normal run/turn results
  - does not coordinate per-tool execution
- `observability`
  - owns operator-facing summaries of dynamic-tool events already normalized by the runner
  - does not derive tracker-tool output on its own

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam at "Codex runner dynamic tools backed by one read-only tracker-native tool":

1. add a minimal tool executor contract and Codex session support for successful `item/tool/call`
2. add one tracker-native read-only tool implemented behind a tracker-layer service
3. normalize tool results and tool failures
4. add observability and tests for the new path

This stays reviewable because it deliberately does not combine:

- tracker tool support with tracker lifecycle policy changes
- the first tool slice with general multi-tool/plugin infrastructure
- Codex dynamic tools with runner-provider-neutral refactors
- read-only tracker access with write-capable tool mutations

If the first candidate tool would require broad tracker-interface expansion or raw comment-body exposure, narrow it further to a summary-oriented current-issue/current-PR context tool in this PR and defer broader tracker reads.

## Runtime State Model

This issue changes stateful live-session behavior inside an active Codex turn, so the plan requires an explicit dynamic-tool sub-state model within the existing app-server session.

### State variables

- `sessionState`
  - existing Codex app-server session state
- `activeTurn`
  - current turn in progress, if any
- `activeToolCall`
  - normalized dynamic-tool request currently being handled, if any
- `advertisedTools`
  - static set of tool definitions exposed for this session
- `toolFailureClass`
  - normalized tool execution or protocol failure class for the active tool request

### Dynamic-tool states

- `tool-idle`
  - no active dynamic-tool request
- `tool-requested`
  - `item/tool/call` request received and validated structurally
- `tool-executing`
  - runner tool executor boundary invoked
- `tool-awaiting-user-input`
  - request tried to use an unsupported interactive tool flow such as `item/tool/requestUserInput`
- `tool-succeeded`
  - executor returned a normalized success result and the response was written
- `tool-failed`
  - executor or protocol handling failed in a normalized way

### Allowed transitions

- `tool-idle -> tool-requested`
  - well-formed `item/tool/call` request arrives during an active turn
- `tool-requested -> tool-executing`
  - tool name and arguments validate against the advertised tool contract
- `tool-requested -> tool-failed`
  - unsupported tool name or malformed payload
- `tool-executing -> tool-succeeded`
  - tracker tool returns a normalized success payload and the response is written
- `tool-executing -> tool-failed`
  - executor throws, returns invalid output, or response write fails
- `tool-idle -> tool-awaiting-user-input`
  - `item/tool/requestUserInput` arrives
- `tool-awaiting-user-input -> tool-failed`
  - Symphony returns an explicit unsupported/invalid-params response because this first slice remains non-interactive
- `tool-succeeded -> tool-idle`
  - session resumes the enclosing turn
- `tool-failed -> tool-idle`
  - session records failure and either fails the turn or continues only where the protocol contract explicitly allows

### Coordination rules

- only one dynamic-tool request may be active at a time within the existing single-request session sequencing
- dynamic-tool execution remains inside the active turn boundary and must not mutate orchestrator retry or continuation counters
- tracker-native tool results must be normalized before they become model-visible output
- unsupported interactive tool flows must fail clearly instead of leaving the session waiting indefinitely

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| `item/tool/call` arrives for a supported tool with valid arguments | thread id, turn id, call id, tool name, parsed args | current issue and PR context available through tracker tool service | execute tool, serialize normalized success payload, continue turn |
| `item/tool/call` arrives for an unknown tool | thread id, turn id, call id, tool name | none needed | return explicit unsupported-tool response, classify as tool request failure, do not hang |
| tool-call payload is malformed | request id, raw params | none needed | return invalid-params response, classify as malformed-tool-request failure |
| tracker tool service fails to read current tracker state | request id, tool name, local error | tracker fetch error only | return normalized tool failure payload or explicit request failure, preserving clear operator visibility |
| tracker tool service returns output that violates the advertised schema | request id, tool name, normalized output candidate | tool result candidate | classify as tool-result-normalization failure and fail the tool call clearly |
| `item/tool/requestUserInput` arrives in the first non-interactive slice | request id, raw params | none needed | return explicit unsupported/invalid-params response and fail the active tool request without stalling |
| response write to app-server stdin fails after tool execution | request id, tool name, result payload | tracker result already computed | classify as active-turn transport/tool failure and fail the turn |
| tool succeeds but observability emission fails | request id, tool name, result payload | normalized tracker result | fail the turn using the existing visibility-failure path; do not silently ignore |

## Storage Or Persistence Contract

- no new durable store is required for this slice
- tracker-native tool results are computed on demand from the current tracker snapshot
- existing session artifacts/logs should record normalized tool-call observability facts, but the canonical source of tracker truth remains the tracker itself

## Observability Requirements

- log dynamic-tool advertisement during Codex session startup
- emit visibility/log summaries when a dynamic tool is requested, completed, or failed
- include the tool name in normalized summaries where available
- surface tracker-tool failures distinctly from generic approval or unsupported-request failures
- preserve raw-enough error detail in logs for debugging malformed tool requests without making downstream consumers parse raw protocol payloads

## Implementation Steps

1. Define a runner-facing dynamic-tool executor contract in `src/runner/` with:
   - supported tool definitions
   - `execute(toolName, args, context)` result shape
   - normalized success/failure response builders for Codex app-server
2. Extend the Codex app-server protocol helpers to:
   - parse `item/tool/call` requests into a normalized request shape
   - build explicit success, invalid-params, and unsupported-tool responses
   - keep `item/tool/requestUserInput` explicit and non-interactive for this slice
3. Update `CodexAppServerSession` to:
   - advertise the supported tool set during startup using the concrete Codex app-server shape required by the installed CLI
   - route supported tool calls through the new executor boundary
   - normalize tool-call failures distinctly from generic unsupported requests
4. Add a focused tracker-layer tool service that exposes one read-only tracker-native tool for the current issue/branch/PR context.
5. Reuse or extract tracker normalization helpers so tool output follows the same sanitization/trust-boundary rules as other tracker-derived agent context where applicable.
6. Wire the tracker tool service into Codex runner construction without broadening non-Codex runners.
7. Add/update tests for:
   - advertisement of the tool surface at session startup
   - successful supported tool execution
   - malformed tool-call payloads
   - unsupported tool names
   - unsupported `requestUserInput` handling
   - tracker tool service failures
8. Update minimal docs to explain the first dynamic-tool slice and its non-goals.

## Tests And Acceptance Scenarios

### Unit coverage

- Codex protocol helper tests for dynamic-tool request parsing and response serialization
- runner-session tests for:
  - advertised tools present on startup
  - supported tool call succeeds and returns normalized output
  - unknown tool name returns explicit unsupported response
  - malformed args return invalid-params response
  - unsupported `item/tool/requestUserInput` fails explicitly without hanging
- tracker tool service tests for normalized/sanitized output and tracker read failures

### Integration coverage

- fake Codex app-server integration proving the live session can receive `item/tool/call`, execute the first tracker-native tool, and continue to `turn/completed`
- GitHub and/or tracker mock coverage proving the tool reads normalized current issue/PR state rather than bypassing tracker abstractions

### End-to-end acceptance scenarios

1. A Codex worker session starts, advertises the first tracker-native tool, receives a supported tool call during a turn, and completes the turn successfully.
2. Codex requests an unsupported dynamic tool and Symphony replies explicitly instead of stalling the session.
3. Codex sends malformed tool-call arguments and Symphony fails the tool request clearly with normalized observability.
4. The first tracker-native tool returns sanitized current issue/PR context that stays aligned with repository trust-boundary rules.
5. A tracker read failure during tool execution becomes a visible runner/tool failure rather than a silent hang or raw tracker exception leak.

## Exit Criteria

- Codex app-server sessions can advertise and execute one supported tracker-native client-side tool
- the first tool is read-only, normalized, and covered by unit/integration tests
- unsupported dynamic-tool requests and unsupported interactive tool flows fail explicitly without stalling the live session
- runner/tracker/orchestrator boundaries remain clear, with no tracker policy logic embedded in the runner transport
- docs and observability reflect the supported first slice accurately

## Deferred To Later Issues Or PRs

- additional tracker-native tools
- write-capable tracker mutations
- generic client-side tool framework for all runner kinds
- interactive user-input tool flows
- richer tool catalog discovery or per-workflow tool configuration
- broader tracker search/query surfaces beyond the first current-issue/current-PR slice

## Decision Rationale

- The runner needs a dedicated tool executor seam now because otherwise `CodexAppServerSession` becomes a mixed transport/tracker hot file again.
- The first tool should reuse tracker normalization rules because this issue is about structured client-side access, not about reopening raw tracker text exposure.
- Keeping the first slice read-only and current-issue-scoped preserves a narrow PR seam while still replacing shell affordances with a real tracker-native path.
