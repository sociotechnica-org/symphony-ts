# Issue 44 Plan: Generate Per-Issue Reports From Local Artifacts

## Status

`plan-ready`

## Goal

Add a read-only CLI at `bin/symphony-report.ts` that reads the canonical local issue artifacts from `#43`, derives one canonical generated report document (`report.json`), renders a human-readable markdown companion (`report.md`), and writes both under `.var/reports/issues/<issue-number>/` without embedding report composition into the orchestrator runtime.

## Scope

This slice covers:

1. a canonical generated report schema for `report.json`
2. a markdown rendering contract for `report.md` with the required stable section names
3. read-side observability services that load issue artifacts, derive report facts, and write generated outputs
4. a standalone CLI/script with command shape `pnpm tsx bin/symphony-report.ts issue --issue <issue-number>`
5. tests that prove reports generate for completed and failed issues even when some data is unavailable
6. docs updates for command usage and output locations

## Non-goals

This slice does not include:

1. changing the raw artifact contract introduced in `#43`
2. publishing reports or raw artifacts to `factory-runs` or any remote destination
3. making report generation an inline or required orchestrator step
4. provider-specific token enrichment, pricing tables, or log parsing beyond what canonical local artifacts already expose
5. defining multi-issue, campaign, or run-digest report formats
6. refactoring tracker, runner, workspace, or orchestrator control flow unless a narrow read-side seam requires a small helper extraction

## Current Gaps

After `#43`, the runtime writes durable raw issue artifacts under `.var/factory/issues/<issue-number>/...`, but there is no detached report surface yet:

1. operators cannot generate a single per-issue summary from local artifacts
2. there is no canonical generated report schema for downstream tooling to consume
3. there is no markdown rendering that keeps the useful `lifebuild` sections stable across issues
4. token usage must currently remain explicit about availability gaps because the raw artifact contract does not guarantee provider totals
5. generated outputs do not yet have a stable repo-local path separate from raw artifacts

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_44/docs/architecture.md).

- Policy Layer: the stable report section names, fallback behavior for unavailable data, and operator-facing conclusions belong here. This issue does not introduce new tracker or orchestration policy.
- Configuration Layer: if the command needs path resolution helpers, they should stay as typed config/path resolution at the boundary. This issue should not add workflow-frontmatter or runtime config knobs.
- Coordination Layer: untouched. The orchestrator must remain the producer of raw artifacts, not the composer of reports.
- Execution Layer: untouched except for existing artifact inputs. Workspace and runner behavior must not change to satisfy report formatting.
- Integration Layer: read-side loading of normalized local artifacts is allowed; provider-specific enrichment and remote lookups are deferred to `#46`.
- Observability Layer: owns the generated report schema, artifact readers, derivation pipeline, markdown rendering, output-path helpers, and the standalone CLI/service surface.

## Architecture Boundaries

### Observability

Belongs here:

1. typed `report.json` contract and report derivation result types
2. readers for canonical local issue artifacts produced by `#43`
3. deterministic output paths under `.var/reports/issues/<issue-number>/`
4. markdown rendering from canonical report facts
5. explicit availability states for token usage and other incomplete sections

Does not belong here:

1. tracker mutations
2. retry or review-loop decisions
3. provider-specific network enrichment
4. any second source of truth that diverges from the raw artifacts

### CLI

Belongs here:

1. argument parsing for the standalone report command
2. wiring the report generator to the local repository paths
3. rendering simple success or failure output for operators

Does not belong here:

1. report composition logic inline in argument parsing
2. orchestrator startup or run-loop side effects

### Orchestrator

Belongs here:

1. nothing new in this issue beyond continuing to emit raw artifacts through existing observability hooks

Does not belong here:

1. calling the report generator inline
2. emitting markdown or generated report documents

### Tracker / Runner / Workspace

Belongs here:

1. no new responsibilities in this slice

Does not belong here:

1. ad hoc data shims created only to satisfy report rendering
2. provider-specific token/cost estimation logic at the core layer

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on a narrow read-side seam:

1. add report schema, derivation, and rendering under `src/observability/`
2. add a separate CLI entry point and any small path helpers needed to invoke it
3. add focused unit/integration/e2e coverage for the report command and generated outputs
4. update docs for command usage

This PR deliberately defers:

1. provider-specific enrichment and token parsing from external logs to `#46`
2. remote publication or archival upload
3. multi-issue digest composition
4. any raw artifact schema expansion unless an omission blocks basic report generation and is approved separately

