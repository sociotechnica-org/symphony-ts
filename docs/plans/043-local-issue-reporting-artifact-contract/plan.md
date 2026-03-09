# Issue 43 Plan: Local Issue Reporting Artifact Contract

## Objective

Define the first durable, local-only issue reporting artifact contract under `.var/factory/issues/<issue-number>/...` so the runtime can emit raw issue facts now and a later CLI can render reports from those facts without changing orchestrator control flow.

## Scope

This slice covers:

1. a stable local directory layout for one issue under gitignored repo state
2. canonical raw file contracts for `issue.json`, `events.jsonl`, per-attempt files, per-session files, and log-pointer metadata
3. a provider-neutral observability writer that persists those files atomically and durably enough for later read-side tooling
4. orchestrator integration that emits raw lifecycle facts the current runtime already knows without adding report-rendering logic
5. tests and docs for the local contract and path rules

## Non-goals

This slice does not include:

1. rendering a final `report.md`
2. publishing artifacts to `factory-runs` or any remote store
3. storing raw provider logs inside the core contract
4. deep Codex-specific parsing or model/provider enrichment beyond normalized session metadata
5. redesigning orchestrator retry, review-loop, or tracker policy
6. a general analytics or dashboard surface over the artifacts

## Current Gaps

Today `symphony-ts` has one local observability artifact: the derived factory status snapshot under `.tmp/status.json`. It does not yet have per-issue durable reporting state:

1. issue-level lifecycle facts are scattered across tracker state, local runner output, and in-memory orchestrator transitions
2. there is no append-only event history per issue
3. there is no canonical per-attempt or per-session artifact contract for later report generation
4. raw provider logs are only implicit in runner stdout/stderr handling and are not represented as normalized pointers
5. the repo does not yet reserve `.var/factory/issues/...` as stable local state

## Spec / Layer Mapping

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_43/docs/architecture.md).

- Policy Layer: repo-owned guidance already says reporting artifacts are local observability state and raw facts only. This issue does not add new tracker or orchestration policy.
- Configuration Layer: no workflow schema change in this slice; the artifact root is derived from the long-lived repo-local factory root that sits alongside `.tmp/`, not from any cleanup-managed issue workspace path.
- Coordination Layer: the orchestrator remains the source of runtime transitions, but it only emits facts to the artifact writer; it must not gain report-rendering or tracker-specific policy branches here.
- Execution Layer: runner and workspace layers may contribute normalized session/workspace facts, but they do not own issue-report persistence or reporting policy.
- Integration Layer: tracker-derived lifecycle facts may be reused only in normalized form already exposed to the runtime; provider-specific parsing stays at the edge and deeper enrichment is deferred.
- Observability Layer: owns the artifact schema, file layout, write/read helpers, atomic persistence, and the durable contract consumed later by report generation.

## Architecture Boundaries

### Observability

Belongs here:

1. contract types for issue, event, attempt, session, and log-pointer artifacts
2. path helpers for `.var/factory/issues/<issue-number>/...` rooted outside `.tmp/workspaces/`
3. atomic writers and readers for JSON and JSONL files
4. idempotent append/update behavior for durable local facts

Does not belong here:

1. dispatch or retry decisions
2. tracker-specific parsing rules beyond normalized inputs handed to it
3. markdown or polished report rendering

### Orchestrator

Belongs here:

1. calling the artifact writer on meaningful runtime transitions already owned by the orchestrator
2. passing normalized issue, attempt, lifecycle, and runner-session facts into observability helpers

Does not belong here:

1. filesystem layout rules inline inside control-flow branches
2. report formatting
3. provider-specific log parsing

### Runner

Belongs here:

1. exposing normalized spawn/session facts already known at launch time
2. exposing raw log pointer inputs when available without making raw logs part of the contract

Does not belong here:

1. deciding artifact paths
2. parsing provider-specific logs into report-friendly summaries

### Tracker

Belongs here:

1. continuing to normalize plan-review and PR lifecycle state at the tracker edge
2. exposing only the normalized facts the orchestrator already consumes

Does not belong here:

1. writing issue artifacts directly
2. coupling GitHub comment or PR transport details into the artifact schema

### Workflow / Config

Belongs here:

1. no schema change in this slice
2. documentation updates describing the local artifact root

Does not belong here:

1. a new reporting configuration surface before the contract exists

## Slice Strategy

This issue should land as one reviewable PR because it stays on one narrow seam: durable local observability state rooted in the factory runtime area rather than workspace lifecycle state.

The PR should include:

1. the artifact schema and storage helpers in `src/observability/`
2. the minimal runtime wiring needed to emit those artifacts from existing transitions
3. tests for the storage contract and runtime emission behavior
4. repo-local docs and `.gitignore` updates for `.var/`

The PR should explicitly defer:

1. report rendering
2. remote publication
3. provider-specific parsing and enrichment for later issue `#46`
4. any broader status-surface redesign

## Runtime Write Model

This slice does not change the orchestrator state machine, but it does need an explicit write model so artifacts are stable across retries and repeated polls.

### Durable issue artifact states

1. `absent`: no artifact directory exists yet for the issue
2. `active`: base issue directory exists and contains the current issue summary plus zero or more events, attempts, and sessions
3. `waiting`: the latest current state in `issue.json` reflects a non-terminal waiting or handoff state such as plan review or PR review
4. `terminal`: `issue.json` records a terminal outcome while historical events, attempts, and sessions remain preserved

### Allowed write transitions

1. `absent -> active`: first observed issue fact creates the directory tree and `issue.json`
2. `active -> active`: append a new lifecycle event, update `issue.json`, and upsert the current attempt/session snapshots
3. `active -> waiting`: update `issue.json` current state and append a waiting-state event only when the normalized lifecycle meaning changes
4. `active|waiting -> active`: append a new attempt or runner/session event when the issue resumes
5. `active|waiting -> terminal`: append a terminal event, finalize the current attempt snapshot, and update `issue.json`

### Idempotency rules

To avoid poll-loop duplication:

1. `issue.json`, `attempts/<n>.json`, `sessions/<id>.json`, and `logs/pointers.json` are upserted atomically
2. `events.jsonl` is append-only, but only for newly observed lifecycle transitions or one-shot facts
3. repeated observation of the same waiting/review state on later polls must not append duplicate events forever
4. PR-opened and review-feedback events should be keyed from normalized facts already available to the runtime, not raw transport payloads

## Failure-Class Matrix

| Observed condition                                                | Local facts available                                               | Expected behavior                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| First artifact write for an issue                                 | no issue directory yet                                              | create the directory tree and write the base snapshots atomically                                                                  |
| Runtime revisits the same issue/attempt                           | existing `issue.json` and attempt/session files present             | upsert snapshots in place and avoid duplicating append-only events for unchanged lifecycle state                                   |
| New attempt starts after retry                                    | prior attempts already persisted                                    | create `attempts/<new-attempt>.json`, preserve prior attempt files, append one retry-scheduled event                               |
| Session metadata becomes available before any raw log path exists | runner session id and spawn facts available, no raw-log pointer yet | write the session file with null/empty log pointers; later update `logs/pointers.json` or the session file when pointers are known |
| Raw artifact write fails                                          | runtime still has in-memory facts                                   | surface a typed observability failure and structured log context; do not invent new orchestration policy in this slice             |
| Poll observes the same waiting lifecycle repeatedly               | existing artifact files show the same lifecycle meaning             | update current timestamps only where needed, but do not append a new duplicate lifecycle event on every poll                       |

## Storage Contract

Introduce a versioned issue-artifact contract rooted at:

```text
.var/factory/
  issues/
    <issue-number>/
      issue.json
      events.jsonl
      attempts/
        <attempt-number>.json
      sessions/
        <session-id>.json
      logs/
        pointers.json
```

### Contract rules

1. `.var/` is gitignored local state rooted at the repo/factory runtime boundary, not inside any issue workspace directory
2. all JSON documents should carry a schema version for later read-side compatibility
3. `issue.json` is the latest summary for one issue, not a historical log
4. `events.jsonl` is the append-only historical ledger for the issue
5. attempt and session files are stable per-key snapshots, not log streams
6. `logs/pointers.json` stores references to raw logs or later archive locations, not the raw logs themselves

### `issue.json`

Minimum fields:

1. schema version
2. issue number / identifier / repo / title / branch
3. current outcome or current waiting state
4. first observed timestamp
5. last updated timestamp
6. latest attempt number
7. latest session id when present

### `events.jsonl`

Each line should record:

1. schema version
2. event kind
3. issue number
4. observed timestamp
5. attempt number when applicable
6. session id when applicable
7. normalized event details object

The contract should reserve stable event kinds including:

- `claimed`
- `plan-ready`
- `approved`
- `waived`
- `runner-spawned`
- `pr-opened`
- `review-feedback`
- `retry-scheduled`
- `succeeded`
- `failed`

The initial implementation may emit only the subset the current runtime can observe cleanly without new provider-specific parsing, but the schema must reserve the broader vocabulary now.

### `attempts/<attempt-number>.json`

Minimum fields:

1. schema version
2. attempt number
3. started / finished timestamps
4. attempt outcome
5. runner/session references
6. last known PR and review snapshot when relevant

### `sessions/<session-id>.json`

Minimum fields:

1. schema version
2. session id
3. provider and model when known
4. start / end timestamps when known
5. workspace and issue references
6. pointers to raw logs when known

### `logs/pointers.json`

Minimum fields:

1. schema version
2. issue number
3. known raw log pointer entries keyed by session id or logical log name
4. archive pointers when later publication exists

## Observability Requirements

1. artifact writes should be atomic enough that later readers do not observe truncated JSON files
2. the contract must be durable across process restarts, retries, and workspace cleanup
3. the write path must remain provider-neutral and runner-neutral at the core boundary
4. structured logs should report artifact write failures with issue, attempt, and session context
5. later report generation should be able to read only `.var/factory/issues/<issue-number>/...` without replaying orchestrator control flow

## Implementation Steps

1. Add issue-artifact domain types and path helpers in `src/observability/`.
2. Add a focused local artifact store/writer with:
   - directory creation
   - atomic JSON writes
   - append-only JSONL writes
   - idempotent event appends based on existing persisted state
3. Derive the artifact root from the long-lived repo-local factory root so the final path is `<repo>/.var/factory/issues/<issue-number>/...`; infer that root from the configured workspace root without placing artifacts anywhere under `.tmp/workspaces/`.
4. Extend orchestrator transitions to emit:
   - issue summary updates
   - attempt lifecycle snapshots
   - runner/session metadata
   - lifecycle events the runtime already observes cleanly
5. Keep raw log handling pointer-only in this slice.
6. Update `.gitignore` and `README.md` to document the local artifact root and its purpose.
7. Add tests for path derivation, contract serialization, idempotent event writing, and orchestrator-driven artifact emission.

## Tests And Acceptance Scenarios

### Unit

1. artifact path helpers derive `<repo>/.var/factory/issues/<issue-number>` from the repo/factory root inferred from config and never place artifacts under `.tmp/workspaces/<issue>/...`
2. atomic JSON writers create the required directory tree and preserve valid JSON on rewrite
3. event writer appends new events and suppresses duplicates for unchanged waiting/review state
4. attempt/session/log-pointer writers upsert the expected contract shape

### Integration

1. a successful issue run produces `issue.json`, `events.jsonl`, `attempts/1.json`, and `sessions/<id>.json` with normalized fields
2. a retrying issue preserves attempt `1`, creates attempt `2`, and appends `retry-scheduled` once
3. a waiting-for-review lifecycle writes `issue.json` current state plus one waiting/review event without duplicate appends on repeated polls
4. after workspace cleanup removes `.tmp/workspaces/<issue>`, the `.var/factory/issues/<issue-number>/...` artifacts remain readable and unchanged

### End-to-end / Repo gate

1. `.var/` is gitignored local state and not introduced as tracked source
2. later tooling could consume the per-issue directory without reading `.tmp/status.json`
3. `pnpm format`
4. `pnpm lint`
5. `pnpm typecheck`
6. `pnpm test`
7. `codex review --base origin/main`

## Exit Criteria

1. one canonical local issue-artifact contract exists under `.var/factory/issues/<issue-number>/...`
2. the runtime writes durable raw facts for issues, attempts, sessions, and event history without coupling report rendering into orchestrator control flow or tying artifact lifetime to workspace cleanup
3. the artifact schema is provider-neutral and keeps raw provider logs out of the core contract
4. the contract is documented and gitignored
5. tests cover both the storage helpers and the runtime emission behavior

## Deferred Work

1. `report.md` or any other polished report rendering
2. remote publication or archive syncing
3. provider-specific session/log parsing and enrichment in issue `#46`
4. expanding the read side into a dedicated reporting CLI
5. any configuration surface for alternate artifact roots if the default local contract proves insufficient

## Decision Notes

1. Derive the artifact root from the repo-local factory runtime boundary, not from issue workspaces, so cleanup-managed `.tmp/workspaces/...` paths can be deleted without losing reporting artifacts.
2. Keep event vocabulary broader than the first emitted subset so later tracker- or provider-specific enrichment can extend data coverage without changing the on-disk layout.
3. Treat these files as observability artifacts, not coordination state; the runtime may read them for idempotent writes, but orchestration decisions should continue to use normalized runtime and tracker facts.

## Revision Log

- 2026-03-09: Initial plan drafted for the local issue reporting artifact contract.
- 2026-03-09: Revised after review to move artifacts to the long-lived repo-level factory root and require a workspace-cleanup survival scenario.
