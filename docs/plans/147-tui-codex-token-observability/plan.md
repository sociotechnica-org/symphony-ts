# Issue 147 Plan: TUI Codex Token Observability Semantics

## Status

- plan-ready

## Goal

Make live Codex token accounting in the TUI easier to trust by distinguishing "no token-bearing event observed yet" from "observed token totals are currently zero" while preserving the current event-driven accounting model.

## Scope

- inspect the live Codex token path from `integrateCodexUpdate` through orchestrator snapshot projection into the TUI
- define explicit operator-facing semantics for three states:
  - active session with no token-bearing event observed yet
  - active session with token-bearing usage observed and accumulated
  - completed/finalized run with final token totals
- extend the running-entry and TUI snapshot contract only as needed to expose token-observability state without changing billing/accounting math
- update the TUI header and running-row token rendering so long-lived live sessions no longer imply unjustified certainty with a raw `0`
- add targeted unit coverage and TUI regression coverage for early-turn and later token-bearing updates

## Non-goals

- broad TUI redesign or column/layout changes beyond token-state labeling
- campaign, report, or billing-accounting changes
- synthetic token estimates or heuristics before a token-bearing event exists
- runner transport changes or Codex protocol redesign
- tracker, workspace, retry, reconciliation, or handoff-policy changes

## Current Gaps

- `src/orchestrator/running-entry.ts` only stores numeric token totals and high-water marks, so token-state unknown-ness is collapsed into numeric zero
- `src/orchestrator/service.ts` aggregates only numeric token deltas into `codexTotals`, so the header cannot tell whether `0` means "nothing observed yet" or "observed zero"
- `src/observability/tui.ts` renders header and row token cells directly from raw numeric totals
- a live row can already show `thread/started` or other Codex activity while both token surfaces still render `0`
- tests cover extraction and accumulation math, but not the operator-facing semantics of pending token visibility during live runs

## Decision Notes

- The accounting model stays event-driven. This issue is about surfacing certainty, not manufacturing counts.
- The narrowest seam is an explicit token-observability state owned by the running-entry/orchestrator snapshot contract and consumed by the TUI.
- Aggregate header semantics should stay internally consistent with per-row semantics. If any active Codex run is token-pending, the header should say so instead of presenting a bare aggregate `0`.
- Completed runs should continue to rely on the final observed totals already accumulated by the orchestrator; this slice does not add post-hoc reconciliation against external logs.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the operator-facing rule that token displays must communicate whether totals are unknown, observed, or final
  - does not belong: token-billing policy changes or runner-protocol heuristics
- Configuration Layer
  - belongs: unchanged existing observability configuration
  - does not belong: new workflow knobs for token display semantics
- Coordination Layer
  - belongs: a minimal snapshot/state projection that preserves token-observability state alongside accumulated totals
  - does not belong: retry policy, continuation behavior, reconciliation logic, leases, or handoff-state changes
- Execution Layer
  - belongs: unchanged existing Codex runner event production
  - does not belong: subprocess or app-server behavior changes
- Integration Layer
  - belongs: untouched; no tracker transport, normalization, or policy changes
  - does not belong: TUI token rendering semantics
- Observability Layer
  - belongs: TUI header/row token labels, formatting helpers, and regression coverage for pending vs observed token states
  - does not belong: token extraction math or any external session-log backfill

## Architecture Boundaries

### Belongs in this issue

- `src/orchestrator/running-entry.ts`
  - own token-observability state at the point where Codex events are integrated
  - keep token extraction/accumulation math event-driven and explicit
- `src/orchestrator/service.ts`
  - project per-run token-observability state into `TuiRunningEntry`
  - expose minimal aggregate token-state facts needed by the TUI header
- `src/observability/tui.ts`
  - render explicit operator-facing labels for pending vs observed vs final token states
  - keep row/header semantics aligned
- `tests/unit/running-entry.test.ts`
  - cover state transitions from unknown to observed
- `tests/unit/tui.test.ts`
  - cover early-turn live rendering, later token-bearing updates, and completed/final totals

### Does not belong in this issue

- `src/runner/`
  - no change to Codex event transport or parsing beyond what already reaches `integrateCodexUpdate`
- `src/tracker/`
  - no tracker-side lifecycle or normalization work
- `src/workspace/`
  - no workspace changes
- reporting/archive surfaces or cost summaries

## Layering Notes

- `config/workflow`
  - remains unchanged and read-only for dashboard timing/settings
  - does not gain token-state toggles
- `tracker`
  - remains unrelated to live token observability
- `workspace`
  - remains unrelated to live token observability
- `runner`
  - continues to emit raw events and final results
  - does not choose TUI semantics
- `orchestrator`
  - owns normalized token-observability state and aggregate projection
  - does not contain TUI-specific strings
- `observability`
  - owns human-readable labels and formatting for token certainty
  - does not invent token values or re-parse raw runner payloads

## Slice Strategy And PR Seam

One reviewable PR with one seam:

1. make token observability explicit in the running-entry/snapshot contract
2. update TUI row and header rendering to consume that explicit state
3. lock the semantics down with focused unit tests and TUI regression tests

