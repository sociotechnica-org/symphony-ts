# Issue 39 Plan: Runner Visibility Contract And Rich Worker Status

## Status

- approved

## Goal

Define a stable internal runner-visibility contract and use it to expose richer worker-level execution state in the factory status snapshot without coupling the status surface to Codex-specific process details.

## Scope

- define a normalized runner-visibility shape in `src/runner/` that can represent:
  - runner state
  - current phase
  - session identity
  - last heartbeat
  - last meaningful action
  - waiting reason
  - stdout/stderr summary
  - error state
  - cancellation / timeout state
- implement the contract for the local Codex runner path first, using normalized facts rather than raw subprocess internals in observability code
- thread the visibility snapshot through the orchestration/runtime state so the factory status snapshot can expose it per active issue
- extend status rendering and parsing so operators can tell what a live worker is doing from `.tmp/status.json` and `symphony status`
- add contract tests that prove the visibility shape is runner-neutral and local-runner projection tests that lock in the first implementation

## Non-goals

- tracker transport, normalization, or lifecycle policy changes
- Beads-specific behavior
- a major TUI or dashboard redesign
- deep historical analytics or long-term event storage
- remote runner protocol work
- changing retry budgets, continuation policy, or handoff lifecycle semantics beyond surfacing existing outcomes in visibility state

## Current Gaps

- `RunnerSessionDescription` captures static/session metadata, but it does not describe what a worker is doing right now
- the status snapshot currently exposes only coarse issue-level fields such as `runnerPid`, `summary`, and `blockedReason`
- operator-facing status output cannot distinguish useful worker states such as:
  - app server starting
  - prompt turn actively running
  - waiting on tracker reconciliation
  - cancelled or timed out turn
  - latest meaningful worker action and heartbeat freshness
- current orchestration code records spawn events and final turn results, but it does not maintain a normalized live visibility object that observability can consume directly
- tests lock in the status snapshot contract, but not a provider-neutral runner visibility sub-shape

## Decision Notes

- This issue should build on the provider-neutral runner seam from `#89` rather than reopening runner backend selection or general contract extraction.
- The first slice should keep the visibility contract small and current-state oriented. Historical event timelines remain deferred.
- The orchestrator should consume and persist a normalized visibility object; observability should render that object and must not inspect Codex app-server internals directly.
- The local Codex implementation may derive heartbeat/action updates from app-server lifecycle facts and turn boundaries, but those facts must be projected into stable provider-neutral fields before they reach the status snapshot.
- Providers without reusable backend sessions must still be able to implement the contract by setting optional identity fields to `null`.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the issue scope, the rule that visibility is provider-neutral, and the decision to expose only current worker state in this slice
  - does not belong: Codex app-server startup details or tracker-specific handoff rules
- Configuration Layer
  - belongs: unchanged existing runner timeout/max-turn settings already resolved from `WORKFLOW.md`
  - does not belong: new workflow config fields or provider-specific status toggles in this slice
- Coordination Layer
  - belongs: runtime ownership of the current runner-visibility snapshot per active issue and the transitions that update it as a run progresses
  - does not belong: parsing provider-specific stdout formats or tracker transport behavior
- Execution Layer
  - belongs: the runner-visibility contract, runner-side projection helpers, and backend-specific code that maps provider facts into normalized visibility
  - does not belong: tracker mutations, prompt rendering, or operator-surface formatting
- Integration Layer
  - belongs: untouched in this slice; tracker adapters remain unaware of runner visibility internals
  - does not belong: runner visibility translation or status formatting
- Observability Layer
  - belongs: status snapshot schema/rendering/parsing for the normalized visibility contract
  - does not belong: reading live runner process state directly or inferring backend semantics from raw logs

## Architecture Boundaries

### Belongs in this issue

- `src/runner/service.ts`
  - add provider-neutral runner visibility types and update event/result types only as needed to support normalized visibility updates
- `src/runner/`
  - implement the local Codex projection into the visibility contract
- `src/orchestrator/`
  - store/update the current visibility snapshot for each active issue and persist it into status state
- `src/observability/status.ts`
  - extend the status snapshot contract, parser, and terminal rendering for the normalized visibility fields
