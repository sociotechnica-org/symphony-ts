# Issue 245 Plan: Ticket-First Factory TUI

## Status

- plan-ready

## Goal

Refine the factory TUI so the default operator view is organized around tracked tickets, with runner/session detail treated as one attribute of each ticket instead of the primary organizing surface.

## Scope

- reframe the main TUI table around normalized active-ticket state rather than only live runner sessions
- shorten rendered ticket identifiers by moving tracker repository context into the header and rendering per-row short IDs such as `#245`
- keep tickets visible through waiting and handoff states even when no live session is attached
- keep runner/session detail available in the ticket row without making PID/session/event columns dominate the layout
- clarify token/accounting labels so the operator can distinguish current ticket activity from global factory totals
- update unit tests, TUI QA fixtures, and any touched observability docs for the new layout

## Non-goals

- changing tracker transport, tracker normalization, or tracker lifecycle policy
- changing orchestrator retry, reconciliation, lease, or handoff behavior
- redesigning detached factory control commands or the JSON status snapshot contract beyond the minimal TUI read model needed for this issue
- adding new workflow configuration flags for TUI layout variants
- building drill-down navigation, interactive filtering, or a second detailed debug screen in this slice

## Current Gaps

- the current TUI `Running` section is keyed off `TuiSnapshot.running`, which centers live agent sessions instead of the operator's primary unit of work: tickets
- full tracker identifiers such as `org/repo/245` or similar long forms make the first column visually noisy and waste horizontal space
- active issues already exist in normalized runtime status, including waiting-review and waiting-landing states, but the main TUI view does not foreground those ticket states
- token and session details are visible, but the layout makes internal runtime/debug facts feel more important than ticket progress
- the default render does not clearly separate repository-level context from per-ticket identifiers

## Decision Notes

- The TUI should use normalized active-issue facts as its source of truth for which tickets deserve primary visibility.
- Repository/repo context belongs in the header, while row identity should use tracker-native short identifiers.
- Runner/session detail remains important, but it should collapse into a smaller per-ticket summary instead of driving the whole table structure.
- This issue remains an observability/read-model slice. It should not introduce new lifecycle inference logic inside the TUI.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the operator-facing rule that default monitoring is ticket-first, with runner state subordinate to ticket state
  - does not belong: tracker-specific approval semantics or new runtime lifecycle rules
- Configuration Layer
  - belongs: unchanged existing observability config consumption
  - does not belong: new workflow toggles for alternate TUI modes in this slice
- Coordination Layer
  - belongs: only the minimal snapshot projection needed to expose normalized active-ticket facts to the TUI in a ticket-first shape
  - does not belong: retry budgeting, reconciliation changes, lease logic, or handoff-policy changes
- Execution Layer
  - belongs: unchanged existing runner/workspace telemetry production
  - does not belong: new session semantics or child-process control changes
- Integration Layer
  - belongs: unchanged existing tracker normalization that already provides ticket identifiers and lifecycle facts
  - does not belong: TUI-specific formatting or column decisions
- Observability Layer
  - belongs: ticket-first render model, short-ID formatting, row summaries, header context, and regression coverage
  - does not belong: direct tracker calls, runner control, or lifecycle decisions made at render time

## Architecture Boundaries

### Belongs in this issue

- `src/orchestrator/service.ts`
  - only the thin `TuiSnapshot` projection needed to supply ticket-first row data from normalized active-issue state
- `src/observability/tui.ts`
  - replace the session-first running table with a ticket-first table and supporting header/label helpers
- `tests/unit/tui.test.ts`
  - lock in the new row model, short identifiers, waiting-ticket visibility, and token/session summary rendering
- `tests/fixtures/tui-qa-dump.ts`
  - refresh the visual QA scenarios if needed so manual inspection reflects the new layout
- `src/observability/README.md`
  - update operator-facing TUI testing notes if the named sections or expectations change

### Does not belong in this issue

- `src/tracker/`
  - no transport, normalization, or policy edits
- `src/runner/`
  - no telemetry schema changes beyond consuming existing normalized visibility
- `src/workspace/`
  - no workspace preparation or retention changes
- detached factory process control or CLI behavior
- status JSON redesign beyond the minimal projection needed by the TUI formatter

## Layering Notes

- `config/workflow`
  - continues to define whether the dashboard is enabled and how often it refreshes
  - does not gain ticket-formatting rules
- `tracker`
  - remains responsible for canonical issue identity and lifecycle facts
  - does not decide how the TUI prioritizes screen real estate
- `workspace`
  - remains unrelated to ticket-table presentation
- `runner`
  - continues to publish live visibility/accounting facts
  - does not render operator-facing labels
- `orchestrator`
  - may project normalized active-issue facts into a TUI-specific read model
  - should not embed ANSI/layout decisions or duplicate tracker policy
