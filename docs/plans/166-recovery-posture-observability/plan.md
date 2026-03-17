# Issue 166 Plan: Recovery Posture Observability And Status Projection

## Status

- plan-ready

## Goal

Project recovery posture as a first-class operator read model across `factory status`, the persisted status JSON, and the watch/TUI surface so operators can distinguish healthy waiting, restart reconciliation, retry/backoff, watchdog-driven recovery, degraded observability, and terminal cleanup posture without reconstructing state from scattered logs, retry entries, and action summaries.

This slice follows `#127`, `#130`, `#133`, `#163`, `#164`, and `#165`. Those issues made individual runtime seams explicit, but the operator surface still exposes them as separate clues instead of one coherent recovery/status vocabulary.

## Scope

- define a normalized recovery-posture read model for factory-level and issue-level projection
- derive that read model from existing coordination-owned state where it already exists:
  - restart recovery state and decisions
  - queued retry/backoff state
  - normalized active-issue lifecycle and runner visibility
  - watchdog recovery/exhaustion facts
  - workspace retention / terminal cleanup outcomes
  - snapshot freshness and publication state for degraded observability
- add only the minimum new coordination-owned status facts needed where posture is not currently persisted, especially terminal cleanup outcomes after an issue leaves the active set
- expose the read model consistently in:
  - `status --json`
  - text status rendering
  - detached control/status surfaces that embed the status renderer
  - watch/TUI output
- add regression coverage for representative posture combinations and operator-visible wording

## Non-Goals

- changing restart recovery, retry/backoff, watchdog, or workspace retention policy
- redesigning tracker transport, normalization, or lifecycle policy
- inventing a new UI-only inference engine that guesses recovery state from logs or stale artifacts
- redesigning the full TUI layout beyond the additions needed to render recovery posture
- introducing new workflow/config knobs unless implementation reveals a concrete missing observability boundary
- solving “stall suspected” or “orphaned” as new runtime policy concepts where the coordination layer does not already own explicit truth for them

## Current Gaps

- `FactoryStatusSnapshot` exposes restart recovery, active issues, retries, last action, and freshness-adjacent publication details as separate fields, but not a unified recovery-posture read model
- `renderFactoryStatusSnapshot()` requires operators to inspect multiple sections to answer a single question such as “is this healthy waiting, retry backoff, or degraded recovery?”
- `TuiSnapshot` shows active runs and queued retries, but not a consistent posture vocabulary across restart recovery, watchdog recovery, waiting states, and degraded observability
- watchdog recovery is mostly visible through `lastAction` and retry class instead of an explicit operator-facing posture entry
- workspace cleanup/retention results are recorded in logs and issue artifacts, but terminal cleanup posture is not retained in the status snapshot once an issue leaves `activeIssues`
- degraded observability exists implicitly through snapshot freshness/publication state, but the operator surfaces do not project that as one named posture alongside coordination-owned recovery states
- current status and TUI tests cover restart recovery and retries independently, but not the combined posture view required by this issue

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

- the operator-facing vocabulary for recovery posture
- the rule that observability must project coordination-owned truth rather than infer new lifecycle semantics
- the precedence rules for summarizing mixed posture signals into a factory-level read model

Does not belong here:

- TUI formatting details
- tracker API branching
- ad hoc log scraping heuristics

### Configuration Layer

Belongs here:

- no new config by default for this slice
- only a narrow read-only reuse of existing observability config such as refresh timing where needed by tests/renderers

Does not belong here:

- encoded posture truth
- runtime cleanup/retry/watchdog decisions
- provider-specific rendering flags

### Coordination Layer

Belongs here:

- a dedicated posture projection helper that consumes explicit runtime state
- persistence of any additional explicit status facts needed for terminal cleanup posture or watchdog posture after state transitions
- precedence/aggregation rules that decide which posture entries appear at factory and per-issue scope

Does not belong here:

- text formatting and color rules
- tracker transport parsing
- direct terminal rendering

### Execution Layer

Belongs here:

- unchanged existing runner/workspace facts already produced for coordination
- supplying terminal cleanup outcomes and watchdog facts that coordination can persist into status state

Does not belong here:

- posture vocabulary decisions
- renderer-specific summary strings

### Integration Layer

Belongs here:

- unchanged normalized lifecycle/check/review data consumed by the read model
- at most narrow wiring changes if an existing normalized lifecycle field must be threaded through untouched logic

Does not belong here:

- posture aggregation logic
- watchdog or cleanup projection rules
- UI-specific branching

### Observability Layer

Belongs here:

- status JSON schema additions for recovery posture
- text/TUI/watch rendering of the normalized posture read model
- tests that prove the operator surfaces stay aligned on the same posture vocabulary

Does not belong here:

- becoming the source of truth for retries, restart recovery, or cleanup policy
- inferring new runtime state by bypassing coordination-owned facts

## Architecture Boundaries

### `src/orchestrator/recovery-posture.ts` or equivalent focused module

Owns:

- normalized recovery-posture types
- projection from runtime status state, retry state, watchdog facts, and recent terminal cleanup facts
- posture precedence and grouping rules used by multiple observability surfaces

Does not own:

- snapshot parsing/rendering
- tracker calls
- runner/workspace side effects

### `src/orchestrator/status-state.ts`

Owns:

- persisted status-state inputs needed by the posture projector
- any bounded recent terminal recovery/cleanup records that must survive active-issue removal

Does not own:

- text formatting
- render-time freshness heuristics beyond persisting publication state inputs already in scope

### `src/orchestrator/service.ts`

Owns:

- recording posture-relevant facts at the time decisions happen
- updating status state when watchdog recovery/exhaustion or terminal cleanup outcomes occur
- passing the new posture projection inputs into snapshot builders

Does not own:

- inline posture derivation spread across unrelated branches
- UI strings

### `src/observability/status.ts`

Owns:

- serialized status JSON contract for the posture read model
- text rendering for factory status/control surfaces
- parse/validation helpers for the new snapshot fields

Does not own:

- posture policy decisions
- tracker/workspace semantics

### `src/observability/tui.ts`

Owns:

- compact rendering of the normalized posture read model in the watch/TUI surface
- layout choices and wording that stay faithful to the normalized posture types

Does not own:

- deriving posture by re-reading raw retry/restart/watchdog state itself
- deciding runtime recovery policy

## Layering Notes

- `config/workflow`
  - remains unchanged unless a concrete observability-only knob is proven necessary
  - must not become the home for runtime truth about recovery posture
- `tracker`
  - continues to normalize lifecycle/check/review state
  - must not gain posture-specific view-model code
- `workspace`
  - continues to execute cleanup and return normalized cleanup outcomes
  - must not decide how cleanup outcomes are summarized for operators
- `runner`
  - continues to publish provider-neutral runner visibility
  - must not grow posture-label helpers
- `orchestrator`
  - owns posture projection inputs and the derived read model
  - must not mix rendering strings through the poll loop
- `observability`
  - renders the shared posture read model
  - must not become a second source of truth

## Slice Strategy And PR Seam

This issue should land as one observability-focused PR with a thin coordination read-model extension:

1. add the focused recovery-posture projector and any missing persisted status facts
2. expose the new read model in the status snapshot contract
3. update text status/control rendering and watch/TUI rendering to consume it
4. add targeted unit/integration/e2e coverage for representative posture states

Deferred from this PR:

- new retry/watchdog/restart policies
- richer “suspected stall” pre-recovery state if coordination does not yet own that fact explicitly
- broader TUI redesign beyond the new posture section/labels
- archive/reporting changes outside the live status surfaces

Why this seam is reviewable:

- it stays centered on one concept: operator-visible recovery posture
- it reuses the explicit Phase 6 coordination seams instead of reopening tracker or runner architecture
- it narrows new coordination work to status-state persistence needed for projection, not policy redesign

## Runtime State Model

This issue is read-model work over long-running orchestration, so the posture model and precedence rules must be explicit even though the underlying policy already exists elsewhere.

### Factory-Level Recovery Posture Summary

The snapshot should publish one factory-level posture summary plus contributing entries.

Proposed summary states:

1. `healthy`
   - no active recovery/degraded posture exists
   - active work, if any, is running normally
2. `waiting-expected`
   - active work is blocked on expected human/system gates such as handoff, review, checks, or landing
3. `restart-recovery`
   - startup reconciliation is still running or recently completed with visible inherited-state decisions
4. `retry-backoff`
   - one or more issues are queued for a later retry attempt
5. `watchdog-recovery`
   - a watchdog recovery or recovery-exhausted decision is the active posture for an issue
6. `cleanup-terminal`
   - a recent terminal cleanup/retention outcome requires operator visibility
7. `degraded-observability`
   - the status surface is stale, unavailable, initializing, or otherwise not a fresh current view
8. `degraded`
   - coordination-owned recovery state itself is degraded, such as restart recovery remaining degraded or cleanup failing

### Summary Precedence

When multiple posture families are present at once, the summary should prefer the highest-severity/most-actionable state:

1. `degraded-observability`
2. `degraded`
3. `watchdog-recovery`
4. `restart-recovery`
5. `cleanup-terminal`
6. `retry-backoff`
7. `waiting-expected`
8. `healthy`

Decision note:

- The snapshot should still retain contributing entries/counts so the summary does not hide concurrent retry queues or waiting issues.

### Per-Issue Recovery Posture Entries

Each projected posture entry should name one primary posture family for the issue plus the normalized facts that explain it.

Proposed posture families:

1. `healthy`
   - active run with no recovery/degraded signal
2. `waiting-expected`
   - lifecycle is awaiting human/system action
3. `restart-recovery`
   - issue is part of startup reconciliation or a restart-recovery decision set
4. `retry-backoff`
   - issue is queued in retry state with due-time details
5. `watchdog-recovery`
   - issue is actively recovering from or failed due to watchdog action
6. `cleanup-terminal`
   - recent terminal retention/cleanup outcome is being surfaced after run completion
7. `degraded`
   - the issue has a degraded recovery/cleanup decision

### Transition Rules

The read model itself should not invent new transitions. It should be derived from existing state transitions such as:

- `restartRecovery.state: idle -> reconciling -> ready|degraded`
- retry queue states from `retry-state.ts`
- watchdog recovery/exhaustion notes recorded by the orchestrator
- workspace retention outcomes from `workspace-retention.ts`
- active-issue lifecycle waiting states from `status-state.ts`

The new posture module should only encode:

- precedence between simultaneous signals
- how long recent terminal cleanup outcomes remain visible, if bounded recency is needed
- whether a posture is active, waiting, degraded, or terminal in the read model

## Failure-Class Matrix

| Observed condition | Coordination facts available | Observability/control facts available | Expected posture projection |
| --- | --- | --- | --- |
| Startup is reconciling inherited running issues | `restartRecovery.state === "reconciling"` and per-issue decisions in progress | fresh current snapshot | factory summary `restart-recovery`; per-issue entries show `restart-recovery` |
| Startup finished but one inherited issue remained degraded | `restartRecovery.state === "degraded"` with degraded issue decision | fresh current snapshot | factory summary `degraded`; status text/TUI make degraded restart posture explicit |
| An issue is waiting on human review or CI checks | active issue lifecycle `awaiting-human-review` or `awaiting-system-checks` | fresh current snapshot | factory summary `waiting-expected` when no higher-severity posture exists; issue entry shows `waiting-expected`, not degraded |
| A run failed and retry is scheduled for later | retry queue entry exists with due time | fresh current snapshot | issue entry `retry-backoff`; factory summary `retry-backoff` unless a higher-severity posture exists |
| A watchdog abort triggered retry recovery | watchdog abort reason and/or last watchdog recovery fact persisted for the issue | fresh current snapshot | issue entry `watchdog-recovery`; factory summary `watchdog-recovery` |
| A terminal success/failure produced a cleanup failure | terminal cleanup outcome persisted after issue removal | fresh current snapshot | issue/recent-event entry `cleanup-terminal` with degraded detail; factory summary `degraded` |
| A terminal outcome retained workspace by policy or cleaned successfully | terminal cleanup outcome persisted after issue removal | fresh current snapshot | issue/recent-event entry `cleanup-terminal`; factory summary `cleanup-terminal` unless superseded |
| Status snapshot is initializing, stale, unreadable, or worker-offline | coordination snapshot may be old or absent | freshness/publication assessment indicates non-fresh state | control/status summary `degraded-observability` regardless of older coordination posture details |

## Storage / Persistence Contract

- extend `FactoryStatusSnapshot` with a normalized recovery-posture section instead of requiring operators to reconstruct posture from unrelated fields
- keep the status snapshot file as the only persisted live status surface; do not add a second recovery-status file
- if terminal cleanup posture must outlive active-issue removal, persist a bounded recent posture/event list in runtime status state and serialize it into the status snapshot
- do not introduce a new durable database; reuse existing in-memory status state plus the persisted snapshot

## Observability Requirements

- `status --json` must expose the same posture vocabulary used by text status and TUI/watch rendering
- text status rendering must include a short factory-level posture summary and enough per-entry detail to distinguish:
  - healthy waiting
  - restart reconciliation
  - retry/backoff
  - watchdog recovery
  - degraded observability
  - terminal cleanup outcomes
- TUI/watch rendering must surface posture without forcing operators to inspect raw retry rows, last-action text, or hidden JSON
- degraded observability must be clearly separated from healthy waiting or active recovery
- renderer wording should stay compact and consistent across all surfaces

## Implementation Steps