The seam is reviewable because it adds a pure read-side observability consumer over the existing `#43` contract without reopening orchestrator coordination logic.

## Report Data Model

Add a generated report contract rooted at:

```text
.var/reports/
  issues/
    <issue-number>/
      report.json
      report.md
```

### `report.json`

`report.json` is canonical and versioned. It should include these top-level sections:

1. `summary`
2. `timeline`
3. `githubActivity`
4. `tokenUsage`
5. `learnings`
6. `artifacts`
7. `operatorInterventions`

### Summary contract

The summary section should capture:

1. issue identifier, number, title, repo, and URL
2. derived final or current outcome
3. start and end timestamps when derivable
4. attempt count
5. PR count
6. overall conclusion text that stays explicit when data is partial

### Timeline contract

The timeline should be an ordered sequence of major derived events built from `events.jsonl`, attempt snapshots, and issue summary state. It should preserve stable event kinds and include explicit fallback notes when expected transitions are missing from raw artifacts.

### GitHub activity contract

The GitHub activity section should summarize facts derivable from canonical raw artifacts only, such as:

1. PR count and known PR identifiers
2. latest review and checks snapshots
3. whether the issue ended awaiting review, succeeded, failed, or needs follow-up
4. explicit unavailable notes for issue state/label transitions or merged/closed timing when raw artifacts do not capture them yet

### Token usage contract

The token usage section should always include a machine-readable status:

1. `unavailable`
2. `partial`
3. `estimated`
4. `complete`

For this slice, the default expectation is `unavailable` or `partial` unless canonical local artifacts already provide enough facts. The section must also include:

1. an explanation of why totals are unavailable or partial
2. references to session artifacts and raw log pointers that could support later enrichment
3. totals only when they can be derived from canonical local artifacts without provider-specific guessing

### Learnings contract

The learnings section should distinguish:

1. evidence-backed observations directly grounded in the raw artifacts
2. explicit gaps where the report cannot conclude more without richer observability

Initial learnings may be conservative. The goal is an explicit section, not artificial certainty.

### Artifacts contract

The artifacts section should point to:

1. the raw issue artifact directory
2. `issue.json`, `events.jsonl`, attempts, sessions, and log pointer documents
3. the generated `report.json` and `report.md` paths

### Operator interventions contract

This section should enumerate manual actions only when they can be derived from canonical local artifacts or recorded as absent/unavailable. It must not infer human actions from provider-specific transport details that are not in the local contract.

## Rendering Rules For `report.md`

`report.md` should be a deterministic rendering of `report.json`, not a separate derivation path. It must always render these sections in this order:

1. `Summary`
2. `Timeline`
3. `GitHub Activity`
4. `Token Usage`
5. `Learnings`
6. `Artifacts`
7. `Operator Interventions`

Markdown should remain readable even when data is missing:

1. explicitly print `Unavailable`, `Partial`, or equivalent explanatory text
2. keep empty sections from collapsing away
3. prefer short factual bullets/tables over narrative prose

## State Model / Failure Matrix

This issue does not change long-running orchestration, retries, leases, or reconciliation behavior, so a runtime state machine for orchestrator control flow is not required.

The report generator itself should still handle a small read-side failure matrix:

| Observed condition                                                                                                      | Local facts available                                                                                                                                  | Expected behavior                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed or failed issue with a full raw artifact directory                                                            | `issue.json`, `events.jsonl`, attempts, sessions                                                                                                       | Generate both reports successfully                                                                                                                                                                                                                 |
| Issue artifact directory exists but some optional files are missing                                                     | `issue.json` plus partial attempt/session data                                                                                                         | Generate a partial report with explicit unavailable notes                                                                                                                                                                                          |
| Canonical orchestrator artifacts are missing or incomplete but canonical issue/session artifacts still anchor the issue | enough canonical local facts to identify the issue, plus session snapshots and/or log pointers, but missing `issue.json` and/or `events.jsonl` details | Generate a partial report with explicit `Unavailable` / `Partial` notes for missing orchestration facts, anchor the report to the issue from remaining canonical artifacts, and do not reconstruct missing facts by parsing provider-specific logs |
| Token totals are not present in canonical artifacts                                                                     | session files and maybe log pointers only                                                                                                              | Mark token usage `unavailable` or `partial` and reference raw artifacts                                                                                                                                                                            |
| Generated output directory does not exist yet                                                                           | readable raw artifacts only                                                                                                                            | Create `.var/reports/issues/<issue-number>/` and write outputs                                                                                                                                                                                     |
| Raw artifact files are malformed                                                                                        | unreadable or invalid JSON/JSONL                                                                                                                       | Fail loudly with an observability/read error and do not mutate runtime state                                                                                                                                                                       |
| Issue number has no local artifact directory                                                                            | none                                                                                                                                                   | Exit with a clear error that the requested issue report cannot be generated from local artifacts                                                                                                                                                   |