- `observability`
  - owns the ticket-first formatting, short-ID display, and screen hierarchy
  - should not become a second system of record for issue lifecycle state

## Slice Strategy And PR Seam

One reviewable PR with one seam:

1. project a minimal ticket-first TUI read model from existing normalized active-issue state
2. render a new main table centered on tickets, with runner/session detail condensed into supporting columns or summaries
3. update tests, QA fixtures, and touched docs to match the new operator view

This seam is reviewable because it avoids combining:

- tracker adapter changes
- orchestrator policy changes
- runner protocol changes
- detached control-path changes

## Runtime State Model

This issue does not change orchestration state transitions, retries, continuations, reconciliation, leases, or handoff rules.

The runtime source of truth remains the existing normalized active-issue state plus existing runner visibility/accounting facts. The TUI changes only how those facts are projected and formatted for operators.

## Failure-Class Matrix

| Observed condition | Available normalized facts | Expected TUI behavior |
| --- | --- | --- |
| Ticket has a live runner session | active issue status plus runner visibility/accounting | show the ticket row with condensed live runner/session detail |
| Ticket is waiting for review, checks, or landing with no active runner | active issue lifecycle status, no live session | keep the ticket visible in the main table with its waiting state clearly rendered |
| Multiple tickets share the same repository context | tracker repo known globally, issue numbers distinct per row | show repo context once in the header and short per-row ticket IDs |
| No tickets are active but retries or recovery entries exist | empty active-issue set plus retry/recovery snapshots | show an empty ticket-first state while preserving lower-priority recovery/backoff sections |
| Tracker identifier format differs by backend | normalized identifier plus tracker kind/repo context | render a short backend-appropriate ID without leaking long repo-scoped identifiers into each row |

## Observability Requirements

- the default main table must answer "which tickets need attention and what state are they in?" before surfacing session internals
- waiting/handoff tickets must remain visible without requiring a live runner session
- ticket identifiers must be easy to scan at normal terminal widths
- global header facts and per-ticket accounting labels must be distinguishable
- the TUI must continue to degrade gracefully for empty, narrow-width, and offline scenarios

## Implementation Steps

1. Inspect the current TUI row model and identify the smallest ticket-first shape that can be projected from normalized active-issue state without re-implementing status policy in observability.
2. Extend `TuiSnapshot` only as needed so the formatter can iterate ticket rows instead of only live-session rows.
3. Add short-identifier formatting helpers that use repo-level context in the header and backend-appropriate short IDs in rows.
4. Redesign the main table in `tui.ts` around ticket status, lifecycle summary, and condensed runner/accounting detail.
5. Preserve lower-priority sections such as recovery/backoff, but de-emphasize debug-heavy details in the default view.
6. Update unit tests for ticket-first rendering, waiting tickets, short IDs, and accounting/session summaries.
7. Run the TUI QA dump and repo-required checks, then adjust any touched README/observability guidance if the named sections changed.

## Tests And Acceptance Scenarios

### Unit tests

- `tests/unit/tui.test.ts`
  - active GitHub ticket rows render short identifiers like `#245` instead of full repo-scoped identifiers
  - a ticket awaiting review or landing remains visible even without live runner/session state
  - a live ticket row still shows condensed runner/session/accounting detail without dominating the layout
  - empty and offline states still render intelligibly after the table redesign

### Visual QA

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - inspect common widths and verify the screen reads ticket-first rather than session-first
  - verify shortened IDs, header repo context, and waiting-ticket visibility

### Repository checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. A GitHub-backed factory has one live ticket and one ticket waiting on human review.
   - Expected: both tickets appear in the main table; the live ticket includes runner detail, and the waiting ticket remains visible with its handoff state.
2. The factory is monitoring several tickets in the same repository.
   - Expected: the header shows the repo context once, and each row uses a short scan-friendly identifier such as `#245`.
3. A ticket has recent token/session activity.
   - Expected: the row surfaces that detail as supporting context, not as the dominant organizing structure.
4. No tickets are currently active.
   - Expected: the TUI still renders a coherent empty state and preserves recovery/backoff context below it.

## Exit Criteria

- the main TUI view is organized around tickets rather than live sessions
- short ticket identifiers replace long repo-scoped identifiers in table rows
- waiting/handoff tickets remain visible in the primary operator view
- runner/session facts remain available as supporting ticket attributes
- unit tests, QA dump, and required repo checks pass

## Deferred To Later Issues Or PRs

- interactive filtering, drill-down views, or multiple TUI tabs/screens
- tracker-specific per-backend visual customization beyond short-ID formatting
- changes to retry/recovery policy or lifecycle semantics
- richer historical timelines or transcript panes
- broader `factory status` or detached control CLI redesign
