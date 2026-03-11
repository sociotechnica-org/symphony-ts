# Issue 47 Plan: Generate Multi-Issue Campaign Digests

## Status

`plan-ready`

## Goal

Add a detached campaign-reporting path to `bin/symphony-report.ts` that reads a selected set of existing per-issue reports, aggregates them into one campaign digest for an explicit issue list or a date window, and writes stable campaign markdown outputs under `.var/reports/campaigns/<campaign-id>/` without embedding campaign generation into the factory runtime or archive-publication flow.

## Scope

This slice covers:

1. a provider-neutral campaign digest input model rooted in existing generated issue reports from `#44` and optional read-only references back to canonical local artifacts when the issue report already points to them
2. a standalone reporting CLI subcommand with command shapes:
   - `pnpm tsx bin/symphony-report.ts campaign --issues 32,43,44`
   - `pnpm tsx bin/symphony-report.ts campaign --from 2026-03-01 --to 2026-03-07`
3. selection logic for explicit issue lists and inclusive date-window filtering over locally generated issue reports
4. stable campaign outputs under `.var/reports/campaigns/<campaign-id>/`:
   - `summary.md`
   - `timeline.md`
   - `github-activity.md`
   - `token-usage.md`
   - `learnings.md`
5. aggregation logic that rolls up issue outcomes, major lifecycle events, PR/check/review facts, token/cost availability, and cross-issue conclusions from the structured issue-report pipeline
6. tests and docs that prove issue-level reporting and campaign-level reporting remain separate responsibilities

## Non-goals

This slice does not include:

1. changing the per-issue artifact or report schema from `#43`, `#44`, or `#46`
2. auto-generating missing per-issue reports as part of `campaign`; this command should consume existing generated issue reports and fail clearly when required inputs are missing
3. publishing campaign digests to `factory-runs` or coupling them to the issue-report publication path from `#45`
4. embedding campaign digest generation into `symphony run`, orchestrator retries, or any runtime handoff path
5. adding tracker-provider-specific report composition rules at the campaign layer
6. adding workflow-frontmatter config for campaign rendering or selection defaults
7. inventing a new coordination concept such as campaign state, campaign ownership, or campaign retries

## Current Gaps

After `#44`, `#45`, and `#46`, `symphony-ts` can generate and publish one issue report at a time, but there is no campaign-level digest surface:

1. operators cannot summarize several issues or one factory period from the structured reporting pipeline
2. the reporting CLI has no command for aggregating report sets by issue list or time window
3. there is no stable campaign output directory contract under `.var/reports/campaigns/`
4. the useful sections from the first factory-run writeup still require bespoke manual assembly instead of deterministic report aggregation
5. token usage, review churn, and recurring failure modes remain visible only one issue at a time

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer: owns the stable campaign section set, selection semantics, partial-data rules, and the rule that campaign digests consume existing report artifacts rather than operator memory. This issue does not add tracker or orchestration policy.
- Configuration Layer: limited to detached CLI argument parsing and path resolution for the campaign command. This issue should not add `WORKFLOW.md` schema or runtime configuration knobs.
- Coordination Layer: untouched. The orchestrator must not gain campaign state, campaign scheduling, or campaign side effects.
- Execution Layer: untouched. Workspace and runner behavior must not change to satisfy campaign rendering.
- Integration Layer: touched only through existing issue-report facts that already normalize tracker/provider detail. This issue should not add direct tracker API reads or provider-specific aggregation logic.
- Observability Layer: owns campaign input loading, selection, aggregation, markdown rendering, output-path helpers, and the detached CLI/service surface.

## Architecture Boundaries

### Observability

Belongs here:

1. typed campaign digest input/output models built from stored issue reports
2. report-set selection helpers for explicit issue numbers and date windows
3. deterministic campaign-id derivation and output paths under `.var/reports/campaigns/`
4. campaign aggregation for summary, timeline, GitHub activity, token usage, and learnings
5. markdown renderers for the five required campaign files
6. explicit partial/unavailable notes when the selected issue reports contain gaps

