# Issue 184 Plan: Generalize Active-Run Identity, Shutdown, And Recovery Beyond Local PID Ownership

## Status

- plan-ready

## Goal

Refactor active-run lease ownership, shutdown persistence, and restart recovery so Symphony records and reasons about a normalized execution owner identity instead of treating local factory PID plus runner PID as the universal run-ownership model. Preserve the current local safety guarantees for controllable subprocesses while making the coordination contract ready for remote execution transports introduced by `#182` and `#183`.

## Scope

- define a normalized active-run execution identity shape for lease records, status snapshots, and issue artifacts
- make local runner PID ownership an optional transport-specific fact rather than the central active-run identity
- persist enough execution-owner metadata to distinguish:
  - current factory host
  - current orchestrator instance
  - execution transport kind
  - transport session/task identity
  - local controllable-process facts when they exist
  - runner/provider endpoint metadata needed for future remote recovery
- refactor startup reconciliation, shutdown handling, and live active-issue projection to consume the normalized execution identity
- preserve current behavior for local transports, including orphaned local-runner termination and intentional shutdown recovery
- update unit/integration/e2e coverage and operator-facing docs/status text for the new model

## Non-goals

- implementing a real remote runner, remote cancellation transport, or multi-host leader election
- redesigning tracker transport, tracker normalization, or tracker lifecycle policy
- changing workflow config UX beyond the minimum typed/runtime support needed for execution-owner metadata
- replacing the local lock-directory lease mechanism with a different durable store
- broad retry/backoff/watchdog redesign outside the active-run ownership seam

## Current Gaps

- `src/orchestrator/issue-lease.ts` persists `ownerPid` and optional `runnerPid`, so the durable lease model still assumes ownership is fundamentally local-process-based.
- `src/orchestrator/restart-recovery.ts` classifies inherited work from local PID snapshots plus normalized tracker lifecycle, but it cannot distinguish future remote execution ownership from "no runner pid".
- `src/orchestrator/service.ts`, `src/orchestrator/status-state.ts`, and `src/observability/status.ts` project local PID fields directly as the primary active-run identity.
- `src/observability/issue-artifacts.ts` still stores `runnerPid` in attempt snapshots even though the runner contract already exposes transport metadata.
- The runner contract from `#182` can represent local and remote transports, but the coordination/storage seam still collapses recovery decisions to local owner/runner PID facts.
- Current tests cover local orphan cleanup and remote-no-pid spawn recording, but they do not lock in a normalized execution-owner contract that remains inspectable when the active run is not owned by a local child process.

## Decision Notes

- This issue should stay centered on coordination plus execution-owner persistence. It should not grow into a remote backend implementation.
- The durable identity should separate:
  - lease owner identity: who currently holds the active-run claim
  - transport execution identity: how the runner is executing and which backend session/task it is using
  - local control identity: which local process, if any, this factory instance may signal
- A local factory instance should still use local PID facts for safety decisions, but only after the normalized execution identity says the transport exposes a local controllable process on the current host.
- Shutdown and restart recovery should prefer normalized facts already emitted by the runner and workspace layers rather than reconstructing transport semantics from nullable PID fields.
- Backward-compatible parsing is desirable for existing local lease/status/artifact data, but newly written records should use the normalized shape.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the rule that active-run ownership is a normalized execution-owner contract, not just a pair of local PIDs
  - belongs: the rule that shutdown/recovery decisions depend on transport-aware execution identity plus tracker handoff facts
  - does not belong: signal-delivery mechanics, JSON parsing, or tracker API requests
- Configuration Layer
  - belongs: only narrowly scoped typed runtime facts needed to stamp the current factory host/instance identity into durable active-run records
  - does not belong: live lease mutation, recovery branching, or tracker lifecycle policy
- Coordination Layer
  - belongs: restart recovery decisions, shutdown decisions, and active-run supervision based on normalized execution identity
  - does not belong: provider-specific runner wiring or tracker payload parsing
