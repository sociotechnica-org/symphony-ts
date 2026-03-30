# Issue 252 Plan: Normalize Issue-Report Timelines For Retry And Recovery Readability

## Status

- plan-ready

## Goal

Make per-issue report timelines tell a coherent attempt story when retries, watchdog recovery, or restart recovery replay attempt-start evidence, while staying faithful to the canonical local artifacts.

The intended outcome of this slice is:

1. retry- and recovery-heavy reports stop reading like contradictory duplicate starts for the same attempt
2. watchdog or shutdown/recovery activity remains visible in the timeline instead of being flattened away
3. normalization happens in one report-derivation seam under `src/observability/`
4. existing raw artifacts remain the source of truth and older artifact directories stay readable

## Scope

This slice covers:

1. refining issue-report timeline derivation in `src/observability/issue-report.ts`
2. introducing a small, explicit normalization step for attempt lifecycle narration before markdown/render consumers see the timeline
3. keeping recovery evidence visible by rewording or collapsing replayed attempt-start facts rather than deleting recovery-adjacent events
4. adding focused fixture coverage for duplicate/replayed attempt starts around shutdown/recovery and retry scheduling
5. updating tests so the readable timeline contract is explicit and regression-resistant

## Non-Goals

This slice does not include:

1. changing canonical raw artifact schemas or adding new event kinds
2. changing orchestrator retry, watchdog, shutdown, reconciliation, or recovery behavior
3. mutating tracker state, PR policy, or handoff policy
4. redesigning report markdown structure outside the existing timeline entries
5. reconstructing hidden runtime state from external GitHub or runner logs during report generation
6. broader campaign-report or TUI recovery-surface refactors unless a tiny shared helper naturally falls out of the report seam

## Current Gaps

Today timeline derivation is accurate but too literal for replay-heavy runs:

1. every `runner-spawned` event becomes `Attempt N started` without considering whether the same attempt already has an equivalent start already represented nearby
2. attempt snapshots only suppress their own derived `attempt-started` entry when a `runner-spawned` event exists, but multiple `runner-spawned` events for one attempt still read like duplicate starts
3. shutdown and recovery events appear independently, but the timeline does not narrate that a later spawn for the same attempt is a resumed/recovered run rather than a fresh conflicting start
4. the current tests cover ordinary single-attempt flows but do not lock in the recovery-heavy readability case named in the issue

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. defining the report-reader rule that replayed attempt-start evidence should be collapsed into one readable storyline per attempt phase
2. preserving explicit recovery evidence instead of implying a clean uninterrupted start when recovery happened
3. requiring faithful-but-readable narration rather than raw event transcription

Does not belong here:

1. tracker-specific lifecycle quirks
2. orchestrator retry budgets or watchdog thresholds
3. markdown-only wording hacks without a stable derived timeline rule

### Configuration Layer

Belongs here:

1. no workflow or frontmatter changes are required for this slice
2. existing report path/config resolution remains unchanged

Does not belong here:

1. report-format knobs for duplicate suppression
2. recovery-policy configuration changes

### Coordination Layer

Belongs here:

1. no coordination-layer code changes are required
2. the plan must still model recovery/retry event meaning so report derivation does not invent contradictory stories

Does not belong here:

1. orchestrator control-flow edits
2. new runtime counters or reconciliation policy

### Execution Layer

Belongs here:

1. untouched for this issue

Does not belong here:

1. runner/workspace changes to satisfy report readability

### Integration Layer

Belongs here:

1. untouched for this issue because canonical local artifacts already contain the needed normalized facts

Does not belong here:

1. tracker transport or normalization changes
2. raw GitHub re-fetching during report generation

### Observability Layer

Belongs here:

1. timeline normalization over canonical issue artifacts
2. helper logic that classifies repeated start evidence for the same attempt as primary start versus recovery replay
3. unit fixtures and assertions for readable recovery-heavy timelines

Does not belong here:

1. remote API calls
2. tracker mutations
3. hidden inference that cannot be justified from stored attempt/session/event facts