- `tests/unit/runner-contract.test.ts`
  - add runner-neutral shape tests for the visibility contract
- `tests/unit/status.test.ts` and `tests/unit/orchestrator.test.ts`
  - verify snapshot parsing/rendering and orchestration updates
- docs
  - update any text that still describes the status surface as only coarse process visibility

### Does not belong in this issue

- `src/config/` runner selection or UX changes
- tracker lifecycle policy changes
- PR review / CI follow-up logic changes
- a second new runner implementation beyond local Codex coverage
- report-generation artifact redesign

## Layering Notes

- `config/workflow`
  - keeps producing runner config and timeout settings
  - does not gain visibility-specific knobs in this slice
- `tracker`
  - remains the source of issue/PR lifecycle facts
  - does not store or interpret runner visibility state
- `workspace`
  - continues to own workspace preparation only
  - does not manage worker visibility semantics
- `runner`
  - owns normalized visibility projection for backend execution state
  - does not own tracker lifecycle summaries or status rendering
- `orchestrator`
  - owns when the active-issue visibility snapshot changes and when it is persisted
  - does not read backend-specific internals directly
- `observability`
  - renders the normalized visibility contract
  - does not inspect child processes, session logs, or provider-specific wire payloads at render time

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one seam:

1. add a provider-neutral current-visibility contract at the runner boundary
2. populate it for the local Codex path
3. expose it in the status snapshot and terminal rendering
4. lock it in with runner/orchestrator/status tests

This stays reviewable because it does not combine:

- status-surface enrichment with tracker changes
- status-surface enrichment with a new runner backend
- status-surface enrichment with retry-state redesign
- status-surface enrichment with historical analytics or dashboard work

## Runner Visibility State Model

This issue introduces explicit current-state visibility for a live worker session.

### States

- `idle`
  - session exists but no backend work has started yet
- `starting`
  - backend session or subprocess is launching
- `running`
  - a runner turn is actively executing
- `waiting`
  - the worker is healthy but blocked on an external or orchestration-controlled reason
- `completed`
  - the latest turn completed successfully and no active execution is in progress
- `failed`
  - the latest turn or backend session failed
- `cancelled`
  - the latest turn was cancelled by shutdown or explicit abort
- `timed-out`
  - the latest turn exceeded timeout and was terminated

### Phases

- `boot`
- `session-start`
- `turn-execution`
- `turn-finished`
- `handoff-reconciliation`
- `awaiting-external`
- `shutdown`

The exact phase set can stay small, but the contract should distinguish backend startup, active turn execution, and healthy waiting.

### Required fields

- `state`
- `phase`
- `session`
  - normalized provider/model/backend ids already known for the run
- `lastHeartbeatAt`
- `lastActionAt`
- `lastActionSummary`
- `waitingReason`
- `stdoutSummary`
- `stderrSummary`
- `errorSummary`
- `cancelledAt`
- `timedOutAt`

### Allowed transitions

- `idle -> starting`
- `starting -> running`
- `starting -> failed`
- `running -> waiting`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `running -> timed-out`
- `waiting -> running`
- `waiting -> completed`
- `waiting -> failed`
- `completed -> running`
  - when a continuation turn begins

### Contract rules

- visibility must be representable without a PID or reusable backend session id
- heartbeat and action fields must be safe to leave `null` when a backend cannot provide them yet
- stdout/stderr are summaries, not full logs; observability must not rely on them as canonical artifacts
- waiting reasons must be normalized labels/summaries, not backend-specific raw strings when a stable internal label exists

## Failure-Class Matrix

