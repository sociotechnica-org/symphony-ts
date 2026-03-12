# Issue 89 Plan: Provider-Neutral Runner Contract And Codex Adapter Boundary

## Status

- plan-ready

## Goal

Define a provider-neutral internal runner contract and refactor the existing local Codex path behind that contract, while keeping prompt rendering, tracker writes, and orchestration policy outside the runner adapter.

## Scope

- define a stable runner service contract, event model, and final result model in `src/runner/`
- separate provider-neutral runner domain types from the Codex-specific local implementation details
- adapt the current local runner implementation so Codex remains the working backend through the new contract
- keep the orchestrator dependent on the runner interface rather than a Codex-shaped execution path
- add contract-focused tests that prove the runner shape is provider-neutral and that the Codex adapter honors the contract
- update docs where the contract surface or execution-layer responsibility needs to be explicit

## Non-goals

- `WORKFLOW.md` runner-selection UX or provider configuration redesign
- Claude Code integration from `#91`
- arbitrary generic command execution as a first-class multi-provider abstraction
- remote/background runner providers from `#15`
- tracker policy, tracker transport, or tracker normalization changes
- changing continuation-turn policy, retry budgets, or handoff lifecycle semantics introduced in `#99`

## Current Gaps

- `src/runner/service.ts` already exposes a live-session shape, but it is still effectively expressed in terms of the local Codex path rather than a deliberate provider-neutral contract
- `src/runner/local.ts` and `src/runner/local-live-session.ts` mix the stable runner interface with Codex-specific session discovery and resume assumptions
- the orchestrator currently depends on the runner contract, but the available contract tests are named and structured around the local runner rather than a backend-neutral runner capability surface
- runner events are limited to spawn notifications; that is enough for current artifact persistence, but the contract does not yet clearly distinguish provider-neutral lifecycle events from backend-specific session metadata
- current tests prove Codex behavior, but they do not clearly lock in what a non-Codex backend would be allowed to implement without orchestration changes

## Decision Notes

- This slice should preserve the existing orchestrator behavior. The main deliverable is a cleaner execution-layer seam, not new worker behavior.
- The current `Runner`, `LiveRunnerSession`, and `RunnerSessionDescription` types are close to the target seam. The work here is to formalize them as the stable contract and push Codex-specific mechanics behind an adapter boundary.
- The contract should model explicit run lifecycle facts the orchestrator already needs today:
  - spawn notification for local process ownership
  - provider/model/session metadata for observability
  - final per-turn result with stdout/stderr, timestamps, exit code, and session description
- The contract should not force every provider to mimic Codex session discovery. Backends without reusable conversations should still be valid implementations if they can report the same normalized result shape.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: issue scope, contract goals, and the decision that runner choice stays in the execution layer
  - does not belong: Codex subprocess arguments or orchestrator retry behavior
- Configuration Layer
  - belongs: unchanged typed runner-related config already resolved under `agent`
  - does not belong: backend selection UX or new provider config in this slice
- Coordination Layer
  - belongs: consuming the runner interface and remaining ignorant of Codex-specific implementation details
  - does not belong: session discovery, resume command building, or backend-specific command parsing
- Execution Layer
  - belongs: the runner contract, event/result model, live-session lifecycle, local runner implementation, and Codex adapter boundary
  - does not belong: tracker writes, prompt rendering policy, or lifecycle handoff decisions
- Integration Layer
  - belongs: untouched in this slice; tracker adapters remain the integration boundary for issue state
  - does not belong: any runner-provider details
- Observability Layer
  - belongs: consuming normalized runner events/session descriptions for status and issue artifacts
  - does not belong: inferring backend semantics from raw subprocess output

## Architecture Boundaries

### Belongs in this issue

- `src/domain/run.ts`
  - refine provider-neutral runner event/result types if needed
- `src/runner/service.ts`
  - define the stable runner contract and normalized event/result/session shapes
- `src/runner/`
  - split provider-neutral contract helpers from the local Codex-backed implementation details
- `src/orchestrator/service.ts`
  - narrow any remaining assumptions so it consumes the runner interface only
- `tests/unit/`
  - add runner contract tests plus focused Codex-adapter tests
- docs
  - document the execution-layer seam if the current docs imply a Codex-shaped runner

### Does not belong in this issue

- `src/config/` UX changes for selecting among providers
- tracker transport, normalization, or handoff policy changes
- follow-up / retry state machine redesign
- remote runner protocol work
- introducing a second real provider implementation

## Layering Notes

- `config/workflow`
  - keeps producing agent config
  - does not learn provider-specific runner behavior in this slice
- `tracker`
  - remains the only layer that writes tracker state
  - does not receive runner-provider metadata beyond existing normalized lifecycle inputs
- `workspace`
  - keeps preparing filesystem state for runs
  - does not own runner-provider selection or backend session handling
- `runner`
  - owns launching agents, reporting normalized execution events, and backend-session details behind a stable interface
  - does not render prompts, inspect tracker handoff state, or mutate tracker state
- `orchestrator`
  - owns dispatch/retry/handoff policy while depending only on the runner contract
  - does not parse Codex-specific output or build provider-specific commands
- `observability`
  - records normalized runner facts
  - does not deduce execution semantics from backend-specific raw logs

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by limiting the seam to the execution layer:

1. formalize a provider-neutral runner contract and supporting types
2. move Codex/local implementation details behind that contract
3. update orchestrator/tests/docs to consume the contract cleanly

This stays reviewable because it does not combine:

- runner contract extraction with tracker changes
- runner contract extraction with workflow UX changes
- runner contract extraction with retry/policy redesign
- runner contract extraction with adding a second provider

Follow-up slices can add provider selection (`#90`) or another backend implementation (`#91`) against the contract from this PR.