## Architecture Boundaries

### `src/observability/issue-report.ts`

Owns:

1. deriving a normalized ordered timeline from canonical issue events, attempts, and sessions
2. classifying repeated attempt-start evidence within one attempt timeline
3. preserving distinct shutdown/retry/recovery events while collapsing contradictory duplicate start narration

Does not own:

1. emitting new canonical events
2. tracker normalization
3. retry or watchdog policy decisions

### `tests/support/issue-report-fixtures.ts`

Owns:

1. reusable recovery-heavy fixture builders for readable-timeline tests
2. expressing the canonical artifact combinations that trigger replayed start narration

Does not own:

1. production normalization policy
2. markdown formatting logic

### `tests/unit/issue-report.test.ts`

Owns:

1. the report-reader contract for ordinary flows and recovery-heavy flows
2. proving that duplicate start narration is collapsed without hiding retry/shutdown context

Does not own:

1. ad hoc artifact-writing logic duplicated across tests when a helper can express the seam once

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one observability read-side seam:

1. add an explicit timeline-normalization pass in `src/observability/issue-report.ts`
2. keep all raw inputs and output schema stable
3. add focused fixtures/tests for duplicated start evidence and recovery/retry readability

This PR deliberately defers:

1. new canonical event kinds for recovery phases
2. campaign-report timeline normalization beyond whatever it inherits automatically from issue reports later
3. status/TUI recovery-story changes
4. any orchestrator-side attempt-event deduplication

Why this seam is reviewable:

1. it is read-only over existing canonical artifacts
2. it isolates behavior to one report derivation path plus tests
3. it avoids mixing tracker transport, orchestrator recovery logic, and report rendering in one patch

## Timeline Normalization Model

This issue changes a stateful derivation path, so the normalization model must be explicit even though orchestrator runtime state is unchanged.

### Normalized attempt timeline states

For each `attemptNumber`, the report derivation should treat start-related evidence as a small state machine:

1. `no-start-observed`
   - no start narration has been emitted for the attempt yet
2. `primary-start-emitted`
   - the first credible start for the attempt has been emitted
3. `recovery-replay-observed`
   - later start evidence for the same attempt appeared after shutdown/recovery cues and should be narrated as recovery/resume, not a fresh duplicate start
4. `attempt-closed`
   - retry, success, or terminal failure closed the attempt story

### Allowed transitions

1. `no-start-observed -> primary-start-emitted`
   - first `runner-spawned` or fallback attempt snapshot with `startedAt`
2. `primary-start-emitted -> recovery-replay-observed`
   - a later same-attempt start is observed after shutdown or other interruption cues for the same attempt
3. `primary-start-emitted -> attempt-closed`
   - PR/open review/landing/retry/terminal outcome closes the attempt without replayed start evidence
4. `recovery-replay-observed -> attempt-closed`
   - retry or terminal outcome after the recovered/replayed run

### Normalization rules

1. keep the earliest same-attempt start as the canonical `Attempt N started` narration
2. when later same-attempt start evidence appears, do not emit another plain `Attempt N started`
3. if nearby same-attempt shutdown/recovery cues exist, narrate the later start as recovery/resume in the summary/details of one timeline entry rather than as a contradictory second start
4. if replay cause cannot be justified from local facts, collapse duplicate wording conservatively and preserve the raw evidence in details instead of inventing a recovery explanation
5. retry scheduling for the next attempt must remain its own visible event and must not be collapsed into recovery wording

## Failure-Class Matrix

