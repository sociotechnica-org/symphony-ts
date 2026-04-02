# Issue 320 Plan: Fix Factory TUI Contrast For Light Terminal Themes

## Status

- plan-ready

## Goal

Make the factory status TUI readable in both dark and light terminal themes by replacing low-contrast color choices in the recovery and tickets sections with a small semantic palette that preserves status meaning without washing out key text.

## Scope

- audit the current ANSI color usage in `src/observability/tui.ts` for recovery posture rows, ticket table rows, and adjacent header/detail text
- replace low-contrast presentation with observability-local semantic color helpers for primary text, secondary metadata, separators, and status emphasis
- preserve the existing layout, snapshot contract, and ticket/recovery content while changing only the presentation layer needed for contrast
- add regression coverage that explicitly checks light-theme-safe rendering decisions
- update the TUI QA fixture/workflow so light-theme contrast is part of the documented verification path

## Non-goals

- changing tracker data, orchestrator snapshot shape, retry policy, or runner visibility contracts
- redesigning the TUI layout, column model, or section ordering
- adding runtime theme detection or workflow configuration for light vs dark terminals in this slice
- introducing true-color or terminal-specific palette negotiation
- refactoring unrelated observability/reporting code outside the status TUI seam

## Current Gaps

- `src/observability/tui.ts` uses `GRAY = "\x1b[2;37m"` for recovery summaries, empty-state rows, separators, and several detail strings; that dim-white choice is nearly invisible on light backgrounds
- recovery posture rows color both the summary line and issue-entry detail with faint gray even though those lines carry primary operator information
- ticket table rows color large spans of meaningful text with status colors and pair them with dim metadata, which reduces readability on common light terminal palettes
- the current tests assert content and layout, but they do not pin the contrast-sensitive ANSI choices that caused the regression
- `tests/fixtures/tui-qa-dump.ts` documents visual QA generally, but it does not call out a specific light-theme contrast check

## Decision Notes

- The first reviewable slice should stay entirely inside observability. The issue is presentation-specific, so it should not widen into snapshot or workflow changes unless the existing TUI seam proves insufficient.
- The safest fix is to reduce dependence on dim text and use color only for compact status cues, while leaving most operator-critical text in default/high-contrast foreground styling.
- This slice should introduce semantic TUI color roles rather than swapping a few literals ad hoc. That keeps the contrast policy legible and makes later TUI adjustments less brittle.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the operator-facing rule that the status TUI must remain readable across common terminal themes
  - does not belong: changing issue lifecycle policy, retry posture meaning, or review/landing behavior
- Configuration Layer
  - belongs: none in this slice; existing observability config remains unchanged
  - does not belong: new workflow knobs for theme selection or palette overrides
- Coordination Layer
  - belongs: untouched; the orchestrator continues to publish the same normalized snapshot data
  - does not belong: snapshot-shape churn, retry-state changes, or extra runtime bookkeeping solely for presentation
- Execution Layer
  - belongs: untouched; runner/workspace behavior is not part of this contrast bug
  - does not belong: subprocess, workspace, or execution-session changes
- Integration Layer
  - belongs: untouched; tracker transport/normalization stays out of this PR
  - does not belong: tracker-specific formatting or adapter changes
- Observability Layer
  - belongs: ANSI palette roles, row/header rendering changes, and regression coverage for readable light-theme output
  - does not belong: tracker inspection, lifecycle policy, or runner transport changes

## Architecture Boundaries

### `src/observability/tui.ts`

- owns semantic color-role definitions and the render-time choice of which text is neutral vs emphasized
- may refactor existing raw ANSI constants into named presentation helpers if that keeps usage clearer
- should not gain tracker-policy logic or snapshot normalization work

### `tests/unit/tui.test.ts`

- owns focused regression tests for ANSI choices that materially affect readability
- should assert behavior at the semantic/rendered-output level rather than snapshot-internal details unrelated to contrast

### `tests/fixtures/tui-qa-dump.ts`

- owns the manual visual QA path for TUI inspection
- should explicitly surface a light-theme verification step or fixture note
- should not become an alternate renderer or a heavy snapshot-testing framework

### Does not belong in this slice

- `src/orchestrator/*`
- `src/tracker/*`
- `src/runner/*`
- workflow schema/docs beyond a QA note tied directly to the TUI verification path

## Layering Notes

- `config/workflow`
  - remains unchanged
  - does not gain theme settings in this issue
- `tracker`
  - remains the source of normalized ticket/recovery facts
  - does not participate in ANSI styling decisions
- `workspace`
  - untouched
- `runner`
  - untouched
  - does not own ticket-row coloring
- `orchestrator`
  - continues to expose the same TUI snapshot facts
  - does not become a carrier for theme-specific presentation flags
- `observability`
  - owns readable ANSI styling and the test/QA guardrails for that styling
  - does not become a second source of truth for lifecycle semantics

## Slice Strategy And PR Seam