| Observed condition                                                    | Local facts available                       | Normalized runner visibility                                               | Expected decision                                                       |
| --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| backend process not yet spawned                                       | run session exists, no child pid            | `state=starting`, `phase=session-start`, no session id yet                 | show active startup state in status, not a failure                      |
| turn actively executing with no fresh stdout                          | run session, turn number, heartbeat updates | `state=running`, `phase=turn-execution`, heartbeat present                 | show live execution rather than coarse "running" only                   |
| turn finishes and tracker reconciliation begins                       | turn result available, tracker call pending | `state=waiting`, `phase=handoff-reconciliation`, waiting reason set        | show healthy waiting state instead of appearing idle                    |
| shutdown abort fires during a turn                                    | abort signal observed, cleanup running      | `state=cancelled`, `phase=shutdown`, cancelled timestamp and error summary | show cancelled state and preserve failure path                          |
| timeout fires during a turn                                           | timeout window elapsed, cleanup running     | `state=timed-out`, `phase=shutdown`, timed-out timestamp and error summary | surface timeout explicitly in status and failure artifacts              |
| adapter cannot derive provider session metadata after successful work | stdout/stderr, provider known               | `state=failed`, `errorSummary` populated                                   | fail at adapter boundary; do not make observability infer missing state |

## Storage / Persistence Contract

- extend the in-memory active-issue status state with a nullable `runnerVisibility` object
- extend `.tmp/status.json` snapshot version only if the parser cannot remain backward-compatible; otherwise prefer additive backward-compatible fields under version `1`
- keep issue artifacts and other stored contracts unchanged unless a minimal additive visibility field is required for consistency
- treat the status snapshot as the operator-facing current-state contract, not the system of record for historical execution

## Observability Requirements

- `symphony status --json` must expose the normalized runner-visibility shape for active issues
- terminal rendering must summarize the most useful worker facts without requiring operators to inspect raw subprocess state
- missing optional visibility fields must render clearly as unavailable rather than implying failure
- observability code must parse and render normalized visibility only; it must not inspect provider-specific process details directly

## Implementation Steps

1. Define provider-neutral runner visibility types in `src/runner/service.ts`, including state/phase enums and the normalized current-visibility payload.
2. Add runner-side or orchestrator-side helpers that update visibility in response to:
   - session creation
   - spawn events
   - active turn start
   - heartbeat / meaningful action updates where available
   - turn completion, failure, cancellation, and timeout
   - tracker reconciliation waiting
3. Extend the local Codex path to populate the visibility contract using backend facts already available from the app-server session and turn lifecycle.
4. Thread the normalized visibility object through active-issue runtime state in `src/orchestrator/status-state.ts` and related orchestration call sites.
5. Extend `src/observability/status.ts` to parse, validate, and render the additive visibility fields in the status snapshot.
6. Add tests for:
   - runner-neutral visibility shape with a fake provider
   - local Codex visibility projection
   - orchestration updates into the status snapshot
   - snapshot parsing/rendering for new visibility fields
7. Update README or relevant docs to note that the status surface now includes normalized worker-level runner visibility.

## Tests And Acceptance Scenarios

### Unit tests

- a fake runner provider can populate the visibility contract without Codex-specific fields
- the local Codex runner/session reports normalized visibility transitions for startup, active turn, and completion or failure
- status snapshot parsing accepts the new visibility object and rejects invalid field types
- terminal status rendering includes useful worker visibility summaries when present
- orchestrator status updates persist visibility changes without requiring observability code to inspect raw process state

### Integration / end-to-end coverage

- keep existing runner/orchestrator/status suites green with the enriched snapshot shape
- if a realistic local-runner orchestration fixture already exists, assert that a live active issue exposes worker visibility in `.tmp/status.json`

### Acceptance scenarios

1. An operator running `symphony status` during a live worker turn can tell the worker is starting, executing, or waiting without inspecting process internals.
2. A timeout or cancellation shows up in normalized worker visibility state rather than only as a coarse issue summary.
3. A provider-neutral fake runner satisfies the visibility contract shape with optional ids left `null`.
4. The status snapshot remains provider-neutral and does not require Codex-specific parsing in observability code.

## Exit Criteria

- a stable internal runner-visibility contract exists in code
- the local runner path populates the contract
- the factory status snapshot exposes the new visibility fields
- terminal and JSON status surfaces show enough worker context to understand what a live worker is doing
- tests lock in the contract shape and local projection behavior

## Deferred To Later Issues Or PRs

- alternate runner implementations beyond the local Codex path
- historical worker event timelines and analytics
- dashboard/TUI redesign work
- tracker-surfaced or remotely published worker visibility
- richer report-generation integration for runner visibility beyond the live status snapshot