Does not belong here:

1. tracker API reads
2. publication-to-archive logic
3. orchestration retries, leases, or campaign runtime state
4. ad hoc memory-only conclusions that are not grounded in selected issue reports

### CLI / Config

Belongs here:

1. parsing `campaign --issues ...` and `campaign --from ... --to ...`
2. resolving the repo root and workspace root from `WORKFLOW.md`
3. printing campaign generation results and output locations

Does not belong here:

1. aggregation logic inline in option parsing
2. hidden behavior that mutates issue reports or generates archive publications

### Integration

Belongs here:

1. nothing new beyond the existing issue-report contracts already consumed by observability

Does not belong here:

1. direct tracker transport reads for campaign generation
2. provider-specific token aggregation logic that bypasses issue reports

### Coordination / Execution

Belongs here:

1. nothing new in this slice

Does not belong here:

1. campaign selection policy
2. campaign generation triggers
3. campaign retry or cleanup logic

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on one detached read-side seam:

1. extend the existing reporting CLI with one `campaign` subcommand
2. add campaign-specific loaders, aggregators, and markdown renderers under `src/observability/`
3. add focused unit and integration coverage using existing issue-report fixtures plus generated per-issue reports
4. update docs for the new command and output location

This PR deliberately defers:

1. archive publication of campaign digests
2. campaign JSON artifacts or other new durable machine-readable publication formats unless a later issue needs them explicitly
3. runtime-loop integration or automatic campaign generation after factory runs
4. re-deriving campaign facts from raw tracker payloads or operator-authored notes

The seam is reviewable because it adds one new consumer of existing issue reports and keeps coordination, tracker integration, and archive publication untouched.

## Campaign Digest Input Model

The campaign digest core input should be an explicit selected set of stored issue reports:

1. load `report.json` through the existing stored-report reader so schema-version checks stay centralized
2. treat each loaded issue report as the canonical normalized unit for campaign aggregation
3. preserve references back to report artifact paths and raw artifact paths already embedded in each issue report for evidence and traceability
4. do not aggregate directly from ad hoc issue comments, operator notes, or raw runner logs

### Selection modes

Exactly one selection mode should be used per command invocation:

1. explicit issue list: `--issues 32,43,44`
2. date window: `--from YYYY-MM-DD --to YYYY-MM-DD`

### Date-window policy

For time-window selection, use report facts rather than ad hoc filesystem mtime:

1. prefer the issue report operational window derived from `summary.startedAt` and `summary.endedAt`
2. when one bound is unavailable, fall back to the available bound
3. when both operational bounds are unavailable, fall back to `generatedAt`
4. include a report when its derived issue window overlaps the inclusive requested window
5. if no reports match, fail clearly instead of generating empty campaign files

This keeps selection deterministic while staying grounded in structured report data.

## Campaign Output Contract

Write campaign digests to:

```text
.var/reports/campaigns/<campaign-id>/
  summary.md
  timeline.md
  github-activity.md
  token-usage.md
  learnings.md
```

### Campaign ID

Derive a stable, filesystem-safe campaign id from the selection mode:

1. explicit issue selection should preserve the selected issue numbers in sorted order
2. date-window selection should preserve the requested `from` and `to` dates
3. if needed for legibility or collision avoidance, append a short deterministic suffix derived from the selected issue set

The campaign id is an observability output identifier, not a new runtime entity.

### `summary.md`

Should include:

1. campaign id and selection summary
2. issue count
3. outcome counts such as succeeded, failed, partial, and unknown
4. attempt and PR totals when derivable
5. a concise overall outcome statement
6. notable conclusions grounded in the selected issue reports

### `timeline.md`

Should include:

1. one ordered merged timeline across the selected issue reports
2. issue numbers/titles attached to each entry
3. stable event ordering with explicit notes when issue timelines were partial
4. enough detail to show major transitions such as claim, plan review, runner start, PR open, review feedback, retry, success, or failure

### `github-activity.md`

Should include:

1. aggregate PR count and per-issue PR references
2. review-round totals and actionable-review totals when present
3. pending/failing check patterns across the selected reports
4. merge/close availability notes when per-issue reports lacked those facts
5. a concise cross-issue GitHub activity summary

### `token-usage.md`

Should include:

1. an aggregate campaign token/cost status of `unavailable`, `partial`, `estimated`, or `complete`
2. total tokens and cost only when the selected issue reports support those totals
3. issue-level and session-level availability notes where needed
4. explicit accounting of how many selected reports were complete, partial, or unavailable for token usage

### `learnings.md`

Should include:

1. cross-issue conclusions grounded in repeated evidence across the selected reports
2. recurring failure modes
3. recurring review or CI friction when present
4. concrete changes to make, phrased as evidence-backed follow-up guidance rather than speculative narrative
5. explicit gaps where the selected reports do not justify a stronger conclusion

## State Model / Failure Matrix

This issue does not change long-running orchestration, retries, continuations, reconciliation, leases, or handoff states, so an orchestrator runtime state machine is not required.

The campaign generator still needs an explicit read-side failure matrix:

| Observed condition                                                            | Local facts available                                                      | Expected behavior                                                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Explicit issue list where every requested issue has a current stored report   | generated `report.json` and `report.md` for each issue                     | generate all campaign markdown files successfully                                            |
| Explicit issue list where one or more requested issues lack generated reports | some requested report directories missing                                  | fail clearly and instruct the operator to generate the missing issue reports first           |
| Stored report exists but uses an older schema version                         | stale `report.json`                                                        | fail clearly and instruct the operator to regenerate that issue report first                 |
| Date-window selection matches a non-empty set of reports                      | report metadata and summary timestamps                                     | generate campaign files from the selected set                                                |
| Date-window selection matches no reports                                      | report directories exist but none overlap the requested window             | fail clearly instead of writing an empty campaign digest                                     |
| Selected reports contain partial timeline or GitHub data                      | mixed complete and partial issue reports                                   | generate the campaign digest with explicit partial notes in affected sections                |
| Selected reports contain mixed token-usage statuses                           | issue reports with `complete`, `partial`, and `unavailable` token sections | aggregate only supported totals and surface a campaign-level partial/unavailable explanation |
| Campaign output directory does not exist yet                                  | readable issue reports only                                                | create `.var/reports/campaigns/<campaign-id>/` and write all required files                  |
| One campaign output file write fails                                          | in-memory aggregated campaign facts                                        | fail loudly; do not silently claim success                                                   |

## Storage / Persistence Contract

This issue adds a detached generated-output contract under `.var/reports/campaigns/`; it does not create new canonical runtime state.

Contract rules:

1. stored per-issue reports remain the canonical campaign inputs
2. campaign markdown outputs are derived artifacts and can be regenerated
3. writing a campaign digest must not mutate any per-issue report or raw issue artifact
4. campaign generation should use atomic writes for each output file, consistent with the existing reporting path
5. a rerun with the same selection may rewrite the same campaign directory deterministically

## Observability Requirements

1. each campaign file must remain readable even when some selected issue reports are partial
2. section-level notes must distinguish between unavailable source facts and actual observed outcomes
3. the command output should tell the operator which campaign id was generated and where the files were written
4. campaign learnings must remain traceable to the selected issue reports rather than unstated operator judgment

## Implementation Steps

1. Extend `src/cli/report.ts` so `parseReportArgs()` and `runReportCli()` support a new `campaign` command while preserving the existing `issue` and `publish` flows.
2. Add campaign path helpers and report-set discovery/loading helpers under `src/observability/` that reuse the stored issue-report reader and schema validation.
3. Implement selection helpers for explicit issue lists and inclusive date-window filtering over stored issue reports.
4. Implement a typed in-memory campaign digest model that aggregates:
   - overall outcome counts and notable conclusions
   - merged timeline entries across issues
   - PR/review/check activity across the selected reports
   - campaign-level token totals and availability
   - evidence-backed cross-issue learnings and gaps
