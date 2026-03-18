# Issue 182 Plan: Split Runner Transport From Provider Identity And Add A Remote-Capable Execution Contract

## Status

- plan-ready

## Goal

Refactor the stable runner contract so provider identity such as `codex`, `claude-code`, or `generic-command` is modeled separately from execution transport such as a local subprocess, a local long-lived stdio server, or a future remote task/session. Preserve the current local behavior while removing local-only assumptions from the execution-layer contract.

## Scope

- define explicit runner provider and execution transport metadata in `src/runner/`
- replace local-only spawn/session fields in the stable contract with transport-neutral execution metadata that can describe local and remote backends
- preserve the current local implementations for Codex, Claude Code, and generic command behind the refactored contract
- update orchestrator, lease, status, and issue-artifact consumers so they persist and display normalized execution facts without assuming every runner owns a local `pid`
- add contract and adapter tests that prove local behavior remains intact while a remote-capable transport shape is valid
- update architecture and README text where the runner contract is still described in provider-only or local-process-only terms

## Non-goals

- implementing a real remote worker, hosted task backend, or network transport in this slice
- changing tracker policy, tracker transport, or tracker normalization
- changing continuation-turn policy, retry budgets, review-loop policy, or landing policy
- redesigning `WORKFLOW.md` runner selection UX beyond the minimum typed config/runtime contract needed for the new execution metadata
- changing report enrichment behavior beyond the normalized session/event schema updates required by the contract

## Current Gaps

- `src/runner/service.ts` separates providers reasonably well, but the stable contract still bakes in local-process assumptions:
  - `RunnerSpawnedEvent` only models a local `pid`
  - `RunnerSessionDescription` includes `appServerPid` directly in the generic session shape
- `src/orchestrator/issue-lease.ts` records `runnerPid` as though every execution transport is a local child process the factory can inspect or terminate
- `src/orchestrator/service.ts`, `src/observability/issue-artifacts.ts`, and `src/observability/status.ts` persist local-process fields directly instead of a transport-neutral execution snapshot
- Codex app-server, Claude resume, and generic-command execution all share one runner contract, but the contract does not make clear which facts are provider identity and which are transport/runtime identity
- current tests prove provider neutrality better than before, but they do not lock in that a backend with no local `pid` and a remote execution identity is first-class

## Decision Notes

- This issue should be the first remote-capable execution seam, not the first real remote backend.
- The contract should distinguish at least three concerns explicitly:
  - provider identity: `codex`, `claude-code`, `generic-command`, or another future runner provider
  - execution transport: local command process, local stdio session, remote stdio session, hosted remote task
  - backend session identity: provider/backend-specific thread, conversation, turn, or task ids
- Local execution ownership still matters for leases, shutdown, and watchdog behavior, but it belongs in transport metadata, not as a universal runner-session field.
- The orchestrator should consume normalized execution facts and only take local process actions when the transport reports a local controllable process.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the decision that provider identity and transport identity are separate execution concepts and that remote-capable metadata is part of the stable contract
  - does not belong: subprocess wiring, stdio parsing, or tracker lifecycle rules
- Configuration Layer
  - belongs: any typed runner/config shape needed to resolve transport metadata without exposing backend quirks to the orchestrator
  - does not belong: lease mutation, tracker writes, or transport runtime state
- Coordination Layer
  - belongs: consuming normalized execution metadata for status, recovery, and shutdown decisions
  - does not belong: provider-specific command parsing or transport-specific protocol handling
- Execution Layer
  - belongs: runner contract types, provider adapters, transport metadata, local controllable-process details, and live-session execution identity
  - does not belong: tracker handoff policy or plan/review lifecycle decisions
- Integration Layer
  - belongs: untouched in this slice; tracker adapters remain unchanged
  - does not belong: runner transport policy or provider/session semantics
- Observability Layer
  - belongs: persisting and rendering normalized provider, transport, and execution identity facts
  - does not belong: reconstructing provider or transport semantics from raw logs

## Architecture Boundaries

### Belongs in this issue

- `src/runner/service.ts`
  - define transport-neutral runner event, session, and execution identity types
- `src/runner/`
  - adapt local providers to emit the new contract while preserving current behavior
