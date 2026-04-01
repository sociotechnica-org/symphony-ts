# Issue 311 Plan: Define GitHub Activity Completeness Semantics In Issue And Campaign Reports

## Status

- plan-ready
- Issue: #311
- Branch: `symphony/311`
- Plan path: `docs/plans/311-github-activity-completeness/plan.md`

## Goal

Define one explicit completeness contract for generated GitHub activity reporting so:

1. per-issue `report.githubActivity.status` reflects the preserved GitHub facts instead of staying hardcoded to `partial`
2. campaign GitHub rollups can reach `complete` when the selected issue reports actually have complete GitHub activity coverage
3. the implementation stays on one reviewable seam inside observability/report generation rather than mixing tracker or orchestrator changes

## Scope

This slice covers:

1. defining the intended meaning of issue-level GitHub activity completeness across transitions, pull-request review/check facts, and merge/close timing
2. implementing that completeness derivation in `src/observability/issue-report.ts`
3. keeping campaign-level GitHub activity rollups aligned with the same semantics in `src/observability/campaign-report.ts`
4. updating markdown/tests/builders so the new completeness contract is locked in

## Non-goals

This slice does not include:

1. changing the tracker artifact schema or transition ledger contents
2. reworking token/cost accounting or non-GitHub report sections
3. adding live GitHub fetches during report generation
4. changing tracker transport, normalization, or orchestrator lifecycle policy
5. redesigning report output beyond the minimum wording needed to describe the new completeness semantics

## Current Gaps

Today the reporting surface has one explicit semantic hole:

1. `src/observability/issue-report.ts` hardcodes `githubActivity.status` to `partial`, even when the report already has complete transition, PR, merge, and close facts
2. `src/observability/campaign-report.ts` still treats the issue-level top status as the aggregate completeness source, so campaign GitHub activity can never become `complete`
3. the report model already distinguishes transition completeness with `issueStateTransitionsStatus`, but the umbrella GitHub status does not say what broader facts it is meant to cover
4. unit-test builders in `tests/unit/campaign-report.test.ts` also hardcode GitHub activity to `partial`, which hides the intended contract
5. PR review surfaced that campaign rollups currently re-derive close-timing applicability from lossy report text, which can diverge from issue-report semantics when tracker state was already closed but no explicit close timestamp was preserved

## Decision Notes

1. Keep `githubActivity.status` as the broader umbrella status for the whole GitHub activity section, not just issue transitions.
2. Derive that umbrella status from the preserved sub-surfaces instead of leaving it as an uninformative constant.
3. Treat the section as `complete` only when every GitHub activity fact the report claims to preserve for this issue is complete or not applicable.
4. Keep issue-transition completeness as its own explicit sub-status because campaigns and markdown already expose it separately.
5. Prefer a shared observability helper for GitHub activity completeness rather than re-encoding slightly different rules in issue and campaign builders.
6. If campaign aggregation needs applicability facts that only exist during issue-report generation, persist a small structured signal in the issue report instead of re-deriving relevance from rendered summaries.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule for what `complete`, `partial`, and `unavailable` mean for GitHub activity reporting
  - does not belong: ad hoc field-by-field null checks spread across multiple report builders
- Configuration Layer
  - belongs: unchanged; no workflow/config knobs are needed for report completeness semantics
  - does not belong: user-configurable completeness rules
- Coordination Layer
  - belongs: unchanged; no retries, reconciliation, or handoff behavior changes
  - does not belong: report-only status derivation
- Execution Layer
  - belongs: unchanged
  - does not belong: GitHub report completeness rules
- Integration Layer
  - belongs: unchanged normalized tracker facts already persisted into canonical artifacts
  - does not belong: campaign or issue-report availability policy
- Observability Layer
  - belongs: issue-report GitHub activity status derivation, campaign GitHub rollups, markdown wording, and regression tests
  - does not belong: tracker mutation, tracker transport parsing, or artifact-schema expansion

## Architecture Boundaries

### `src/observability/issue-report.ts`

Owns:

1. deriving per-issue GitHub activity completeness from the canonical report inputs
2. deciding which preserved GitHub facts are relevant for the current issue report and which are not applicable
3. emitting notes/summary text consistent with the new status contract

Does not own:

1. tracker artifact persistence
2. tracker API interpretation
3. campaign aggregation policy beyond reusable status helpers

### `src/observability/campaign-report.ts`

Owns:

1. aggregating selected issue-report GitHub activity statuses without downgrading complete issue reports back to perpetual partial
2. keeping campaign-level summary and notes aligned with the issue-level completeness contract

Does not own:

1. per-issue completeness heuristics duplicated locally
2. tracker reads or artifact writes

### `tests/unit/issue-report.test.ts` and `tests/unit/campaign-report.test.ts`

Own:

1. regression coverage for issue-level and campaign-level completeness semantics
2. test builders that model complete vs partial GitHub activity explicitly

Do not own:

1. bespoke production logic embedded in test setup

## Layering Notes

- `config/workflow`
  - unchanged
- `tracker`
  - continues to provide normalized facts through existing canonical artifacts
  - should not gain report-only completeness flags
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - unchanged
  - should not grow report completeness logic
- `observability`
  - owns the GitHub activity availability contract and its rendering
  - should keep that contract centralized instead of spread across issue/campaign builders and tests

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one observability seam:

1. define the GitHub activity completeness rules in a shared report-time helper or equivalent focused module
2. apply those rules to issue-report generation
3. keep campaign rollups and markdown aligned with the same derived status
4. update focused unit and integration coverage

Deferred:

1. broader report-schema redesign or new sub-status fields if the existing model is sufficient
2. tracker/artifact changes that would preserve more GitHub facts than today
3. TUI or live-status surface changes

Why this seam is reviewable:

1. it does not mix tracker transport, normalization, or orchestrator state work
2. it tightens one existing report contract instead of expanding the artifact model
3. it keeps the change small enough to prove with focused report tests

## Report Completeness Model

This issue does not change runtime retries, continuations, reconciliation, leases, or handoff states, so no orchestration state machine change is required.

It does require an explicit report-time completeness model for the GitHub activity section:

1. `unavailable`
   - the issue report lacks the canonical inputs needed to evaluate GitHub activity for all relevant sub-surfaces
2. `partial`
   - at least one relevant GitHub activity sub-surface is still missing or degraded, but at least one relevant sub-surface is available
3. `complete`
   - every relevant GitHub activity sub-surface is preserved completely in canonical local artifacts

The implementation should make the relevant sub-surfaces explicit:

1. issue transition history completeness
2. pull-request activity completeness for observed PRs, including review/check facts that already exist in the report model
3. merge timing completeness when merge timing is expected for the issue’s preserved outcome/activity
4. close timing completeness when exact close timing is expected for the issue’s preserved outcome/activity

Non-applicable facts should not force `partial`. For example:

1. an issue with no observed PR should not be downgraded just because merge timing is absent
2. an issue that never reached a closed state should not be downgraded just because `closedAt` is `null`

## Failure-Class Matrix

This slice does not change recovery or orchestration failure handling, so no runtime failure-class matrix is required.

The only required decision matrix is the report-time completeness matrix:

| Observed condition                                                                                                   | Stored local facts available                                                  | Expected GitHub activity status |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Legacy artifact predates transition ledger and other GitHub facts are also absent                                    | transition status unavailable, no PR/review coverage, no merge/close evidence | `unavailable`                   |
| Transition history is complete and PR/review/check facts are complete, but expected merge or close timing is missing | complete sub-facts plus at least one relevant timing gap                      | `partial`                       |
| Transition history is complete, PR/review/check facts are complete, and all relevant timing facts are present        | all relevant sub-surfaces complete                                            | `complete`                      |
| No PR was observed, merge timing is not applicable, and the remaining relevant sub-surfaces are complete             | transition/history and other relevant facts complete                          | `complete`                      |
| Some PR review/check fields remain unavailable for an observed PR, even though transitions are complete              | mixed complete and incomplete relevant sub-surfaces                           | `partial`                       |