## Runner Session State Model

This issue does not change orchestration retry or handoff state, so a new orchestrator runtime state machine is not required. The stateful surface introduced or clarified here is the runner session lifecycle.

### States

- `idle`
  - runner instance exists but no run has started
- `starting`
  - backend process/session for a turn is being launched
- `running`
  - a turn is active and provider-neutral lifecycle events may be emitted
- `completed`
  - a turn finished with a normalized result
- `failed`
  - the launch or turn failed with a runner error
- `closed`
  - no more turns will be executed for this live session

### Allowed transitions

- `idle -> starting`
- `starting -> running`
- `starting -> failed`
- `running -> completed`
- `running -> failed`
- `completed -> starting`
  - for another turn in a live session
- `completed -> closed`
- `failed -> closed`

### Contract rules

- spawn notifications are optional in timing but, when emitted, must describe the concrete launched process for the current turn
- session metadata is normalized as `provider`, `model`, `backendSessionId`, `latestTurnNumber`, and log pointers
- backends may report `backendSessionId: null` when they do not support reusable conversations
- the runner contract must not require the orchestrator to know whether turn reuse is implemented by `resume`, a daemon, or a fresh process

## Failure-Class Matrix

| Observed condition                                                            | Local facts available                          | Normalized runner facts available                          | Expected decision                                                                              |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Runner cannot start the provider process                                      | workspace path, command config                 | launch failure / thrown runner error                       | existing orchestrator failure path; no tracker-policy change                                   |
| Turn exits non-zero                                                           | run session, turn number                       | normalized `RunResult` with exit code and captured output  | existing orchestrator failure/reconciliation path                                              |
| Turn succeeds on a provider without reusable session ids                      | provider known, backend has no session concept | `backendSessionId: null`, successful result                | contract remains valid; orchestrator continues to rely only on normalized turn result          |
| Codex continuation turn is requested before a backend session id is available | prior turn metadata, provider `codex`          | runner error                                               | fail at the adapter boundary rather than leaking Codex-specific recovery into the orchestrator |
| Spawn event persistence callback fails                                        | child pid known, callback threw                | runner error after cleanup attempt                         | existing orchestrator failure path with child cleanup preserved                                |
| Provider-specific session discovery fails after successful Codex turn         | stdout/stderr, timestamps, workspace metadata  | adapter cannot supply required Codex continuation metadata | treat as adapter failure; do not silently cold-start or mutate orchestrator policy             |

## Storage / Persistence Contract

- no new durable tracker state is introduced in this slice
- existing issue-artifact and status persistence continues to consume normalized spawn/session metadata through the runner contract
- if runner-domain types move, the persisted artifact shape should remain backward-compatible for the currently recorded fields (`provider`, `model`, `backendSessionId`, `latestTurnNumber`, and log pointers)

## Observability Requirements

- keep a normalized spawn event contract for issue artifacts and watchdog state
- keep `RunnerSessionDescription` explicit enough for status/reporting surfaces without parsing provider-specific output in observability code
- document that `backendSessionId` is provider-neutral optional metadata rather than a Codex-only orchestrator requirement
- preserve existing log-pointer behavior for Codex session enrichment

## Implementation Steps

1. Refine `src/runner/service.ts` and any supporting run-domain types so the contract explicitly separates:
   - normalized runner lifecycle events
   - normalized per-turn results
   - normalized session description metadata
2. Extract or rename local/Codex-specific pieces so the provider-neutral contract lives independently from the local backend implementation.
3. Update `src/runner/local.ts` and `src/runner/local-live-session.ts` to implement the contract strictly through the adapter boundary.
4. Narrow `src/orchestrator/service.ts` call sites if any Codex-shaped assumptions remain, without changing orchestration policy.
5. Add or restructure unit tests to include:
   - provider-neutral contract tests against a simple fake runner
   - Codex/local adapter tests that prove session metadata, spawn events, continuation-session behavior, and failure handling
6. Update README or architecture/docs text if needed so the runner layer is described as provider-neutral and Codex is described as one adapter.

## Tests And Acceptance Scenarios

### Unit tests

- runner contract accepts a backend with no reusable session id and still yields a valid normalized result/session description
- runner contract emits spawn metadata without forcing a Codex-specific event type
- local Codex-backed runner reports provider/model metadata through the normalized session description
- local Codex-backed live session captures backend session id after the first successful turn and reuses it on continuation turns
- local runner surfaces adapter failures when Codex session discovery or resume prerequisites fail
- orchestrator test uses only the runner interface and does not depend on local/Codex concrete types

### Integration / end-to-end coverage

- keep existing local runner/orchestrator tests passing through the refactored contract
- if a broader e2e fixture already exercises the local Codex path through the orchestrator, keep it green without adding new tracker behavior

### Acceptance scenarios

1. A one-shot run still launches through the provider-neutral runner interface and completes with the same observable result shape.
2. A multi-turn Codex run still reuses the same backend session through the adapter while the orchestrator consumes only normalized runner facts.
3. A hypothetical non-Codex backend fake can satisfy the contract without implementing Codex session discovery or resume behavior.
4. Existing issue artifacts/status handling still record spawn/session metadata without depending on Codex-specific parsing in orchestration code.

## Exit Criteria

- the orchestrator depends only on a stable runner interface
- the local Codex path works through that interface without policy regression
- runner events/results are explicit and provider-neutral in shape
- tests cover both the contract surface and the Codex adapter boundary
- docs describe the runner as an execution-layer seam rather than a Codex-shaped path

## Deferred To Later Issues Or PRs

- provider-selection config and factory wiring from `#90`
- Claude Code adapter implementation from `#91`
- remote/background runner contracts from `#15`
- any broader command-runner generalization beyond what this issue needs
