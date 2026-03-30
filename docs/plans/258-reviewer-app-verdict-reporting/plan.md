# Issue 258 Plan: Make Issue Reports And Landing Policy Reflect Reviewer-App Verdicts

## Status

- plan-ready

## Goal

Make the canonical issue-reporting and guarded-landing surfaces reflect normalized reviewer-app verdicts directly, so explicit reviewer-app `issues-found` outcomes remain visible and blocking even when they are expressed as top-level reviews/comments instead of unresolved review threads.

## Scope

- preserve normalized reviewer-app verdict facts from tracker lifecycle evaluation into canonical local issue artifacts
- update guarded landing to consume explicit reviewer-app verdict state as a first-class blocking input instead of relying only on actionable feedback lists and unresolved-thread counts
- update generated issue reports and markdown rendering to surface reviewer-app verdict posture alongside the existing actionable/unresolved counts
- add focused regression coverage for top-level reviewer-app `issues-found` verdicts that do not depend on unresolved-thread objects

## Non-goals

- adding new reviewer-app adapters beyond the existing normalization seam
- redesigning GitHub transport or GraphQL payload shapes
- changing orchestrator retry budgeting, queueing, or broader review-loop topology
- adding a second reporting pipeline or live GitHub fetch path for generated issue reports
- changing non-GitHub tracker implementations in this slice

## Current Gaps

- `src/tracker/pull-request-snapshot.ts` already computes normalized reviewer-app snapshots, but downstream artifact/report surfaces collapse review state to:
  - actionable feedback count
  - unresolved thread count
- `src/observability/issue-artifacts.ts` and `src/observability/issue-report.ts` therefore lose whether a reviewer app explicitly reported:
  - `issues-found`
  - `pass`
  - `unknown`
- `src/tracker/guarded-landing.ts` blocks on actionable reviewer feedback and unresolved human threads, but it does not consume an explicit aggregate reviewer-app verdict signal; it relies on other fields to imply that state
- the generated report markdown can say `review rounds 0, actionable 0, unresolved threads 0` even when canonical tracker evaluation had already normalized a reviewer-app verdict that should make the PR look non-clean

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that explicit reviewer-app verdicts are a blocking policy input for landing/report interpretation, not merely unresolved-thread side effects
  - does not belong: GitHub review parsing details or markdown formatting
- Configuration Layer
  - belongs: no workflow contract expansion is required for this slice; existing reviewer-app config remains the source of truth
  - does not belong: verdict aggregation rules hidden in config parsing
- Coordination Layer
  - belongs: orchestrator artifact writes should preserve normalized lifecycle review facts already returned by the tracker
  - does not belong: GitHub review-body parsing or app-specific heuristics
- Execution Layer
  - belongs: no workspace or runner changes
  - does not belong: reviewer verdict normalization or report rendering
- Integration Layer
  - belongs: aggregate reviewer-app verdict posture from normalized reviewer snapshots and expose it through tracker-facing snapshot/policy contracts
  - does not belong: report markdown composition or operator review bookkeeping
