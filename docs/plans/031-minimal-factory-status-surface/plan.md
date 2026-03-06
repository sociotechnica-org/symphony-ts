# Phase 1.3.3 Technical Plan: Minimal Factory Status Surface

## Goal

Add a minimal operator-facing factory status surface that lets a human inspect current Symphony activity locally without reading structured logs by hand.

The first slice should establish one authoritative runtime snapshot contract and expose it through:

1. a machine-readable local snapshot, and
2. one simple human-readable terminal view.

## Scope

Required outcomes for issue `#31`:

1. define a canonical runtime status snapshot owned by the runtime rather than by a separate UI model
2. capture enough live factory state to answer basic operator questions about what Symphony is doing
3. expose a local machine-readable snapshot that later TUI or web surfaces can reuse
4. expose one synchronous terminal-oriented status command for immediate human use
5. cover the snapshot and terminal output with tests that reflect real orchestration state

## Non-Goals

This issue does not include:

1. a long-running interactive TUI
2. a web dashboard or HTTP server
3. operator controls such as retry, pause, cancel, or claim
4. historical analytics or persisted time-series metrics
5. a second state model derived from `.ralph` notes or other operator context files
6. deep Codex token/rate-limit accounting beyond what the current TypeScript runtime actually tracks

## Product Constraints

This plan follows the issue decisions already recorded on GitHub:

1. terminal-first before any web UI
2. one canonical machine-readable snapshot first
3. read-only human surface in v1
4. source of truth is runtime state, not notes files
5. local-only first slice
6. minimum useful fields include factory health, worker/session info, active issue, counts, active PR summary, checks/review summary, runner presence, last update time, and blocked reason

## Current Gaps

Today the runtime has no direct operator visibility surface beyond logs:

1. the orchestrator keeps dispatch and retry state in memory, but does not expose a synchronous runtime snapshot
2. active run ownership is partly durable through issue leases, but there is no operator-readable synthesis of owner PID, runner PID, session id, or workspace path
3. PR lifecycle state is only visible indirectly through logs and issue/PR inspection
4. the CLI only supports `run`, so there is no first-class way to inspect current factory state locally
5. there is no single contract that a future TUI or web UI could consume without re-reading coordination files directly

## Architecture Boundaries

### Config / Workflow

Belongs here:

- CLI option parsing for a status command and optional output path overrides
- any explicit workflow/config needed for status file placement if the current runtime needs it

Does not belong here:

- live snapshot assembly
- tracker or orchestration policy

### Tracker

Belongs here:

- returning normalized issue and pull-request lifecycle data already needed for runtime decisions

Does not belong here:

- formatting status output
- persisting operator-facing snapshots
- keeping separate UI-only state

### Workspace

Belongs here:

- deterministic workspace paths already used by the runtime

Does not belong here:

- rendering status
- synthesizing orchestration summaries

### Runner

Belongs here:

- spawned process metadata and run session result details already observable through the runner contract

Does not belong here:

- deciding what counts as factory health
- maintaining a dashboard-specific session model

### Orchestrator

Belongs here:

- owning the authoritative runtime snapshot
- combining current in-memory state, durable lease state, and tracker-derived follow-up state into one read model
- updating snapshot state on meaningful transitions

Does not belong here:

- terminal formatting details beyond emitting the snapshot contract
- tracker-specific presentation quirks

### Observability

Belongs here:

- snapshot types and assembly helpers
- local snapshot persistence
- terminal rendering from the canonical snapshot

Does not belong here:

- dispatch decisions
- retry policy
- tracker mutation logic

## Canonical Snapshot Contract

Introduce one synchronous factory snapshot that is cheap to compute and stable enough for later reuse.

### Top-Level Shape

The first slice should include:

1. factory summary
2. worker identity and liveness metadata
3. active run rows
4. retry queue rows
5. aggregate issue counts relevant to the local operator
6. last runtime action

### Factory Summary

Minimum fields:

- `generatedAt`
- `factoryState` (`idle`, `running`, or `blocked`)
- `worker`
  - `instanceId`
  - `pid`
  - `startedAt`
  - `pollIntervalMs`
  - `maxConcurrentRuns`
- `counts`
  - `ready`
  - `running`
  - `failed`
  - `activeLocalRuns`
- `lastAction`
  - normalized action kind
  - short summary
  - timestamp
  - issue number when applicable

### Active Run Rows

Each running row should expose the minimum operator-useful facts already owned by the runtime:

- issue number / identifier / title
- current run sequence
- source (`ready` vs `running`)
- workspace path
- branch name
- run session id
- owner PID
- runner PID
- started at / latest update at
- current status summary
- active PR summary when known
- checks summary when known
- review summary when known
- blocked reason when applicable

### Retry Rows

Each retry row should include:

- issue number / identifier
- next attempt number
- due at timestamp
- last error summary

## Runtime State Model

