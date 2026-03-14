# Issue 133 Plan: Status TUI Lifecycle And Runner Context

## Status

- plan-ready

## Goal

Make the Status TUI reflect the normalized issue lifecycle and runner context already available in the factory runtime so operators can see handoff state, PR/check/review pressure, recent orchestrator action, and continuation budget without dropping to `factory status`.

## Scope

- replace the TUI row's raw `issueState` label with a lifecycle-oriented stage sourced from normalized active-issue status
- surface inline PR/check/review context for active issues in the running table event text
- show the latest orchestrator action in the TUI header
- show continuation usage as `turn n/N` instead of a bare turn count, using the configured max-turn budget
- show runner provider, model, and backend session identity using existing normalized runner visibility
- keep the TUI and `factory status` aligned on the same active-issue facts

## Non-goals

- adding watchdog stall badges or recovery-budget rendering in this slice
- adding merge-gate or landing-command projection that is not already normalized into the TUI snapshot
- changing tracker transport, tracker normalization, or tracker lifecycle policy
- changing runner subprocess behavior, continuation policy, or watchdog recovery behavior
- redesigning the TUI layout beyond the fields needed for this slice

## Current Gaps

- `src/observability/tui.ts` still renders the `STAGE` column from `runningEntries.issueState`, which is a raw running-entry label rather than the normalized active-issue lifecycle used elsewhere
- the TUI header does not expose `status.lastAction`, even though the runtime snapshot already persists it
- the running row shows `AGE / TURN` as `runtime / turnCount`, but the max-turn budget is known from config and should be shown explicitly
- the TUI row event text can show live runner activity, but it does not summarize PR number, check counts, or review pressure from normalized lifecycle state
- runner provider/model/backend session data exists in `runnerVisibility.session`, but the row/session presentation is still oriented around the older Codex-only `sessionId`
- watchdog state and merge-gate facts are not part of `TuiSnapshot`, so adding them in the same PR would widen the seam into coordination-state projection

## Decision Notes

- This issue as written spans multiple separable review surfaces. The first PR should stay inside observability plus a narrow snapshot projection seam rather than combine lifecycle presentation, watchdog projection, and merge-gate policy into one patch.
- The TUI should consume normalized active-issue state from the runtime status model wherever possible instead of re-deriving lifecycle from raw Codex events.
- The TUI should prefer provider-neutral runner visibility over Codex-specific session fields, keeping the surface correct for `codex`, `claude-code`, and `generic-command`.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the operator-facing rule that the TUI should present the same lifecycle and runner facts as the canonical runtime status snapshot
  - does not belong: changing handoff policy, watchdog policy, or merge-gate decisions
- Configuration Layer
  - belongs: reusing `agent.maxTurns` and existing observability config as read-only inputs to the TUI snapshot
  - does not belong: new workflow flags for stage labels or runner display
- Coordination Layer
  - belongs: a minimal `TuiSnapshot` projection that threads existing `status.lastAction`, normalized active-issue lifecycle/check/review fields, and the configured max-turn budget into the TUI
  - does not belong: retry policy, watchdog recovery logic, continuation rules, lease behavior, or tracker-policy changes
- Execution Layer
  - belongs: unchanged existing runner visibility production and continuation turn accounting
  - does not belong: subprocess-launch changes, live-session changes, or prompt-building changes
- Integration Layer
  - belongs: untouched; tracker adapters continue to normalize PR/check/review data before the orchestrator snapshot consumes it
  - does not belong: TUI formatting or header/row presentation logic
- Observability Layer
  - belongs: TUI header updates, running-row formatting, lifecycle label mapping, turn-budget rendering, and regression coverage
  - does not belong: direct tracker inspection or raw runner protocol parsing during render

## Architecture Boundaries

### `src/orchestrator/service.ts`