- Observability Layer
  - belongs: persist and render normalized reviewer-app verdict posture in issue artifacts and generated reports
  - does not belong: re-derive reviewer-app verdicts from raw GitHub text outside the normalized tracker surface

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/`
  - add a small aggregate reviewer-app verdict summary derived from existing `reviewerApps`
  - keep normalization in tracker modules; do not push app parsing into orchestrator or observability
  - update guarded-landing policy to use the explicit reviewer verdict aggregate
- `src/orchestrator/service.ts`
  - persist the normalized review summary already returned by the tracker into issue artifacts/events
- `src/observability/issue-artifacts.ts`
  - extend the canonical review snapshot shape with additive reviewer-app verdict facts
- `src/observability/issue-report.ts` and `src/observability/issue-report-markdown.ts`
  - carry the new verdict facts into generated report JSON/markdown and summaries
- tests/docs
  - add regression coverage and minimal documentation where report semantics change

### Does not belong in this issue

- new reviewer-app parsers or config keys
- broad report redesign beyond the review/landing seam
- TUI/status overhauls unless implementation evidence shows they already share the same narrowed review snapshot type
- operator wake-up follow-up heuristics beyond reading the improved generated report

## Layering Notes

- `config/workflow`
  - unchanged; existing reviewer-app config remains authoritative
- `tracker`
  - owns reviewer-app verdict aggregation and guarded-landing policy inputs
  - must not depend on report/markdown concerns
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - records tracker-derived normalized facts into artifacts
  - must not inspect reviewer-app bodies or app keys ad hoc
- `observability`
  - reads stored normalized verdict facts and renders them
  - must not recompute reviewer verdicts from raw GitHub payloads

## Slice Strategy And PR Seam

Land one reviewable PR centered on the canonical review snapshot seam:

1. add an additive reviewer-app verdict summary to the tracker snapshot and artifact snapshot contracts
2. make guarded landing consume that explicit summary
3. update generated reports/markdown to surface the new facts
4. add focused unit/integration/e2e coverage for the concrete reviewer-app top-level verdict path

Deferred:

- richer per-app dashboards or campaign-level aggregation changes
- changes to status/TUI if they are not needed to keep the snapshot contract coherent
- non-GitHub tracker parity

This stays reviewable because it does not reopen reviewer-app parsing or orchestrator state-machine design; it tightens one existing normalized seam and its observability consumers.

## Runtime State Model

This issue changes how landing/reporting interpret stateful PR review posture, so the reviewer verdict aggregate must be explicit.

### Aggregate reviewer-app verdict states

For the current PR head, derive an aggregate reviewer-app decision from normalized reviewer snapshots:

1. `no-blocking-verdict`
   - no accepted reviewer app has an explicit `issues-found` verdict
2. `blocking-issues-found`
   - at least one accepted reviewer app has `verdict=issues-found`
3. `required-reviewer-running`
   - required reviewer coverage is still running on the current head
4. `required-reviewer-missing`
   - required reviewer coverage is still missing after the normal check surface settles
5. `required-reviewer-unknown`
   - required reviewer coverage was observed but no explicit pass verdict was normalized

### Relevant lifecycle transitions

- `awaiting-system-checks` -> `rework-required`
  - accepted reviewer-app aggregate becomes `blocking-issues-found`, even when no unresolved thread exists
- `awaiting-system-checks` -> `degraded-review-infrastructure`
  - required reviewer state is `missing` or `unknown` once checks are otherwise settled
- `awaiting-system-checks` -> `awaiting-landing-command`
  - no blocking reviewer verdict remains and required reviewer state is satisfied
- `awaiting-landing-command` -> `rework-required`
  - a fresh reviewer-app `issues-found` verdict arrives on the current head
- `awaiting-landing` -> `rework-required`
  - guarded landing re-check sees `blocking-issues-found`

### Coordination decision rules

- explicit reviewer-app `issues-found` verdicts must block landing/report-clean interpretation even when unresolved-thread count is zero
- unresolved-thread counts remain useful evidence, but they are not the sole source of reviewer-app blocking state
- artifact/report consumers must project the normalized reviewer verdict summary, not reverse-engineer it from counts

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Reviewer app leaves a top-level `issues-found` review/comment and no unresolved thread exists | no landing request yet | reviewer verdict aggregate = `blocking-issues-found`; actionable thread count may be `0` | lifecycle/report show rework-required / blocking reviewer verdict, not clean review |
| Reviewer app leaves unresolved thread feedback | no landing request yet | reviewer verdict aggregate = `blocking-issues-found`; unresolved thread count > 0 | stay blocking and preserve both verdict and thread evidence |
| Required reviewer app output is observed but verdict is unclassified | no landing request yet | required reviewer state = `unknown` | degrade review infrastructure; do not treat as pass |
| Required reviewer app is still running on current head | no landing request yet | required reviewer state = `running` | keep waiting on system checks |
| `/land` is attempted after a reviewer-app `issues-found` verdict with no unresolved thread | landing approval recorded | reviewer verdict aggregate = `blocking-issues-found` | guarded landing blocks with rework-required semantics |
| Older artifacts predate reviewer verdict fields | existing report generation run | legacy artifact review snapshot has only actionable/unresolved counts | preserve backward-compatible parsing and render reviewer verdict posture as unavailable/absent rather than crashing |

## Storage / Persistence Contract

- keep the canonical local issue artifacts as the system of record
- extend `IssueArtifactReviewSnapshot` additively with normalized reviewer-app verdict facts so older artifacts remain readable
- generated `report.json` may gain additive review/verdict fields; bump the report schema only if implementation requires a non-additive contract change
- do not persist raw GitHub-authored review bodies as new canonical report fields

## Observability Requirements

- generated reports should show whether reviewer-app verdict evidence was:
  - blocking (`issues-found`)
  - satisfied/clean
  - unavailable from older artifacts
- PR activity lines in `report.md` should stop implying that `actionable 0 / unresolved threads 0` means reviewer-clean when stored reviewer verdict posture says otherwise
- event detail rendering should include reviewer verdict facts where available without duplicating raw review text

## Decision Notes

- Reuse the existing normalized `reviewerApps` seam instead of inventing a second review-policy abstraction.
- Prefer a compact aggregate verdict summary in artifacts/reports rather than copying full per-app evidence payloads into canonical issue artifacts.
- Keep backward compatibility for pre-change artifacts explicit; report generation must degrade gracefully when the new fields are absent.

## Implementation Steps

1. Add a tracker-side aggregate reviewer verdict summary derived from `PullRequestSnapshot.reviewerApps`, separate from unresolved-thread counts.
2. Extend the canonical issue-artifact review snapshot and lifecycle-event details to persist additive reviewer verdict facts alongside actionable/unresolved counts.
3. Update guarded landing to block on the explicit reviewer verdict aggregate in addition to the existing required-reviewer-state checks.
4. Update issue-report loading/aggregation/markdown rendering to read the additive verdict facts and reflect them in PR activity and review-loop summaries.
5. Add or update docs where generated report semantics or landing wording change.
6. Add regression coverage across unit, integration, and e2e layers for top-level reviewer-app `issues-found` verdicts with zero unresolved-thread count.

## Tests And Acceptance Scenarios

- Unit
  - `pull-request-snapshot` or reviewer-app helper tests for aggregate reviewer verdict derivation
  - `guarded-landing` tests proving top-level reviewer-app `issues-found` blocks landing even when unresolved-thread count is zero
  - `issue-report` tests proving additive reviewer verdict fields are parsed and rendered, and older artifacts still load
- Integration
  - GitHub bootstrap tracker test where a current-head reviewer-app top-level verdict produces blocking lifecycle/landing semantics without unresolved review threads
  - report CLI test or issue-report integration test showing the generated report surfaces reviewer-app blocking posture
- End-to-end
  - bootstrap factory scenario where a reviewer app posts a top-level `issues-found` verdict on the PR and the run/report remain visibly blocked rather than `awaiting-landing-command`

### Acceptance scenarios

1. A current-head Devin review says it found issues in a top-level PR review, no unresolved thread exists, and Symphony blocks landing with reviewer-app verdict semantics.
2. The generated per-issue report for that run shows reviewer-app blocking posture instead of only `actionable 0 / unresolved threads 0`.
3. An older artifact set without reviewer verdict fields still generates a readable report without parse failures.

## Exit Criteria

- guarded landing fails closed on explicit reviewer-app `issues-found` verdicts even when unresolved-thread count is zero
- canonical issue artifacts persist reviewer verdict posture additively
- generated `report.json` and `report.md` expose the stored reviewer verdict posture clearly enough that a blocking reviewer-app verdict does not look review-clean
- local validation passes:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Deferred To Later Issues Or PRs

- per-app reviewer verdict drilldowns in status/TUI/campaign reports
- reporter-side live GitHub refresh for post-run PR activity not present in canonical artifacts
- non-GitHub parity for the same verdict snapshot contract
- reviewer-app quorum or precedence policy beyond the current accepted/required semantics