This feature should not invent a parallel orchestration model. Instead it should expose a read model over existing runtime state plus a few explicit observability fields.

### New Explicit State

Add a focused runtime-status state module that records:

1. worker start time
2. last meaningful orchestrator action
3. active run metadata keyed by issue number
4. most recent observed PR lifecycle summary per issue
5. latest tracker counts observed during polling

The existing orchestrator state for running issues, retries, follow-up budgets, and run abort controllers remains authoritative for coordination.

### Allowed Transition Updates

The observability state should update on:

1. poll start and poll result
2. issue claim or running-issue resume
3. run start
4. runner spawn
5. lifecycle observation while awaiting review or needing follow-up
6. retry scheduling
7. completion
8. failure
9. recovery/orphan reconciliation decisions

## Failure-Class Matrix

| Observed condition                               | Local facts available                                       | Tracker facts available                      | Expected status behavior                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Factory is idle with no local runs               | no active run rows, no due retries                          | ready/running counts may be zero or non-zero | snapshot reports `idle` and last poll result                                                              |
| Run is active with spawned runner                | active run metadata, owner PID, runner PID                  | issue and PR lifecycle                       | snapshot row reports runner presence and current PR/check summary                                         |
| Issue is running but awaiting CI or human review | no active local runner, lifecycle cached as awaiting review | PR lifecycle says waiting                    | snapshot reports issue under active/blocked surface with blocked reason and last action `awaiting-review` |
| Retry is scheduled after failure                 | retry queue entry present                                   | tracker still has running issue              | snapshot reports retry row with due time and error summary                                                |
| Orphan reconciliation finds stale ownership      | lease reconciliation says stale or invalid                  | running issue still present                  | snapshot last action records recovery decision; no hidden UI-only repair state                            |
| Snapshot write or render fails                   | runtime still has in-memory snapshot                        | tracker facts unchanged                      | emit warning log; orchestration continues because status surface is optional                              |

## Storage / Persistence Contract

The first slice should persist one local JSON snapshot file, for example under `.tmp/status.json`.

Rules:

1. the file is a derived view, not authoritative runtime state
2. writes should be atomic enough that readers do not see truncated JSON
3. missing or stale snapshot files are acceptable outside a running worker and should be presented clearly by the CLI
4. the terminal view should prefer reading the current in-process snapshot when invoked inside the worker path, but the local JSON file is the stable interoperability contract for later surfaces

## Observability Requirements

1. logs remain structured and separate from the status surface
2. snapshot generation must be cheap enough to run on every meaningful runtime transition and at least once per poll
3. the human-readable view must be synchronous and readable in a normal terminal without extra dependencies
4. the status contract should leave room for richer fields later without breaking the v1 meaning of the existing ones

## Implementation Steps

1. add explicit runtime status domain types for factory snapshot, run rows, retry rows, and last action
2. add a focused observability/status module that can build and atomically write the JSON snapshot
3. extend orchestrator runtime state with the minimum observability metadata needed for the snapshot
4. update orchestrator transitions to record last action, active run summaries, lifecycle observations, and tracker counts
5. expose a snapshot reader and simple terminal renderer for a new CLI status command
6. document the local status workflow in `README.md`

## Tests And Acceptance Scenarios

### Unit

1. snapshot builder returns the expected machine-readable shape for idle, running, awaiting-review, and retrying states
2. terminal renderer includes worker, issue, PR, checks, review, and last-action summaries without depending on logs
3. snapshot writer handles atomic rewrite behavior and stable serialization

### Integration

1. CLI status command renders the local snapshot when the JSON file exists
2. CLI status command returns valid JSON when asked for machine-readable output
3. CLI status command handles missing snapshot files with a clear operator-facing message

### End-to-End

1. after a factory poll claims and starts one issue, a human can inspect the status locally and see the active issue, branch, workspace, and runner/session info
2. after a PR opens and the runtime is waiting on checks or review, the status view shows the active PR summary plus blocked reason without needing log inspection
3. after a failed attempt schedules a retry, the status view shows the retry row and next attempt timing

## Exit Criteria

This issue is complete when:

1. the runtime emits one canonical machine-readable status snapshot from authoritative runtime state
2. a local operator can run one CLI command to inspect the current factory state without parsing logs
3. the status includes worker/session info, active issue, active PR, checks/review state, and last action
4. tests cover idle, active, waiting, and retrying status scenarios
5. the design leaves room for a future richer TUI or web UI without redefining the state contract

## Decision Notes

1. Use a derived JSON snapshot file rather than an always-live terminal process as the first reusable contract. This keeps the initial slice small and future-UI-friendly.
2. Keep status state inside orchestrator-owned observability structures rather than re-reading logs or tracker data ad hoc in the CLI. This preserves one source of truth.
3. Treat waiting-for-review/checks as visible factory activity even when no agent subprocess is currently running. For the operator, that issue is still the active factory work item.