| Observed condition                                                              | Local facts available                                  | Expected timeline decision                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| One `runner-spawned` event for an attempt                                       | canonical event ledger only                            | Emit one ordinary `Attempt N started` entry                                                                                |
| No `runner-spawned`, but attempt snapshot has `startedAt`                       | attempt/session snapshots                              | Emit one fallback attempt-start entry derived from the snapshot                                                            |
| Two or more same-attempt `runner-spawned` events with no recovery/shutdown cues | repeated same-attempt start evidence                   | Collapse to one readable start entry and preserve duplicate evidence in details or summary without asserting recovery      |
| Same-attempt later spawn follows `shutdown-requested` or `shutdown-terminated`  | canonical event sequence for one attempt               | Keep shutdown event visible and narrate the later start as resumed/recovered activity, not a new conflicting attempt start |
| Shutdown occurs and the next visible start is for a higher attempt number       | shutdown plus retry-scheduled or next attempt snapshot | Keep the original attempt closed, keep retry visible, and emit a new ordinary start for the new attempt                    |
| Retry-scheduled exists without any later attempt start yet                      | retry event only                                       | Keep retry visible; do not invent a new start                                                                              |
| Event ledger missing, attempt/session snapshots only                            | no canonical event ordering                            | Fall back to one attempt-start entry per attempt snapshot and avoid recovery claims                                        |

## Observability Requirements

1. the generated timeline stays stable and machine-readable with existing schema fields
2. entry wording must make it obvious when the report is summarizing replayed evidence instead of claiming two contradictory starts
3. details should preserve enough factual breadcrumbs to audit why the timeline was normalized
4. older artifact directories without recovery cues must continue to render deterministically

## Implementation Steps

1. inspect the current `buildTimeline` path and extract a small helper that groups and normalizes start-related entries per attempt before final sort/render
2. define conservative heuristics for when a later same-attempt spawn is treated as replay/recovery versus generic duplicate evidence
3. update timeline entry wording/details so the primary start remains readable and recovery/shutdown context remains visible
4. add or extend fixture helpers to seed recovery-heavy local artifacts with repeated same-attempt spawns and shutdown/retry events
5. add unit tests covering the duplicate-start regression, watchdog/recovery readability, and the conservative no-recovery-cue fallback
6. run the relevant local checks and inspect the generated report output for the new narrative contract

## Tests And Acceptance Scenarios

### Unit

1. a standard single-attempt success flow still renders one ordinary `Attempt 1 started` entry
2. repeated same-attempt `runner-spawned` events no longer render two identical `Attempt 1 started` entries
3. same-attempt shutdown followed by another spawn keeps the shutdown event visible and rewords the later start as recovery/resume
4. retry scheduling followed by a higher-numbered attempt still renders a distinct `Attempt 2 started` entry
5. snapshot-only partial artifacts still fall back deterministically without recovery claims

### Integration / Report Contract

1. generating `report.json` from a recovery-heavy fixture yields a readable ordered timeline and unchanged schema shape
2. generating `report.md` from the same fixture keeps retry/recovery reasoning visible in human-readable output

### Acceptance Scenarios

1. given a run with duplicate/replayed start evidence for attempt 1, when `generateIssueReport()` runs, then the timeline contains one primary start narration for attempt 1 and does not read like two conflicting fresh starts
2. given a run where watchdog/shutdown recovery replays attempt 1, when the report is generated, then shutdown/recovery remains visible and understandable to an after-action reviewer
3. given a real retry into attempt 2, when the report is generated, then attempt boundaries remain explicit and readable

## Exit Criteria

1. `src/observability/issue-report.ts` normalizes repeated same-attempt start narration without hiding retry or shutdown evidence
2. unit coverage locks in the recovery-heavy readability contract
3. existing issue-report tests remain green
4. local typecheck, lint, and test commands pass

## Deferred To Later Issues Or PRs

1. expanding canonical artifacts with richer recovery-specific event kinds
2. campaign-report or TUI adoption of the same narrative normalization if they need independent treatment
3. any tracker- or orchestrator-side deduplication of raw lifecycle events
4. storing raw replay provenance beyond what the current artifact schema already exposes

## Decision Notes

1. This slice should prefer conservative collapse over speculative storytelling. If the local artifacts do not justify a recovery explanation, the report should say less, not more.
2. The normalization should happen before markdown rendering so JSON and markdown stay aligned.
3. The helper should group by `attemptNumber` and use nearby lifecycle cues from the canonical event order rather than scatter one-off conditionals across the markdown layer.