## Storage / Persistence Contract

The canonical artifact contract remains unchanged in this slice.

Rules:

1. use only the GitHub facts already preserved in issue summaries, attempt snapshots, session snapshots, and lifecycle events
2. do not add synthetic completeness flags to canonical artifacts
3. if review or implementation evidence shows campaign/report consumers need a structured relevance signal that cannot be recovered safely from existing report text, expand the generated issue-report schema narrowly and bump its version rather than relying on summary-string parsing

## Observability Requirements

1. generated issue reports must expose a meaningful top-level `githubActivity.status`
2. generated campaign digests must be able to report `githubActivity.status: complete` when every selected issue report is GitHub-complete under the shared rules
3. markdown output should remain readable and should not imply partial GitHub coverage when the report facts are actually complete
4. report notes should continue to explain which GitHub sub-surface is missing when the status is partial or unavailable

## Implementation Steps

1. Define a focused GitHub activity completeness helper in `src/observability/` or an equivalent narrow seam used by both issue and campaign report builders.
2. Update `buildGitHubActivity` in `src/observability/issue-report.ts` to derive `status` from the preserved transition, PR review/check, merge, and close facts instead of returning a hardcoded constant.
3. Keep campaign GitHub rollups aligned with the same semantics in `src/observability/campaign-report.ts`, reducing any duplicated status logic where practical.
4. Persist structured merge/close timing applicability in generated issue reports if campaign aggregation cannot otherwise reuse the exact issue-level semantics without fragile re-derivation.
5. Update report markdown wording only where it currently assumes the section is partial by default.
6. Refine unit-test builders so complete GitHub activity can be modeled explicitly in tests instead of being forced to `partial`, and so campaign tests can model structured timing applicability directly.
7. Add or update focused integration coverage if the CLI/report-generation path needs regressions for the new status values or schema bump.

## Tests And Acceptance Scenarios

### Unit tests

1. `tests/unit/issue-report.test.ts`
   - complete issue artifacts with preserved transitions, PR review/check facts, merge timing, and close timing produce `githubActivity.status: complete`
   - missing relevant lifecycle timing or missing PR review/check facts keep `githubActivity.status: partial`
   - legacy/no-coverage GitHub artifacts still produce `githubActivity.status: unavailable` when nothing relevant is preserved
   - issues first observed in tracker state `closed` without a preserved `closedAt` timestamp still mark close timing as relevant in the structured report output
2. `tests/unit/campaign-report.test.ts`
   - campaigns with all selected issues GitHub-complete now aggregate to `githubActivity.status: complete`
   - campaigns with mixed complete/partial/unavailable issue GitHub activity still aggregate correctly
   - campaign issue-transition status remains derived from transition-specific sub-statuses, not flattened away by the umbrella status
   - campaign close-timing notes and learnings honor the structured issue-report relevance flag instead of parsing transition summaries

### Integration tests

1. `tests/integration/report-cli.test.ts` or the smallest existing report-generation integration seam
   - regenerated issue and campaign outputs reflect the new GitHub activity status contract end to end

### Acceptance scenarios

1. A succeeded issue with complete transition, PR, merge, and close facts generates `report.githubActivity.status: complete`.
2. A campaign built from only GitHub-complete issue reports generates `digest.githubActivity.status: complete`.
3. A report with preserved transitions but missing a relevant merge or close timestamp remains `partial`, with notes that explain the gap.
4. A legacy report that predates the transition ledger and lacks other preserved GitHub coverage remains explicitly non-complete rather than silently looking clean.

## Exit Criteria

1. issue reports no longer hardcode `githubActivity.status`
2. campaign GitHub rollups can reach `complete` when warranted by selected issue reports
3. the completeness rules are encoded in tests instead of only implicit in implementation
4. local validation passes:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`

## Deferred To Later Issues Or PRs

1. new report schema fields for finer-grained GitHub activity sub-statuses beyond what the current model already exposes
2. additional canonical artifact preservation for GitHub facts that are currently unavailable
3. live GitHub refreshes or backfill of historical report artifacts
