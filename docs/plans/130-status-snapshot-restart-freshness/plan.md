# Issue 130 Plan: Restart-Safe Status Snapshot Freshness

## Status

- plan-ready

## Goal

Make the local factory status snapshot restart-safe so `.tmp/factory-main/.tmp/status.json` cannot plausibly present a previous worker instance as current after a restart or crash. The status contract and CLI should make freshness explicit, prefer degraded/offline semantics over silent heuristics, and converge quickly when a new factory instance starts.

## Scope

- define explicit status freshness semantics for the persisted factory snapshot
- extend the snapshot contract so readers can distinguish fresh, stale, and unavailable/degraded status after restart boundaries
- add narrow coordination behavior at startup/restart to invalidate or replace leftover snapshots from a previous worker instance
- update `factory status` rendering so stale or unavailable runtime state is unmistakable in both human and JSON output
- cover clean stop, unclean stop, and restart recovery with unit, integration, and end-to-end tests
- document the restart-safe status behavior in operator-facing docs where the current status surface is described

## Non-Goals

- changing tracker lifecycle policy, retry budgets, watchdog policy, or follow-up behavior
- introducing a new TUI, database, service, or background watchdog just for status freshness
- redesigning the detached `screen` control model
- replacing the current status snapshot with a second control-state store
- broad refactors outside the status/control seam unless a small helper extraction is needed to keep freshness logic explicit

## Current Gaps

- the persisted snapshot includes `generatedAt` and `worker.instanceId`, but readers do not classify freshness beyond checking whether `worker.pid` is alive
- a leftover snapshot from a previous worker can survive a restart boundary and still look plausible when the old PID is dead but the new runtime has not yet published a replacement snapshot
- the control surface reports a generic degraded state, but it does not name whether the snapshot is stale, missing for the active session, or invalidated during restart
- startup/restart does not explicitly invalidate the previous snapshot before the new worker begins publishing
- tests cover dead-PID detection, but not restart-safe ownership semantics across clean stop, unclean stop, and replacement startup

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: repo-owned contract for how operators and automation should interpret `status.json` freshness states across restart boundaries
  - does not belong: tracker-specific issue lifecycle rules or landing/retry policy
- Configuration Layer
  - belongs: status-file lifecycle rules tied to the resolved runtime root if startup invalidation needs config-aware path resolution
  - does not belong: freshness classification policy hidden inside workflow parsing
- Coordination Layer
  - belongs: startup/restart invalidation or placeholder publication that ensures a new worker instance cannot inherit the previous worker's status as current
  - does not belong: view formatting or tracker transport changes
- Execution Layer
  - belongs: none beyond using the existing worker process identity and start time as facts for the status contract
  - does not belong: embedding status freshness policy into runner or workspace code
- Integration Layer
  - belongs: none for this issue; tracker adapters remain untouched
  - does not belong: any tracker transport, normalization, or policy edits
- Observability Layer
  - belongs: status snapshot schema, freshness classification, degraded/offline payloads, JSON shape, and CLI rendering
  - does not belong: restart reconciliation decisions unrelated to keeping the status contract trustworthy

## Architecture Boundaries

### Observability

Belongs here:

- the persisted snapshot schema additions needed to describe freshness explicitly
- pure freshness classification logic that evaluates snapshot facts such as `generatedAt`, `worker.instanceId`, and PID liveness
- human-readable and JSON rendering for fresh, stale, degraded, and unavailable status

Does not belong here:

- detached-session startup policy
- tracker state repair
- process-tree cleanup

### Coordination

Belongs here:

- the narrow startup/restart behavior that marks any inherited snapshot as not current for the new worker instance until the new worker publishes its own snapshot
- passing the current worker identity into freshness classification where the control layer knows which detached session is expected to be authoritative

Does not belong here:

- tracker follow-up logic
- watchdog escalation changes
- presentation formatting rules

### CLI / factory control

Belongs here:

- using the observability classifier to render operator-facing status
- reporting when the runtime has an active detached session but no current snapshot for that worker instance
- exposing explicit degraded/offline facts in JSON output without inventing a second persistence contract

Does not belong here:

- ad hoc freshness heuristics duplicated from `src/observability/status.ts`
- writing persistent snapshot files directly from the control layer