1. Add a focused recovery-posture projection module under `src/orchestrator/` that derives normalized posture entries from:
   - runtime status state
   - retry runtime state
   - watchdog runtime state / persisted watchdog notes
   - recent terminal cleanup facts
   - status freshness/publication context where the surface needs degraded observability
2. Extend `RuntimeStatusState` with the smallest bounded record needed for recent terminal cleanup posture after an issue leaves `activeIssues`.
3. Update `BootstrapOrchestrator` to record posture-relevant facts when:
   - watchdog recovery/exhaustion is triggered
   - retry is scheduled
   - terminal cleanup/retention finishes
4. Extend `buildFactoryStatusSnapshot()` and the `FactoryStatusSnapshot` schema with the new posture section.
5. Update `src/observability/status.ts` parsing and text rendering to show the posture summary and entries.
6. Extend `TuiSnapshot` with the minimal posture projection needed for watch/TUI rendering.
7. Update `src/observability/tui.ts` to render posture cleanly without duplicating projection logic.
8. Add or update tests across unit/integration/e2e levels for representative posture states and mixed-precedence cases.
9. Run repo-required checks plus TUI visual smoke coverage if the layout changes materially.

## Tests And Acceptance Scenarios

### Unit

- `tests/unit/status.test.ts`
  - parses and renders the new recovery-posture snapshot fields
  - distinguishes `waiting-expected` from degraded or retry posture
  - overlays `degraded-observability` when freshness is stale/unavailable
  - renders terminal cleanup posture entries after an issue is no longer active
- `tests/unit/tui.test.ts`
  - renders the posture summary/entries without duplicating raw retry/restart semantics
  - shows watchdog recovery and retry/backoff distinctly
  - preserves readable output when multiple posture families coexist
- `tests/unit/orchestrator.test.ts`
  - records recent terminal cleanup posture into status state
  - persists watchdog recovery/exhaustion posture inputs needed by the projector
  - projects retry/backoff and waiting states correctly through the shared posture helper

### Integration

- add or extend an integration test that exercises the status snapshot through restart-recovery, retry, or cleanup transitions and asserts the normalized posture read model rather than raw logs

### End-to-End / Realistic Harness

- extend the bootstrap/e2e harness with one scenario that yields a visible recovery posture transition, such as watchdog-triggered retry or restart reconciliation followed by ready/blocked posture

### Visual Smoke

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - verify the posture additions remain legible in the existing watch/TUI layout

### Repository Checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. The factory restarts and is reconciling inherited `symphony:running` work.
   - Expected: `factory status`, `status --json`, and watch/TUI all show `restart-recovery` rather than generic waiting.
2. An issue is blocked on human review or CI checks with no recovery problem.
   - Expected: the surfaces show `waiting-expected`, not degraded or retry posture.
3. A run fails and is queued for backoff retry.
   - Expected: the surfaces show `retry-backoff` with attempt/due details.
4. A watchdog recovery triggers or reaches its limit.
   - Expected: the surfaces show `watchdog-recovery` distinctly from ordinary run failure.
5. A terminal cleanup succeeds, retains by policy, or fails.
   - Expected: the surfaces show `cleanup-terminal` details even after the issue leaves `activeIssues`.
6. The snapshot is stale or the runtime is still publishing initialization state.
   - Expected: the operator surface shows `degraded-observability` instead of implying current healthy waiting.

## Exit Criteria

- plan is explicitly `approved` or `waived` before substantial implementation
- the status snapshot has a normalized recovery-posture section
- text status/control rendering and watch/TUI rendering use the same posture vocabulary
- terminal cleanup posture remains visible long enough to inspect after a run exits the active set
- representative unit/integration/e2e tests cover restart, retry, watchdog, waiting, cleanup, and degraded-observability cases
- `npx tsx tests/fixtures/tui-qa-dump.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- new policy/state for “suspected stall” before watchdog recovery is explicit in coordination
- new policy/state for generalized orphan classification outside the existing restart-recovery decision set
- report/archive surfaces that might later reuse the same posture vocabulary
- larger watch/TUI redesign once additional observability slices land

## Decision Notes

- The current issue should add a shared recovery-posture read model instead of teaching each renderer to infer state from `restartRecovery`, `retries`, `lastAction`, and freshness independently.
- `degraded-observability` is not a coordination decision, but it must still participate in the operator posture summary because an unreadable or stale surface changes what conclusions an operator can safely draw from the snapshot.
- If one snapshot can contain both expected waiting and active retry/recovery work, the projector should keep per-entry detail and use explicit precedence only for the top-level summary.