## Implementation Steps

1. Add typed report contracts and output path helpers under `src/observability/`.
2. Implement a read-only issue artifact loader/aggregator that converts `#43` raw artifacts into a canonical in-memory report model, including fallback anchoring when `issue.json` or `events.jsonl` are incomplete but session or log-pointer artifacts still provide canonical issue identity.
3. Implement deterministic markdown rendering from that canonical report model.
4. Implement a report writer that writes `report.json` and `report.md` atomically under `.var/reports/issues/<issue-number>/`.
5. Add `bin/symphony-report.ts` and the supporting CLI module for `issue --issue <issue-number>`.
6. Add unit tests for report derivation and markdown rendering.
7. Add integration-style CLI tests that generate outputs from fixture artifact directories, including the missing-orchestrator-artifact / still-has-session-artifacts case.
8. Add an end-to-end style test that uses realistic raw artifact fixtures from a completed or failed issue flow and verifies both outputs.
9. Update `README.md` with the standalone report command and generated output location.

## Tests And Acceptance Scenarios

### Unit

1. derives summary, timeline ordering, artifact pointers, and conclusion text from canonical raw artifacts
2. renders markdown with all required section headings even when data is unavailable
3. reports token usage status as `unavailable` or `partial` when totals cannot be derived
4. keeps `report.md` aligned with `report.json` facts rather than recomputing a separate story

### Integration

1. CLI generates `.var/reports/issues/<issue-number>/report.json` and `report.md` for a completed issue fixture
2. CLI generates readable outputs for a failed issue fixture with partial data
3. CLI generates a partial report when `issue.json` or `events.jsonl` is missing/incomplete but session artifacts and/or log pointers still canonically anchor the issue
4. CLI fails clearly when the requested issue has no local artifacts

### End-to-end

1. a realistic local issue artifact tree produced by the current runtime can be fed into `pnpm tsx bin/symphony-report.ts issue --issue <issue-number>` and yields both outputs without mutating raw artifacts

## Acceptance Scenarios

1. Given a completed issue artifact tree, when the operator runs `pnpm tsx bin/symphony-report.ts issue --issue 44`, then `.var/reports/issues/44/report.json` and `.var/reports/issues/44/report.md` are written and the markdown includes `Summary`, `Timeline`, `GitHub Activity`, `Token Usage`, and `Learnings`.
2. Given a failed issue artifact tree with incomplete token data, when the operator runs the same command, then both outputs are still generated and token status is explicitly `unavailable` or `partial`.
3. Given canonical session artifacts and/or log pointers for issue `44` but incomplete `issue.json` or `events.jsonl`, when the operator runs the command, then both outputs are still generated, missing orchestration facts are marked `Unavailable` or `Partial`, and the command does not parse provider-specific logs to fill those gaps.
4. Given a missing local artifact tree, when the operator runs the command, then the command exits with a clear error and does not create misleading report contents.

## Exit Criteria

This issue is complete when:

1. the checked-in plan is approved or explicitly waived
2. the standalone report command exists and runs independently from `symphony run`
3. `report.json` is the canonical generated report format with the required top-level sections
4. `report.md` is rendered from the same underlying report facts and always includes the required stable sections
5. local tests cover completed, failed, and partial-data report generation
6. repo docs explain the command and generated output path

## Deferred To Later Issues Or PRs

1. provider-specific token/cost enrichment and log parsing in `#46`
2. archive publication or `factory-runs` upload
3. report generation as an optional orchestrator follow-up step, if ever needed
4. multi-issue or campaign digest reports
5. richer GitHub state/label transition reporting if the raw local artifact contract grows to include it

## Decision Notes

1. `report.json` is the only canonical generated report. `report.md` is a pure rendering so downstream tooling has one machine-readable source of truth.
2. The report command stays detached from `symphony run` so observability does not leak back into coordination.
3. Missing enrichment should be surfaced explicitly instead of guessed from provider-specific logs. That keeps the core command provider-neutral and preserves the raw artifact contract as the source of truth.
4. Partial generation is preferable to failure when canonical local artifacts still anchor the report to the issue, but missing orchestrator facts must remain visibly missing rather than being reconstructed from provider-specific logs.