### Orchestrator / runtime status state

Belongs here:

- publishing an initial invalidated/degraded snapshot or removing/rewriting inherited stale state during startup
- continuing to write the authoritative live snapshot from the active worker instance after meaningful transitions

Does not belong here:

- terminal wording
- unrelated runtime-state refactors for retries, continuations, or tracker policy

## Slice Strategy And PR Seam

This issue should stay one reviewable PR focused on the observability contract plus the minimum coordination needed to preserve that contract across restart:

1. extend the status snapshot/read model with explicit freshness semantics
2. add startup invalidation or replacement logic for inherited snapshots
3. update `factory status` rendering and JSON output to show stale/offline/unavailable state clearly
4. add restart-path tests and minimal docs updates

Deferred from this PR:

- watchdog/self-healing changes
- broader factory control redesign
- TUI/dashboard work beyond consuming the clarified status contract later
- any tracker or PR lifecycle policy changes

This seam is reviewable because it stays inside observability semantics and restart-safe publication. It does not mix tracker behavior, retry policy, or detached process management changes beyond what is strictly necessary to avoid stale snapshots.

## Runtime State Model

The orchestration behavior touched here is restart reconciliation for a durable derived snapshot, so the plan includes an explicit state model for snapshot freshness rather than adding more implicit branches.

### Snapshot Freshness States

1. `fresh`
   - snapshot was generated by the active worker instance and its worker PID is still the authoritative live worker for the current detached runtime
2. `stale`
   - snapshot exists, but it belongs to a previous worker instance or otherwise cannot be treated as current for the active runtime
3. `unavailable`
   - no readable current snapshot exists for the runtime, or the snapshot file is unreadable/invalid

### Runtime-Control Read States

The existing control states remain `stopped`, `running`, and `degraded`, but status detail becomes more explicit:

- `running` + `fresh`
  - healthy live worker with current snapshot
- `degraded` + `stale`
  - snapshot exists but does not belong to the authoritative active worker instance, or the recorded worker is dead
- `degraded` + `unavailable`
  - detached session exists, but there is no readable current snapshot yet or the snapshot has been invalidated during restart
- `stopped` + `stale`
  - no live runtime, but a leftover snapshot remains on disk and is clearly reported as historical/stale rather than current

### Allowed Transitions

- `fresh -> stale`
  - current worker dies, a new worker instance takes ownership, or restart invalidation marks the inherited snapshot non-current
- `fresh -> unavailable`
  - snapshot file is deleted/corrupted before a replacement is published
- `stale -> unavailable`
  - stale snapshot is cleared during startup or cleanup
- `stale -> fresh`
  - new worker publishes its first current snapshot
- `unavailable -> fresh`
  - new worker publishes its first current snapshot

## Failure-Class Matrix

| Observed condition | Local facts available | Snapshot facts available | Expected decision |
| --- | --- | --- | --- |
| Active detached session, current worker has already published | live session, authoritative worker pid/instance | snapshot `worker.instanceId` matches current worker and worker pid is live | report `running` with `fresh` snapshot |
| Active detached session after restart before first publish | live session, new worker identity, prior snapshot file may still exist | inherited snapshot instance does not match current worker or snapshot was explicitly invalidated | report `degraded` with `unavailable` or `stale` detail; do not present prior worker state as current |
| Old worker dead, no active detached session, leftover file remains | no live session or worker | readable snapshot from previous worker, dead pid | report `stopped` with explicit stale snapshot detail |
| Snapshot file unreadable/corrupt while detached session is live | live session/process facts | parse error or invalid schema | report `degraded` with `unavailable` detail and include parse problem |
| New worker restarts after unclean stop and reuses same status path | live session, new worker pid/instance | previous snapshot has older identity/start marker | invalidate or replace promptly, then converge to `fresh` when the new worker publishes |

## Storage / Persistence Contract

The status file remains a derived local JSON contract under the existing path. This issue narrows the contract rather than replacing it.

Planned contract changes:

- add explicit freshness/degradation metadata at the snapshot or control-read layer instead of relying on implicit PID heuristics alone
- preserve `generatedAt` as the snapshot generation timestamp
- preserve `worker.instanceId` as the worker identity and make it part of freshness classification
- if startup invalidation writes a placeholder snapshot, ensure it is schema-valid and explicitly marked non-current rather than masquerading as a live worker snapshot
- if startup invalidation deletes the stale file instead, ensure the control surface reports that absence as `unavailable` while restart is in progress

Decision note:

- prefer one canonical JSON contract. If freshness metadata can live directly in `status.json` without bloating the schema, that is preferred over adding a separate sidecar control file. If some classification remains reader-derived, it should still be emitted through `factory status --json` so automation does not need to recreate the logic.

## Observability Requirements

- operator-facing output must name snapshot freshness explicitly instead of only warning that a dead PID "may" be stale
- JSON output must expose enough detail for automation to distinguish `fresh`, `stale`, and `unavailable`
- degraded/offline wording should align with the issue guidance: explicit offline/unavailable semantics instead of silent reuse of old state
- normal healthy runs should remain concise and not regress existing `status` readability

## Implementation Steps

1. add a focused freshness model in `src/observability/status.ts` that classifies snapshot state from snapshot facts plus current runtime facts known to readers
2. extend the status snapshot schema or the control status JSON shape with explicit freshness/degradation fields and parse/render support
3. update orchestrator startup so a new worker instance invalidates or replaces any inherited snapshot before normal polling resumes
4. update `src/cli/factory-control.ts` to consume the shared classifier and render unmistakable stale/unavailable messaging for human output and JSON
5. update any direct `status` command behavior, if needed, so stale files outside active control are still clearly identified
6. add or extract small helpers/builders in tests to keep restart scenarios readable
7. document the restart-safe freshness behavior in `README.md` and any relevant observability docs

## Tests

### Unit

- freshness classification from `generatedAt`, `worker.instanceId`, current authoritative worker identity, and PID liveness
- parser/renderer coverage for explicit stale and unavailable states
- control rendering coverage for:
  - live worker with fresh snapshot
  - dead worker with stale snapshot
  - restart in progress with no valid current snapshot

### Integration

- factory control/status inspection with a leftover snapshot from a previous worker instance and a new live session that has not yet published
- clean shutdown followed by restart where the snapshot becomes unavailable or stale briefly and then fresh once republished
- unclean shutdown leaving a stale snapshot file that is clearly reported until a new worker reclaims ownership

### End-to-End

- detached factory restart with a preexisting status snapshot from an old worker; verify the operator-visible status surface does not present the stale snapshot as current and converges to fresh after restart
- healthy run regression proving normal `factory status` output remains unchanged apart from the new explicit freshness fields

## Acceptance Scenarios

1. Clean stop, then restart
   - before the new worker publishes, `factory status` shows `degraded` with explicit `unavailable` or `stale` detail
   - after the new worker publishes, `factory status` shows `running` with a `fresh` snapshot from the new instance
2. Unclean stop leaves leftover snapshot
   - with no live runtime, `factory status` shows stopped/offline plus explicit stale snapshot detail
3. Live healthy runtime
   - `factory status` shows the current worker and a `fresh` snapshot without degraded warnings
4. Corrupt or unreadable snapshot during a live runtime
   - `factory status` shows `degraded` and surfaces the unreadable snapshot problem explicitly

## Exit Criteria

- restart-safe freshness semantics are encoded in the checked-in status contract and/or emitted JSON control output
- the CLI makes stale or unavailable status unmistakable without consulting GitHub, process trees, or timestamps manually
- startup/restart no longer leaves a prior worker snapshot looking current
- unit, integration, and end-to-end tests cover healthy, stale, and restart-recovery paths

## Deferred To Later Issues Or PRs

- richer TUI consumption of freshness/offline states
- automated remediation beyond narrow startup invalidation
- historical retention/rotation of old snapshots
- cross-machine or multi-factory coordination semantics

## Decision Notes

- Keep the source of truth layered: the orchestrator remains the authority for live runtime state, while observability owns how that state is persisted and rendered.
- Prefer explicit ownership signals over time-window heuristics alone. `generatedAt` is useful context, but restart safety should hinge on instance identity and explicit invalidation, not "recent enough" timestamps.
- Keep the PR narrow. If implementation reveals a need for a larger process-control refactor, that work should be split rather than folded into this observability slice.