- Execution Layer
  - belongs: lease persistence shape, transport-aware controllable-process metadata, and any helper types that normalize active execution ownership
  - does not belong: tracker handoff policy or restart posture formatting
- Integration Layer
  - belongs: unchanged tracker lifecycle/handoff inputs consumed by recovery
  - does not belong: execution-owner storage or local PID probing rules
- Observability Layer
  - belongs: status/artifact projection of normalized execution-owner facts and operator-visible recovery summaries
  - does not belong: inventing recovery semantics or reverse-engineering transport kind from ad hoc fields

## Architecture Boundaries

### `src/orchestrator/issue-lease.ts`

Owns:

- durable active-run lease record schema
- inspection/reconciliation of persisted execution-owner facts
- local orphan termination only when the normalized execution identity exposes a local controllable process on this host

Does not own:

- tracker-aware restart policy
- status wording
- provider/backend-specific transport semantics beyond the normalized contract

### `src/orchestrator/restart-recovery.ts` and `src/orchestrator/service.ts`

Own:

- coordination decisions that combine lease snapshots, normalized tracker lifecycle, and current factory identity
- whether inherited work is adopted, requeued, shutdown-recovered, suppressed, or degraded
- active-issue runtime state projection of execution-owner facts

Do not own:

- lease JSON shape details beyond consuming typed snapshots
- direct transport parsing
- tracker payload normalization

### `src/observability/status.ts` and `src/orchestrator/status-state.ts`

Own:

- operator-facing projection of active-run ownership and restart recovery facts
- backward-compatible parsing/rendering for the status schema transition

Do not own:

- restart decision logic
- raw lease inspection

### `src/observability/issue-artifacts.ts`

Owns:

- persisted attempt/session metadata that records normalized execution-owner facts for reports

Does not own:

- orchestrator policy
- lease recovery logic

### `src/runner/`

Owns:

- emitting normalized transport metadata already defined by the stable runner contract

Does not own:

- durable active-run lease policy
- restart/shutdown decision rules

## Layering Notes

- `config/workflow`
  - may resolve stable factory identity inputs if needed
  - does not store live run ownership
- `tracker`
  - keeps supplying normalized handoff state
  - does not learn about transport sessions, hosts, or local killability
- `workspace`
  - remains the source of prepared execution-target metadata from `#183`
  - does not become the durable run-ownership store
- `runner`
  - keeps supplying normalized transport/session facts
  - does not own restart recovery
- `orchestrator`
  - becomes the place that interprets normalized execution-owner state for supervision/recovery
  - does not invent tracker policy or provider-specific transport parsing
- `observability`
  - renders normalized execution-owner facts clearly
  - does not become the source of truth for ownership

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one coordination/execution-identity seam:

1. introduce the normalized active-run execution-owner contract in lease/status/artifact types
2. thread that contract through live spawn/shutdown/recovery paths while preserving local behavior
3. update observability and tests to prove both local and remote-capable ownership facts work

Deferred from this PR:

- remote worker implementation or remote cancellation RPC
- tracker changes
- multi-instance cross-host coordination policy
- broader retry/watchdog refactors not required by the new ownership contract

This stays reviewable because it builds directly on the runner/workspace seams from `#182` and `#183` without combining them with new tracker or remote-execution machinery.

## Runtime State Machine

This issue changes long-running shutdown and restart behavior, so the active-run ownership state must be explicit.

### Lease / Active-Run Ownership States

1. `claiming`
   - local factory acquires the issue lock and writes initial owner identity
2. `owned-no-runner`
   - the run is claimed but no live runner transport has been attached yet
3. `owned-running`
   - a runner transport is attached and execution-owner metadata is current
4. `shutdown-requested`
   - coordinated shutdown has begun; execution identity is still recorded
5. `shutdown-draining`
   - shutdown escalation window is open while awaiting clean exit