- may extend `TuiSnapshot` and `TuiRunningEntry` with normalized active-issue fields already held in `status.activeIssues`
- may add `lastAction` and `maxTurns` to the snapshot
- should not move TUI-specific formatting into orchestrator code

### `src/orchestrator/status-state.ts`

- remains the owner of persisted runtime status facts such as active-issue status, PR/check/review data, and `lastAction`
- should not gain TUI-specific presentation labels

### `src/runner/service.ts`

- remains the source of provider-neutral runner session and visibility metadata
- should not gain TUI-specific display helpers

### `src/observability/tui.ts`

- owns lifecycle label formatting, header rendering, session/event preference order, and turn-budget color/label rules
- should not infer tracker lifecycle from raw PR fields beyond formatting normalized snapshot content

### Does not belong in this slice

- `src/tracker/*` transport or normalization changes
- watchdog state redesign
- landing/merge gate normalization changes
- detached-factory control-plane changes

## Layering Notes

- `config/workflow`
  - continues to define `agent.maxTurns` and dashboard timing
  - does not gain view-model settings
- `tracker`
  - remains responsible for PR/check/review normalization
  - does not participate in TUI-specific formatting
- `workspace`
  - untouched
- `runner`
  - continues to publish provider-neutral visibility/session metadata
  - does not own stage labels or PR summary strings
- `orchestrator`
  - projects normalized runtime facts into `TuiSnapshot`
  - does not duplicate formatting that belongs in observability
- `observability`
  - renders lifecycle, last-action, runner, and turn-budget context
  - does not become a second source of truth for lifecycle policy

## Slice Strategy And PR Seam

This issue is too broad for one clean PR if it includes:

- lifecycle/runner presentation
- watchdog stall visibility
- merge-gate/landing projection

The first reviewable slice for `#133` is:

1. expose normalized lifecycle and last-action facts to the TUI
2. render provider-neutral runner/session context and continuation budget in the TUI
3. add regression coverage that keeps `factory status` and the TUI aligned on those facts

Deferred from this PR:

- watchdog stall indicator, duration, and recovery-budget badges
- merge-gate status, landing-command state, and PR head-SHA display beyond what is already normalized into the active-issue snapshot
- any broader TUI layout redesign

This seam is reviewable on its own because it is primarily an observability-surface correctness change with only a thin snapshot contract extension.

## Runtime State Model

This slice does not change orchestration transitions, retry policy, continuation decisions, reconciliation, or leases. It is a read-only projection of existing runtime state into the TUI.

The TUI will consume the following normalized active-issue states:

1. `running`
   - a local worker is actively executing turns
   - TUI shows runtime, `turn n/N`, and live runner context
2. `awaiting-human-handoff`
   - plan-ready or other human handoff waiting state
   - TUI stage should present the lifecycle label rather than the generic running-entry state
3. `awaiting-human-review`
   - PR exists and human review is required
   - TUI should show PR number and review/check counts inline
4. `awaiting-system-checks`
   - PR exists and system checks remain pending or failing
   - TUI should show check counts inline
5. `awaiting-landing-command`
   - PR is clean and waiting for an explicit human landing signal
   - TUI should distinguish this stage from generic review waiting
6. `awaiting-landing`
   - merge is blocked on human landing/merge completion
   - TUI should retain the lifecycle label, but richer merge-gate projection is deferred
7. `rework-required`
   - actionable review feedback remains
   - TUI should summarize review pressure inline

## Failure-Class Matrix

| Observed condition | Runtime facts available | Expected TUI behavior |
| --- | --- | --- |
| Active run has normalized lifecycle `awaiting-system-checks` with pending checks and a PR | active issue status, PR handle, pending/failing names | render lifecycle stage for checks waiting and inline PR/check counts |
| Active run has normalized lifecycle `rework-required` with actionable review feedback | active issue review counts and summary | render follow-up/rework-oriented stage and inline review counts |
| Active run has runner visibility with provider/model/backend session but no legacy `sessionId` | `runnerVisibility.session.*` populated | render provider-neutral session context without falling back to Codex-only fields |
| Active run has turn count but no exposed max-turn budget today | turn count plus configured `agent.maxTurns` | render `turn n/N` after snapshot extension |
| Runtime has a recent `lastAction` but no active issues | `status.lastAction` present, empty running list | header still renders the last action line |
| Runtime has no normalized watchdog or merge-gate fields in `TuiSnapshot` | current snapshot contract only | do not invent or guess those fields; keep them deferred |