- `src/orchestrator/service.ts`
  - consume normalized execution metadata and stop assuming that every spawn event implies a locally manageable process
- `src/orchestrator/issue-lease.ts`
  - record local-control facts only when the transport exposes them
- `src/observability/issue-artifacts.ts`
  - persist normalized execution metadata instead of transport-specific one-off fields
- `src/observability/status.ts` and TUI/status consumers
  - parse and render the normalized transport/execution metadata
- tests in `tests/unit/`
  - contract, adapter, lease, artifact, and status coverage for the new shape
- docs
  - clarify provider versus transport responsibilities in the runner layer

### Does not belong in this issue

- tracker adapter changes
- remote network clients or hosted-task protocol implementations
- orchestration retry state redesign
- workspace lifecycle changes unrelated to execution metadata
- adding a new provider implementation

## Layering Notes

- `config/workflow`
  - keeps resolving typed agent config
  - does not infer or persist live execution state
- `tracker`
  - keeps owning tracker lifecycle state
  - does not learn anything about runner transport or backend sessions
- `workspace`
  - keeps preparing repo state for runs
  - does not own process/task identity
- `runner`
  - owns provider identity, transport identity, and normalized execution facts
  - does not own tracker mutation or orchestration retry policy
- `orchestrator`
  - owns coordination decisions that depend on normalized execution metadata
  - does not parse provider commands or transport protocols
- `observability`
  - records normalized execution facts from runner/orchestrator state
  - does not invent execution semantics beyond what the runner contract already provides

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam at the stable execution contract and its immediate local consumers:

1. refactor runner contract types to separate provider identity from transport/execution identity
2. update existing local adapters to emit the refactored metadata without changing behavior
3. update orchestrator lease/observability consumers to use the normalized transport metadata
4. add contract and regression tests

This stays reviewable because it does not combine:

- contract refactoring with a real remote backend implementation
- contract refactoring with tracker policy changes
- contract refactoring with retry/reconciliation redesign
- contract refactoring with new workflow UX beyond what the contract requires

Remote backends can land in follow-up PRs against this contract without reopening the local-only assumptions.

## Execution Session State Model

This issue does not change the orchestrator retry or handoff state machine, but it does change the stateful execution contract and the facts available to coordination/observability layers. The relevant state model is the normalized execution session lifecycle.

### State variables

- `provider`
  - logical runner backend such as `codex`, `claude-code`, or `generic-command`
- `transport`
  - execution delivery mode such as `local-process`, `local-stdio-session`, `remote-stdio-session`, or `remote-task`
- `executionIdentity`
  - normalized transport facts such as local controllable process id, remote task id, remote session id, or connection identity
- `backendSessionIdentity`
  - provider/backend facts such as thread id, turn id, or conversation id
- `latestTurnNumber`
  - most recent successful turn number when applicable

### States

- `idle`
  - session described but no turn started
- `starting`
  - transport/session startup is in progress
- `running`
  - a turn is executing and transport metadata may update
- `waiting`
  - runner is healthy but waiting on an external/system boundary
- `completed`
  - latest turn completed with normalized result metadata
- `failed`
  - execution or transport failed
- `cancelled`
  - execution stopped because the factory shut down or cancelled the run
- `closed`
  - live session is no longer usable

### Allowed transitions

- `idle -> starting`
- `starting -> running`
- `starting -> failed`
- `running -> waiting`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `waiting -> running`
- `waiting -> completed`
- `completed -> starting`
  - continuation turn in the same live session
- `completed -> closed`
- `failed -> closed`
- `cancelled -> closed`

### Contract rules