6. `shutdown-terminal`
   - shutdown completed and the lease records the final shutdown outcome for restart recovery
7. `stale-owned`
   - persisted owner identity no longer maps to a live local owner and no recoverable local runner control remains
8. `stale-owned-with-local-runner`
   - persisted owner identity is stale, but the execution identity still exposes a live local controllable runner on this host
9. `cleared`
   - the lock has been removed after normal completion or reconciliation

### Allowed transitions

- `claiming -> owned-no-runner`
- `owned-no-runner -> owned-running`
- `owned-no-runner -> shutdown-requested`
- `owned-running -> shutdown-requested`
- `shutdown-requested -> shutdown-draining`
- `shutdown-requested -> shutdown-terminal`
- `shutdown-draining -> shutdown-terminal`
- `owned-no-runner -> cleared`
- `owned-running -> cleared`
- `shutdown-terminal -> cleared`
- `owned-no-runner -> stale-owned`
- `owned-running -> stale-owned`
- `owned-running -> stale-owned-with-local-runner`
- `stale-owned-with-local-runner -> cleared`
- `stale-owned -> cleared`

### Contract Rules

- every persisted active run must record a normalized owner identity with explicit transport facts
- local PIDs are optional control metadata, not the primary run identifier
- recovery may only attempt local termination when:
  - the execution identity says the transport is locally controllable
  - the local process identity is on the current host
  - the target pid is not the current orchestrator pid
- remote/session-only executions may be adopted, requeued, or degraded, but they must not trigger local kill attempts just because local PID fields are absent
- intentional shutdown records must preserve the execution identity that was being shut down so restart inspection remains transport-aware

## Failure-Class Matrix

| Observed condition                                                                | Local facts available                              | Normalized execution-owner facts available                                | Expected decision                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Healthy inherited local run after restart                                         | live owner pid, optional live local runner pid     | owner host/instance matches current host family, local transport metadata | adopt without redispatch                                                                                   |
| Stale local owner, live orphaned local runner                                     | dead owner pid, live controllable local runner pid | local controllable transport on current host                              | terminate orphaned runner, clear lease, requeue                                                            |
| Stale local owner, no live local runner                                           | dead owner pid, no live local runner               | owner identity present, local transport metadata or no runner attached    | clear lease, requeue                                                                                       |
| Intentional shutdown residue from a local run                                     | dead owner pid, optional dead/live runner pid      | shutdown-terminal record plus prior execution identity                    | preserve/clear shutdown record per policy, then redispatch                                                 |
| Inherited running issue already awaiting review/checks/landing                    | any                                                | tracker lifecycle beyond execution, execution-owner state may be stale    | suppress duplicate rerun and clear stale local lease state                                                 |
| Remote-capable execution with no local pid but valid remote session/task identity | no local controllable process                      | remote session/task identity, transport kind, endpoint metadata           | do not attempt local kill; adopt if still healthy, otherwise degrade or requeue per tracker/handoff policy |
| Lease record missing owner identity fields but old schema still parseable         | maybe owner pid / runner pid only                  | legacy local-only schema                                                  | normalize as legacy-local owner, preserve current local behavior                                           |
| Lease record malformed beyond safe normalization                                  | unknown                                            | invalid or contradictory owner/transport facts                            | mark degraded, surface operator-visible summary, avoid unsafe cleanup                                      |
| Shutdown requested for remote-capable transport with no local pid                 | no local pid                                       | remote transport identity only                                            | record shutdown intent; delegate cancellation to runner contract if available; no local signal delivery    |

## Storage / Persistence Contract

- replace the central `ownerPid`/`runnerPid` lease identity with a normalized execution-owner object while preserving optional legacy local PID fields during the schema transition where needed
- include at least:
  - factory host identity
  - factory instance id
  - run session id
  - runner transport kind
  - remote session/task identifiers when present
  - local controllable-process metadata when present
  - lightweight endpoint metadata for future remote adoption/recovery diagnostics