5. Implement deterministic markdown renderers for `summary.md`, `timeline.md`, `github-activity.md`, `token-usage.md`, and `learnings.md`.
6. Implement a campaign writer that creates `.var/reports/campaigns/<campaign-id>/` and writes the required files atomically.
7. Add unit tests for CLI argument parsing, selection logic, aggregation rules, campaign-id derivation, and markdown rendering.
8. Add integration tests that:
   - generate multiple issue reports from fixtures
   - run `symphony-report campaign --issues ...`
   - run `symphony-report campaign --from ... --to ...`
   - verify the required output files and partial-data behavior
9. Update `README.md` with campaign command examples and output locations.

## Tests And Acceptance Scenarios

### Unit

1. parses `campaign --issues 32,43,44` into a validated issue-number selection
2. parses `campaign --from 2026-03-01 --to 2026-03-07` into a validated inclusive date-window selection
3. rejects invalid combinations such as mixing `--issues` with `--from` or omitting one date bound
4. derives stable campaign ids for explicit issue sets and date-window selections
5. selects reports by overlapping issue-window facts and falls back to `generatedAt` only when necessary
6. aggregates mixed issue outcomes, PR counts, review rounds, and token-usage statuses correctly
7. renders all five campaign markdown files with explicit partial/unavailable notes when needed

### Integration

1. `symphony-report campaign --issues 32,43,44` generates the five required files from existing generated issue reports
2. `symphony-report campaign --from 2026-03-01 --to 2026-03-07` selects the expected locally generated issue reports and generates the same stable file set
3. missing or stale issue reports fail clearly with a regeneration instruction instead of silently skipping them
4. mixed complete and partial issue reports still generate a campaign digest with explicit section notes

### End-to-End

1. a realistic local reporting flow can generate several per-issue reports first, then produce one campaign digest whose sections mirror the useful summary/timeline/GitHub/token/learnings concepts from the first factory-run writeup

## Acceptance Scenarios

1. The CLI can generate a campaign digest from an explicit issue list.
2. The CLI can generate a campaign digest from an inclusive date window over existing issue reports.
3. The campaign digest always writes `summary.md`, `timeline.md`, `github-activity.md`, `token-usage.md`, and `learnings.md`.
4. Campaign aggregation stays provider-neutral at the core and remains detached from tracker transport, archive publication, and runtime coordination.
5. Issue-level reporting and campaign-level reporting remain clearly separated: per-issue reports are inputs, and campaign digests are a higher-level derived output.

## Exit Criteria

1. `symphony-report` exposes a working `campaign` subcommand with explicit issue-list and date-window selection
2. campaign digests are generated entirely from structured local reporting artifacts
3. the required five campaign markdown files are written under `.var/reports/campaigns/<campaign-id>/`
4. mixed data availability is handled explicitly rather than hidden
5. tests cover both selection modes and representative partial-data paths
6. docs describe the detached campaign-reporting workflow

## Deferred To Later Issues Or PRs

1. publishing campaign digests to `factory-runs`
2. automatic backfill or scheduled campaign generation
3. campaign JSON or other archive-oriented machine-readable contracts
4. richer campaign slicing such as wave identifiers, label-based cohorts, or tracker-native queries
5. cross-repo or multi-factory campaign aggregation

## Decision Notes

1. This plan intentionally treats existing generated issue reports as the campaign system of record to keep the campaign layer provider-neutral and detached from raw tracker transport.
2. The command should fail on missing or stale per-issue reports rather than silently regenerating them because implicit regeneration would blur issue-level and campaign-level responsibilities and broaden the review surface.