- provider identity and transport identity are both required normalized facts
- transport metadata may describe zero local-process facts when the backend is remote
- only transports that expose a local controllable process may populate local pid/control metadata
- backend session identifiers remain optional and provider-specific, but they must not be overloaded to stand in for transport identity
- status and artifact persistence should record the normalized transport/execution identity directly instead of reverse-engineering it from provider-specific fields

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized execution facts available | Expected decision |
| --- | --- | --- | --- |
| Local process runner launches successfully | local child pid | provider, `transport=local-process`, local control metadata | existing local lease/shutdown/watchdog behavior continues |
| Local long-lived stdio runner launches successfully | local child pid, session startup state | provider, `transport=local-stdio-session`, local control metadata, backend ids when available | existing local behavior continues through transport-neutral fields |
| Remote runner starts successfully with no local child pid | no local child process | provider, `transport=remote-task` or `remote-stdio-session`, remote execution identity | orchestrator records/renders execution state without trying local process inspection |
| Remote runner emits progress/completion without any local pid | none | normalized visibility and result metadata | status/artifacts update normally; no lease runner-pid ownership is inferred |
| Local transport spawn callback fails after child launch | local pid | partial local transport metadata | existing runner failure path; cleanup local child if owned |
| Remote task creation succeeds but later status polling/stream fails | remote task/session id | remote transport metadata, failed visibility/result | treat as runner failure; no local kill attempt |
| Continuation turn requested on a backend with reusable remote session identity | remote session/task/thread id | backend session identity, transport metadata | runner handles continuation behind the stable contract; orchestrator stays transport-neutral |
| Shutdown arrives while runner has local controllable process | local pid | local transport metadata | existing termination path applies |
| Shutdown arrives while runner has remote task but no local controllable process | no local pid | remote execution identity only | surface cancellation through runner contract; do not try local signal delivery |

## Storage / Persistence Contract

- issue artifacts and status snapshots should move from local-only fields such as `appServerPid` toward a normalized execution metadata object or equivalent transport-neutral fields
- backward compatibility should be preserved where practical for existing local snapshots/artifacts so current readers do not break abruptly
- active lease records may continue to store `runnerPid` for local transports, but only as an optional local-control fact rather than a universal runner property

## Observability Requirements

- persist provider identity and transport identity distinctly
- surface local controllable-process facts only when present
- keep backend session facts such as thread/turn ids available for operators and report enrichment
- ensure status/TUI strings remain clear when there is no local `pid`
- document that `runnerPid`/`appServerPid` are transport-specific local facts, not universal runner identifiers

## Implementation Steps

1. Refine `src/runner/service.ts` to introduce explicit transport/execution identity types and update the stable event/session/result contract accordingly.
2. Update Codex, Claude Code, and generic-command runners to populate the new contract while preserving current behavior.
3. Update orchestrator run-state handling and lease recording so local-process ownership is conditional on transport metadata instead of assumed globally.
4. Update issue-artifact and status snapshot schemas/readers/writers to persist and consume the normalized transport metadata.
5. Update TUI/report-facing consumers as needed so they render the new shape cleanly and remain backward-compatible with current local snapshots where required.
6. Add/reshape tests for runner contract, local adapters, lease handling, status parsing, and artifact persistence.
7. Update README and architecture/docs text to describe provider identity and transport identity as separate execution-layer concepts.

## Tests And Acceptance Scenarios

### Unit tests

- runner contract accepts a backend that reports `transport=remote-task` and no local pid
- local process and local stdio adapters still expose their local controllable-process metadata through the new transport shape
- lease recording ignores remote-only executions and still records local runner pids when present
- issue-artifact and status parsing accept the new normalized transport metadata
- existing local Codex/Claude/generic runner tests still prove continuation/session behavior through the refactored contract

### Integration / end-to-end coverage

- keep existing bootstrap/orchestrator workflows green with the refactored local contract
- keep status/report generation green against locally produced artifacts after the schema update

### Acceptance scenarios

1. A local one-shot run still completes with the same user-visible behavior, but its runner metadata now separates provider from transport.
2. A local multi-turn Codex run still reuses its live session while publishing transport-neutral execution metadata.
3. A fake remote-capable runner can satisfy the stable runner contract without inventing a local `pid`.
4. Lease/status/artifact consumers handle both local and remote-capable execution metadata without transport-specific branching leaking into tracker policy.

## Exit Criteria

- stable runner contract separates provider identity from transport/execution identity
- local runners continue to pass existing behavior tests
- orchestrator/lease/observability consumers no longer require a universal local-process `pid`
- docs describe the runner layer as provider-neutral and transport-neutral
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- real remote execution adapters and network clients
- provider-specific remote session recovery/reconciliation policy
- any workflow UX for selecting among multiple transport implementations of the same provider
- richer remote observability such as heartbeat polling or hosted-task log streaming