- status snapshots should project the normalized execution-owner object and may retain derived `ownerPid`/`runnerPid` compatibility fields only if existing consumers still require them temporarily
- issue artifact attempts should stop treating `runnerPid` as the canonical execution identity; attempt/session snapshots should point at normalized execution-owner facts instead
- parsing should accept legacy locally owned records written before this issue so restart recovery remains compatible across upgrades

## Observability Requirements

- status snapshots and rendered status text must show transport-aware execution ownership, not just `owner=` / `runner=` pid pairs
- restart recovery output should explain when the factory intentionally skipped local kill logic because the inherited execution is not locally controllable
- issue artifacts should preserve enough execution-owner detail for reports to explain whether a run was local-process, local-stdio, remote-stdio, or remote-task
- structured logs for spawn, shutdown, and reconciliation should include owner host/instance, transport kind, and local-control facts when present

## Implementation Steps

1. Introduce typed active-run execution-owner and shutdown-record helpers in the execution/coordinator seam, likely centered on `src/orchestrator/issue-lease.ts` plus a small shared helper module if needed.
2. Refactor lease record write/read/inspect/reconcile flows to persist and normalize the new execution-owner shape while remaining backward-compatible with legacy pid-only records.
3. Update orchestrator spawn/shutdown/recovery paths to read the normalized execution-owner facts instead of treating `runnerPid` as the universal identity.
4. Update restart-recovery decision inputs/output types and status-state projection to surface transport-aware recovery facts.
5. Update status snapshot parsing/rendering and issue-artifact attempt/session persistence to record the normalized shape.
6. Adjust tests/builders/fixtures so local and remote-capable ownership scenarios are explicit and reusable.
7. Update README and any architecture text that still describes active-run ownership as purely local PID-based.

## Tests And Acceptance Scenarios

### Unit tests

- lease manager writes a normalized local execution-owner record for a controllable local transport
- lease manager writes a normalized remote/session-only execution-owner record with no local pid
- lease inspection normalizes a legacy pid-only record into the new model
- restart recovery distinguishes:
  - stale local owner with live local runner
  - stale local owner with remote-only execution identity
  - intentional shutdown residue with remote/local metadata
  - malformed execution-owner records that must degrade safely
- status and issue-artifact parsers accept both legacy and new shapes

### Integration tests

- orchestrator startup reconciliation still clears stale local orphaned runs and suppresses reruns when tracker handoff is already beyond execution
- orchestrator shutdown records preserve execution-owner identity through the shutdown path
- active status snapshots publish normalized execution-owner data during a live run

### End-to-end tests

- local bootstrap flow still completes and preserves current shutdown/orphan recovery behavior
- a fake remote-capable runner transport can execute without a local runner pid while status/artifacts/recovery remain inspectable and safe

### Acceptance scenarios

1. A normal local run still records enough local pid facts for shutdown and orphan cleanup, but the durable identity is now transport-aware.
2. A remote-capable runner transport can be persisted and rendered without inventing a fake local runner pid.
3. Restart recovery never attempts to signal a process unless the normalized execution identity proves the run is locally controllable on this host.
4. Existing legacy leases from older local-only builds still reconcile correctly after upgrade.

## Exit Criteria

- durable active-run records use a normalized execution-owner contract instead of pid pairs as the primary identity
- shutdown and restart recovery decisions consume that normalized contract
- local orphan cleanup and intentional shutdown recovery still work
- status/artifacts/docs reflect the transport-aware ownership model
- targeted unit, integration, and e2e coverage prove both local safety and remote-capable readiness

## Deferred To Later Issues Or PRs

- real remote execution backend and cancellation implementation
- cross-host adoption/lease transfer policy for multiple factory instances
- any tracker-specific handoff changes motivated by remote execution
- broader observability/report UX polish beyond surfacing the normalized ownership facts