## Observability Requirements

- the TUI header should display the latest orchestrator action kind and summary when available
- lifecycle labels in the running table should come from normalized active-issue status, not raw `runningEntries.issueState`
- running rows should expose provider/model/backend session identity in a provider-neutral way
- running rows should summarize PR/check/review pressure without requiring a switch to `factory status`
- the TUI should remain explicit when a field is unavailable rather than inferring tracker or watchdog state

## Implementation Steps

1. Extend `TuiSnapshot` and `TuiRunningEntry` with the smallest normalized fields needed for this slice:
   - `lastAction`
   - `maxTurns`
   - active-issue lifecycle status/summary
   - PR/check/review counts
   - runner provider/model/backend session data where not already present
2. Update `BootstrapOrchestrator.snapshot()` to project those values from `status.activeIssues`, `status.lastAction`, and config without adding presentation logic there.
3. Refactor `src/observability/tui.ts` row formatting so the `STAGE` column uses normalized lifecycle labels instead of the raw running-entry state.
4. Update the header formatter to render a last-action line.
5. Replace the current `AGE / TURN` rendering with `runtime / turn n/N`, including color treatment for low remaining budget if the existing TUI color model can express it cleanly without a layout expansion.
6. Update the session/event display helpers to prefer provider-neutral runner session metadata and include inline PR/check/review summary text.
7. Add or update TUI tests for lifecycle labels, header last-action rendering, provider/model/session rendering, and turn-budget display.
8. Run TUI visual QA and repository-required checks.

## Tests And Acceptance Scenarios

### Unit

- `tests/unit/tui.test.ts`
  - renders lifecycle stage from normalized active-issue status instead of raw running-entry state
  - renders header last-action line when `snapshot.lastAction` is present
  - renders `turn n/N` using the configured max-turn budget
  - renders provider/model/backend session context from `runnerVisibility.session`
  - renders inline PR/check/review summary for review and checks waiting states
  - preserves explicit fallback text when optional fields are absent

### Visual QA

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - inspect widths used by the existing fixture and verify lifecycle stage, last-action header, and runner/session details remain readable

### Repository checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. An active issue is waiting on CI with PR `#412`, two pending checks, and no review feedback.
   - Expected: the TUI shows the checks-waiting lifecycle stage and inline PR/check counts.
2. An active issue is in rework with actionable review feedback.
   - Expected: the TUI shows the follow-up lifecycle stage and inline review counts.
3. A live `claude-code` or `generic-command` run has provider/model/backend session metadata but no Codex-style legacy session id.
   - Expected: the TUI still shows usable provider-neutral session context.
4. A run is on turn 2 of a max-turn budget of 3.
   - Expected: the age/turn column shows `turn 2/3`.
5. The factory has just recorded `watchdog-recovery` or `claim-skipped` as the last action.
   - Expected: the header shows that action summary even if the running table is otherwise unchanged.

## Exit Criteria

- plan is explicitly marked `approved` or `waived`
- the TUI stage and header reflect normalized lifecycle and last-action state
- running rows show provider-neutral runner context and continuation budget
- focused regression coverage exists for the added TUI fields
- `npx tsx tests/fixtures/tui-qa-dump.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- watchdog stall badges, stall duration, and recovery-budget display
- merge-gate status and explicit PR head-SHA display
- any snapshot persistence changes required to normalize richer landing-gate state
- larger TUI table/layout redesign once all new fields are available