This issue fits in one reviewable PR if it stays inside the status-TUI presentation seam:

1. replace low-contrast ANSI choices with a semantic palette in `src/observability/tui.ts`
2. update unit coverage to pin readable rendering decisions for recovery rows and ticket rows
3. update the QA dump or observability docs so light-theme contrast is an explicit verification step

Deferred from this PR:

- runtime theme detection
- user-configurable palettes
- broader TUI redesign or accessibility framework work
- contrast changes in other CLI/report surfaces unless the same low-contrast pattern is discovered there and can be fixed without widening the seam materially

This seam is reviewable on its own because it is a pure observability correctness change with no tracker, orchestrator, or runner contract movement.

## Runtime State Model

This slice does not change orchestration state, retries, continuations, reconciliation, leases, or handoff transitions. It is a read-only presentation fix over the existing `TuiSnapshot`.

## Contrast Decision Matrix

| Observed render condition                           | Current render behavior                                            | Expected render behavior                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Recovery posture summary/detail on a light terminal | summary text and detail rely on dim gray                           | operator-critical summary/detail text uses default or otherwise high-contrast foreground                         |
| Recovery posture entry metadata                     | issue family/id/detail all rely heavily on colored/dim text        | compact status tags may stay colored, but the explanatory text remains readable without depending on dim styling |
| Ticket table row for active/waiting items           | large text spans inherit status colors, with adjacent dim metadata | color is limited to short status cues while row content remains readable on light themes                         |
| Empty-state rows such as `No active tickets`        | empty-state text uses dim gray                                     | empty-state text remains muted but still legible on light backgrounds                                            |
| Dark terminal rendering                             | current palette is readable                                        | dark-mode readability remains acceptable after neutralizing the low-contrast choices                             |

## Observability Requirements

- the recovery posture summary and per-issue recovery entries must remain readable in common light terminal themes
- ticket table rows must keep their status meaning without washing out ID, activity, runner, token, or detail text
- section headers and separators should remain visually distinct without depending on barely visible dim-white text
- regression coverage should make the light-theme-sensitive color policy visible in tests, not only in a human screenshot

## Implementation Steps

1. Audit `src/observability/tui.ts` and group existing raw ANSI constants into semantic roles such as:
   - primary text
   - muted but readable metadata
   - separators
   - success/warning/error/accent cues
2. Replace uses of the current dim-gray helper in recovery rows, ticket headers, ticket empty states, and other operator-critical lines with the new semantic roles.
3. Narrow status-color usage in ticket rows so long detail strings and other primary content do not depend entirely on light-theme-fragile colors.
4. Keep the existing layout and snapshot content stable while adjusting only the render-time styling choices.
5. Add focused unit tests in `tests/unit/tui.test.ts` that cover:
   - recovery posture rows avoiding dim/washed-out styling for primary text
   - ticket rows keeping readable neutral text for the main row content
   - empty-state and header/separator output remaining explicit and readable
6. Update `tests/fixtures/tui-qa-dump.ts` and, if needed, `src/observability/README.md` so the manual QA path explicitly includes a light-terminal contrast inspection.
7. Run repository-required checks plus the TUI visual QA command.

## Tests And Acceptance Scenarios

### Unit

- `tests/unit/tui.test.ts`
  - recovery posture summary/detail render without the dim-gray treatment on primary text
  - ticket rows do not render all operator-critical fields using the status color
  - empty-state rows remain readable without disappearing into light backgrounds
  - dark-mode-safe status cues such as status dots or compact tags still render distinctly

### Visual QA

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - inspect the rendered dump while using a light terminal theme and confirm that recovery posture rows, ticket rows, and muted metadata remain readable
  - repeat a quick check in a dark terminal theme to confirm the palette change did not collapse contrast there

### Repository checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. The factory has one or more recovery posture entries and the operator opens the TUI in a light terminal theme.
   - Expected: the family tag may remain colored, but the issue identifier and summary text are clearly readable.
2. The tickets table includes active, waiting, and review-related rows in a light terminal theme.
   - Expected: ID, status, age/turn, runner, tokens, and detail text remain legible without relying on faint gray or washed-out row-wide coloring.
3. The same snapshot is rendered in a dark terminal theme.
   - Expected: readability remains intact and status cues are still visually distinct.
4. A future refactor reintroduces dim-gray styling to primary recovery or ticket-row text.
   - Expected: unit coverage fails before the regression ships silently.

## Exit Criteria

- plan is explicitly `approved` or `waived`
- the status TUI uses readable light-theme-safe styling for recovery posture and ticket rows
- explicit regression coverage exists for the contrast-sensitive rendering decisions
- `npx tsx tests/fixtures/tui-qa-dump.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- automatic dark/light theme detection
- user-configurable TUI palettes
- broader accessibility review across non-TUI observability surfaces
- richer screenshot-based visual regression infrastructure if the repo later decides this class of issue warrants it