This stays narrow because it does not combine:

- runner transport work
- tracker or lifecycle policy work
- dashboard layout redesign
- reporting/billing changes

## Runtime State Model

This issue does not change orchestration lifecycle, retries, continuations, reconciliation, leases, or handoff states.

It does introduce an explicit token-observability model for live Codex runs:

1. `pending`
   - the run is active, Codex session/activity may already be visible, but no token-bearing payload has been observed yet
   - numeric token totals remain `0`, but the UI must not present that as certain usage zero
2. `observed`
   - at least one token-bearing event has been integrated
   - accumulated totals are authoritative for the live run so far and should render numerically
3. `final`
   - the run is no longer active and the last observed totals are final for that completed attempt
   - the UI should render the numeric totals without a pending marker

Allowed transitions for a running entry in this slice:

1. start in `pending`
2. remain `pending` across non-token events such as `thread/started`
3. move from `pending` to `observed` on the first token-bearing event
4. remain `observed` for later token-bearing and non-token events
5. snapshot/rendering may treat a completed observed run as `final`

No backward transition from `observed` to `pending` is allowed within the same run/session.

## Failure-Class Matrix

| Observed condition                                                             | Local facts available                                                                        | Expected decision / rendering                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Live run has `thread/started` or other activity but no token-bearing event yet | running entry active, token totals `0`, no token-bearing event observed                      | row token cell renders pending/unknown semantics instead of bare `0`; header indicates live token accounting is pending |
| Live run receives first token-bearing payload                                  | running entry active, first token-bearing event integrated                                   | row and header switch to numeric observed totals                                                                        |
| Live run receives non-token events after token-bearing payloads                | running entry active, token-bearing event previously observed                                | keep numeric totals; do not regress to pending                                                                          |
| Completed run had token-bearing events                                         | run is no longer active, final observed totals retained in artifacts/snapshots as applicable | completed-state surfaces render numeric final totals                                                                    |
| Completed run never emitted a token-bearing payload                            | run ended with no observed token usage event                                                 | preserve truthful zero/unknown semantics according to the surface; do not invent counts                                 |

## Observability Requirements

- operators must be able to distinguish pending token visibility from observed zero/observed totals
- the running-row token column and header token summary must use the same underlying semantics
- pending token state should only appear while a run is active and token usage is not yet known
- after token-bearing events arrive, the TUI should render accumulated numeric totals without ambiguity
- regression tests should prove the exact early-turn live-run failure mode described in the issue

## Implementation Steps

1. Inspect the current `RunningEntry` token fields and add the smallest explicit state needed to represent whether token-bearing usage has ever been observed for the active run.
2. Keep token extraction and delta accumulation behavior unchanged except for updating the new token-state field on first observed usage payload.
3. Extend `TuiRunningEntry` and `TuiSnapshot.codexTotals` with minimal token-observability metadata so the TUI header can distinguish aggregate pending state from numeric zero.
4. Add TUI formatting helpers that render:
   - pending token state for live runs with no token-bearing event yet
   - numeric totals once usage is observed
   - stable numeric final totals for completed-state scenarios already covered by the snapshot
5. Update targeted unit tests in `running-entry.test.ts` for the pending -> observed transition and non-regression on later non-token events.
6. Update `tui.test.ts` with scenarios for:
   - live session with only `thread/started`
   - later token-bearing update
   - completed/final totals
7. Run the TUI QA dump and repo-required checks.

## Tests And Acceptance Scenarios

### Unit tests

- `tests/unit/running-entry.test.ts`
  - starts a new running entry in token-pending state
  - keeps token-pending state after non-token Codex events such as `thread/started`
  - flips to token-observed state on first token-bearing payload
  - does not regress from observed back to pending on later non-token events

### TUI tests

- `tests/unit/tui.test.ts`
  - live row with `thread/started` and zero totals renders pending token semantics instead of bare `0`
  - header token line reflects aggregate pending state when active runs have no observed token-bearing event yet
  - later token-bearing update renders numeric row/header totals consistently
  - completed/final totals render numeric totals without pending labeling

### Visual QA

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - inspect active-run frames and verify the token column/header no longer leave a misleading long-lived `0` when live activity exists but token usage is still pending

### Repository checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. A live Codex run has emitted `thread/started` but no token-bearing event yet.
   - Expected: the row and header make it clear token usage is not yet observed rather than asserting `0` with no qualification.
2. The same run later emits a token-bearing event.
   - Expected: row and header switch to accumulated numeric totals and remain internally consistent.
3. A completed run has final observed token totals.
   - Expected: the UI renders the final numeric totals without a pending marker.

## Exit Criteria

- token-observability state is explicit in the running-entry/snapshot contract
- the TUI distinguishes pending vs observed token usage for live Codex runs
- row and header token displays remain internally consistent
- existing token-accounting tests remain green and new regressions are covered
- `npx tsx tests/fixtures/tui-qa-dump.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- any attempt to estimate token usage before a token-bearing event exists
- campaign/reporting/accounting changes beyond the live TUI
- runner-side changes to emit richer token-state events
- broader TUI redesign or additional token-cost surfaces
