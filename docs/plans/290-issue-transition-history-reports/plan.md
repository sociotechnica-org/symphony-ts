# Issue 290 Plan: Persist Issue State And Label Transition History Into Canonical Artifacts And Reports

## Status

- waived

## Goal

Persist normalized tracker-side issue state and label transitions into the canonical local artifact contract so per-issue and campaign reports can show queue movement and reconciliation history instead of hardcoded “unavailable” notes.

The intended outcome of this slice is:

1. canonical issue summaries keep the latest observed normalized tracker state and label set
2. canonical issue summaries append a durable transition ledger when those observed values change
3. per-issue reports render issue-side lifecycle transitions from that canonical ledger
4. campaign digests aggregate transition counts and affected issues so queue movement is no longer invisible
5. the implementation stays on one seam: additive issue-artifact transition persistence plus report consumption

## Scope

This slice covers:

1. additive canonical issue-artifact schema changes for tracker state, tracker labels, and an issue transition ledger
2. persistence logic that derives transitions by comparing newly observed normalized issue snapshots against the stored summary
3. orchestrator wiring needed to persist post-failure tracker snapshots so failure-label transitions are recorded accurately
4. per-issue report updates that replace the current hardcoded unavailable message with rendered transition history
5. campaign-report aggregation for transition counts and affected issues
6. unit coverage for artifact persistence, post-failure transition capture, issue-report rendering, and campaign aggregation

## Non-Goals

This slice does not include:

1. storing raw tracker payloads or webhook ledgers
2. polling GitHub during report generation
3. changing tracker policy, queue promotion policy, or landing policy
4. building a generalized event-sourcing layer for all tracker backends
5. replaying or backfilling historical transitions for old artifacts that predate this schema

## Current Gaps

Today the reports already preserve merged/closed timing, but tracker-side issue movement is still absent:

1. `src/observability/issue-report.ts` hardcodes `issueStateTransitionsStatus: "unavailable"` and a note that canonical artifacts do not record issue state or label transition history
2. `src/observability/campaign-report.ts` has no way to aggregate transition facts from stored issue reports
3. `src/observability/issue-artifacts.ts` stores the latest terminal outcome, `mergedAt`, and `closedAt`, but not the latest observed normalized tracker state/labels or a transition ledger
4. `src/orchestrator/service.ts` persists the stale pre-failure `RuntimeIssue` snapshot after `markIssueFailed()`, so even if a ledger existed it would miss the failed-label transition unless the post-failure issue is re-read
5. reopened or reconciled issues can later be re-observed, but the current artifact contract cannot show that any issue-side lifecycle changed

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that canonical local artifacts should preserve tracker-side lifecycle facts the runtime already observed
2. the rule that reports consume persisted local transition facts rather than post-hoc remote tracker queries
3. the rule that this slice records normalized state/label changes, not raw tracker payload history

Does not belong here:

1. tracker transport field names
2. file-write mechanics
3. report markdown formatting details

### Configuration Layer

Belongs here:

1. no workflow or frontmatter changes are required for this slice

Does not belong here:

1. configuration knobs for enabling transition persistence
2. report-format switches for showing or hiding transition history

### Coordination Layer

Belongs here:

1. orchestrator persistence of the correct post-mutation tracker snapshot after failure and completion
2. preserving issue transition facts as part of the canonical artifact write path instead of ad hoc report-time inference

Does not belong here:

1. tracker REST parsing
2. report markdown rendering
3. retry, continuation, or lease policy changes

### Execution Layer

Belongs here:

1. unchanged in this slice

Does not belong here:

1. runner or workspace behavior changes

### Integration Layer

Belongs here:

1. continued use of normalized `RuntimeIssue.state` and `RuntimeIssue.labels` at the tracker boundary
2. preserving tracker-specific parsing at the edge while the artifact ledger stays tracker-neutral

Does not belong here:

1. issue-report rendering
2. artifact layout decisions
3. new tracker mutations

### Observability Layer

Belongs here:

1. additive canonical summary schema for latest tracker state, latest labels, and the transition ledger
2. issue-report rendering of issue transitions
3. campaign aggregation of transition counts and affected issues
4. tests locking the additive artifact and reporting contract

Does not belong here:

1. live tracker reads during report generation
2. tracker mutation logic
3. treating transition facts as anything other than locally observed canonical history

## Architecture Boundaries

### `src/observability/issue-artifacts.ts`

Owns:

1. the additive schema for latest observed tracker state and labels
2. the additive schema for issue transition entries
3. transition derivation by comparing the incoming normalized snapshot against the stored summary
4. backward-compatible loading of older summaries that do not contain transition fields

Does not own:

1. tracker transport parsing
2. report markdown
3. retry or landing policy

### `src/orchestrator/service.ts`

Owns:

1. persisting the correct post-failure and post-success tracker snapshot through the existing artifact write seam
2. keeping the transition ledger tied to the actual normalized issue snapshots already observed in the runtime

Does not own:

1. transition diff logic
2. report aggregation logic
3. tracker transport parsing

### `src/observability/issue-report.ts` and `src/observability/issue-report-markdown.ts`

Own:

1. projecting stored issue transition facts into the per-issue report model
2. rendering a concise transition section/note from those canonical facts

Do not own:

1. transition persistence
2. tracker queries
3. tracker mutation semantics

### `src/observability/campaign-report.ts` and `src/observability/campaign-report-markdown.ts`

Own:

1. aggregating per-issue transition facts into campaign-level counts and affected-issue lists
2. rendering those aggregate transition facts in campaign GitHub activity output

Do not own:

1. canonical artifact writes
2. tracker queries
3. per-issue transition diff logic

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one end-to-end seam:

1. extend the canonical issue summary with latest tracker state/labels and a transition ledger
2. feed accurate post-mutation issue snapshots into that ledger from the orchestrator
3. update issue and campaign reports to consume the stored facts
4. cover the seam with focused unit tests

This PR deliberately defers:

1. raw tracker payload history
2. backfilling old artifact directories
3. tracker-policy changes
4. UI/TUI projection of the new transition facts

## Canonical Storage Contract

Add additive fields to `IssueArtifactSummary`:

1. `trackerState: string | null`
2. `trackerLabels: readonly string[]`
3. `issueTransitions: readonly IssueArtifactTransition[]`

Where each `IssueArtifactTransition` records:

1. `observedAt`
2. `kind: "state-changed" | "labels-changed"`
3. `fromState` / `toState` for state transitions
4. `fromLabels` / `toLabels`, plus `addedLabels` / `removedLabels`, for label transitions

Backward compatibility:

1. old summaries load with `trackerState: null`, `trackerLabels: []`, and `issueTransitions: []`
2. reports continue to render a partial/unavailable note only for older summaries with no transition data

## Runtime Fact Flow

1. the runtime observes a normalized `RuntimeIssue` snapshot
2. the artifact writer persists the latest tracker state and label set from that snapshot
3. if the stored summary differs, the writer appends transition entries to the canonical summary
4. reports read only those persisted transition entries

For failure correctness:

1. after `markIssueFailed()`, the orchestrator fetches the updated issue snapshot
2. the artifact writer receives the post-failure labels/state, not the stale pre-failure snapshot

## Failure-Class Matrix

| Case                                             | Source                     | Expected behavior                                                                                |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| Older summary without transition fields          | backward compatibility     | load with empty transition history                                                               |
| Repeated observation with unchanged state/labels | artifact writer            | no new transition entry                                                                          |
| State changed, labels unchanged                  | artifact writer            | append one `state-changed` entry                                                                 |
| Labels changed, state unchanged                  | artifact writer            | append one `labels-changed` entry                                                                |
| Both changed in one observation                  | artifact writer            | append both entries in one write                                                                 |
| Failure path without post-failure refetch        | orchestrator bug           | prevented by new post-failure fetch in this slice                                                |
| Tracker snapshot fetch fails after failure       | orchestrator degraded path | fall back to prior issue snapshot; transition may be absent, but terminal failure still persists |

## Implementation Steps

1. Add the transition types and additive summary fields in `src/observability/issue-artifacts.ts`.
2. Update summary read/write logic to load old summaries safely and append transition entries when `trackerState` or `trackerLabels` change.
3. Extend issue artifact updates so they carry normalized tracker state and label sets from `RuntimeIssue`.
4. Update the orchestrator failure path to fetch the updated issue snapshot after `markIssueFailed()` before persisting the terminal observation.
5. Extend issue-report types/builders/markdown to render transition availability and the concrete transition list.
6. Extend campaign-report types/builders/markdown to aggregate transition counts and affected issues.
7. Add focused tests for summary persistence, failure-path transition capture, issue report rendering, and campaign aggregation.

## Tests

1. `tests/unit/issue-artifacts.test.ts`
   - additive default loading for old summaries
   - transition ledger append/dedup behavior
2. `tests/unit/issue-report.test.ts`
   - issue report renders concrete transition history instead of unavailable notes
3. `tests/unit/campaign-report.test.ts`
   - campaign GitHub activity aggregates transition counts and affected issues
4. `tests/unit/orchestrator.test.ts`
   - failure path persists the post-failure issue snapshot so `symphony:failed` transitions are recorded

## Acceptance

1. representative issue reports stop saying issue transitions are unavailable when the run observed issue-side changes
2. issue reports render meaningful ready/running/failed/reopened/relabelled history from canonical local artifacts
3. campaign digests expose transition counts/affected issues instead of having no issue-side lifecycle visibility
4. failure-path artifacts capture the failed-label transition instead of persisting only the pre-failure snapshot
