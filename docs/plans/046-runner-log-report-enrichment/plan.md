# Issue 46 Plan: Runner-Specific Log Enrichment For Reporting

## Status

`plan-ready`

## Goal

Add an explicit optional enrichment seam for runner-specific log readers so per-issue reports can incorporate Codex JSON log details now, and future runner-specific details later, without changing the canonical local artifact contract or making the core report generator depend on any one provider.

## Scope

This slice covers:

1. a provider-neutral report-enrichment contract in `src/observability/` that report generation can invoke optionally
2. merge rules so enrichers can add optional token usage, richer session detail, and evidence-backed final agent summaries without replacing canonical report state
3. one Codex-specific enrichment adapter that reads local Codex JSONL session logs and returns optional additions when it can match them to canonical session artifacts
4. a narrow `LocalRunner` metadata improvement so canonical session artifacts can identify Codex-backed sessions with provider/model facts while keeping the raw artifact schema unchanged
5. tests and docs proving that reports still generate successfully when no enrichers are present or when Codex logs are missing, unreadable, or malformed

## Non-goals

This slice does not include:

1. changing the canonical local issue artifact layout or schema from `#43`
2. turning `report.json` or `report.md` into Codex-specific outputs
3. requiring Codex logs for report generation success
4. scraping raw runner logs to reconstruct canonical issue outcome, PR state, or tracker lifecycle facts
5. adding Claude Code, VM-backed, or remote-runner enrichers in the same PR
6. changing orchestrator retry, review-loop, or tracker policy

## Current Gaps

After `#44` and `#45`, report generation is intentionally provider-neutral, but it has no optional runner-enrichment seam:

1. `src/observability/issue-report.ts` hard-codes token usage as unavailable and defers richer log-derived detail to `#46`
2. there is no adapter interface for provider-specific log parsing; any Codex support would currently have to leak into the core report builder
3. the real `LocalRunner` currently records provider `local-runner` with no backend-specific identity, so canonical session snapshots do not distinguish Codex-backed runs from other local commands
4. Codex does persist local JSONL session files under `~/.codex/sessions/...`, but the report pipeline has no safe, optional path for reading or matching them
5. there is no failure policy for malformed or unmatched runner logs beyond “ignore them and keep the canonical report working”

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_46/docs/architecture.md).

- Policy Layer: owns the rule that canonical issue artifacts and the report core remain provider-neutral, enrichers are optional, and malformed runner logs never block report generation. This layer should define what counts as an optional addition and what stays canonical.
- Configuration Layer: intentionally untouched for `WORKFLOW.md` schema. This issue should not add runtime config knobs for enrichers. If any selection logic is needed, it should stay in code defaults or runner/session metadata rather than new workflow policy.
- Coordination Layer: untouched. The orchestrator must not gain new retry or lifecycle logic for report enrichment.
- Execution Layer: owns only the narrow metadata improvement in `LocalRunner.describeSession()` so canonical session snapshots can carry backend identity such as `provider: "codex"` and parsed model when derivable from the configured command. Execution does not parse provider logs into report facts.
- Integration Layer: runner-specific log parsing lives at the edge as explicit adapters. For this issue, the Codex adapter reads Codex JSONL session files and normalizes optional additions for the report layer. It must not mutate canonical artifacts or tracker state.
- Observability Layer: owns the provider-neutral enrichment contract, merge rules, report-schema extensions that stay provider-neutral, and the report-generator orchestration that applies zero or more enrichers over canonical loaded artifacts.

## Architecture Boundaries

### Observability

Belongs here:

1. the provider-neutral `IssueReportEnricher` contract and enrichment input/output types
2. merge rules for optional additions into the generated report
3. report-level availability/explanation rules when enrichment is absent, partial, or malformed
4. report-schema and markdown updates that remain provider-neutral

Does not belong here:

1. Codex JSONL parsing details
2. runner-command parsing beyond already-normalized session metadata
3. any second source of truth for canonical issue state

### Runner

Belongs here:

1. backend identity in canonical session descriptions when the local command is recognizably Codex
2. parsed model name when it is directly available from the configured runner command
3. provider-specific enrichment adapters that sit at the runner edge and normalize optional log-derived facts for observability

Does not belong here:

1. report composition policy
2. tracker or orchestrator decisions
3. rewriting canonical report outcome from raw logs

### CLI

Belongs here:

1. continuing to invoke report generation without requiring enrichment flags
2. wiring built-in enrichers, if needed, as optional defaults for the detached report command

Does not belong here:

1. Codex JSON parsing inline in the command handler
2. a new configuration surface for enabling enrichment in this slice

### Orchestrator

Belongs here:

1. nothing new beyond continuing to emit canonical session snapshots and log pointers

Does not belong here:

1. report enrichment logic
2. log-reader retries or fallback heuristics

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on one narrow seam: optional read-side enrichment on top of existing report generation, plus the minimum execution metadata needed for future reports to identify Codex-backed sessions cleanly.

The PR should include:

1. provider-neutral enrichment contracts and merge logic under `src/observability/`
2. one Codex adapter at the runner edge
3. the small `LocalRunner.describeSession()` improvement for provider/model identity
4. focused unit/integration coverage plus one realistic report-generation flow using Codex-style JSONL fixtures
5. docs updates for the optional enrichment behavior

This PR deliberately defers:

1. additional runner enrichers for Claude Code or VM-backed runners
2. any raw artifact schema expansion
3. archive-publication changes in `factory-runs`
4. richer runner-side log-pointer capture beyond what the current canonical contract already permits

The seam is reviewable because it does not reopen tracker integration, orchestrator state, or the canonical artifact contract; it only adds an optional consumer path over existing artifacts.

## Enrichment Model

Introduce a provider-neutral enrichment flow:

1. load canonical local issue artifacts exactly as today
2. build the canonical core report exactly as today
3. invoke zero or more `IssueReportEnricher`s with canonical session/attempt artifacts and report context
4. merge any successful optional additions into provider-neutral report fields
5. record explicit partial/unavailable notes when enrichers do not match, cannot parse logs, or produce only partial facts

### Contract rules

1. the core report must remain valid with an empty enricher list
2. enrichers may only add optional detail; they may not overwrite canonical issue identity, lifecycle, PR counts, or final outcome
3. enrichers must return normalized data, not raw provider payloads
4. merge behavior must be deterministic when multiple enrichers contribute to different sessions
5. malformed enrichment input must degrade to “no enrichment” plus notes, not a report-generation failure

## Codex Adapter Strategy

The Codex adapter should work from canonical session anchors plus local Codex session files:

1. only consider canonical sessions that identify as Codex-backed after the runner metadata improvement
2. scan local Codex JSONL session files under `~/.codex/sessions/...`
3. match candidate JSONL sessions to canonical sessions using stable evidence such as workspace path (`cwd` in Codex `session_meta`), session timing, and session/provider identity
4. extract only optional additions that are well-supported by the log format, such as token totals from `event_msg` `token_count` payloads, richer session/source detail from `session_meta`, and final assistant summaries from terminal assistant message items when available
5. if matching is ambiguous or parsing fails, return no enrichment for that session and keep the report canonical

### Decision notes

1. The adapter should prefer evidence-backed matching over brittle assumptions about file names, because Codex session-file ids are not the same as Symphony run-session ids.
2. The adapter should not rely on `--json` being added to the configured runtime command in this issue. Existing local Codex session persistence is the primary source.
3. The report should expose enriched source artifact paths so operators can trace any token or summary detail back to the matched Codex JSONL file.

## Runtime State / Failure Matrix

This issue does not change long-running orchestration, retries, reconciliation, leases, or handoff states, so an orchestrator runtime state machine is not required.

The read-side enrichment path still needs an explicit failure matrix:

| Observed condition                                               | Local facts available                                          | Expected behavior                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No enrichers are registered                                      | canonical raw artifacts only                                   | generate the same provider-neutral report as today                                               |
| A session is not identified as Codex-backed                      | canonical session snapshot only                                | skip Codex enrichment for that session                                                           |
| Codex-backed session has one clear JSONL match                   | canonical session snapshot plus readable Codex JSONL           | merge optional token/session/summary detail into the report                                      |
| Codex-backed session has no matching JSONL file                  | canonical session snapshot only                                | keep the canonical report, leave token usage unavailable/partial, and record an explanatory note |
| Codex-backed session has multiple plausible JSONL matches        | canonical session snapshot plus multiple candidate JSONL files | skip ambiguous enrichment and record a note instead of guessing                                  |
| Matched Codex JSONL file is malformed or missing expected fields | canonical session snapshot plus unreadable or partial JSONL    | ignore the malformed enrichment, keep report generation successful, and record a note            |
| Mixed sessions exist across providers                            | canonical sessions from multiple providers                     | enrich only the sessions with a matching adapter; leave the rest unchanged                       |

## Storage / Persistence Contract

This issue does not introduce a new durable artifact contract.

Contract rules:

1. canonical artifacts under `.var/factory/...` remain the source of truth
2. generated reports under `.var/reports/...` remain detached derived outputs
3. runner-specific log files remain external inputs referenced by enrichment, not new canonical persisted state
4. any new report fields introduced for enrichment must be safely nullable and versioned within the generated report contract

## Observability Requirements

1. report JSON must make it clear whether token/session enrichments are unavailable, partial, or complete
2. enriched session facts must retain source artifact references to the matched Codex JSONL files
3. markdown rendering must remain readable when enrichment is absent
4. if enrichment is skipped due to ambiguity or malformed input, the resulting note should be factual and provider-neutral from the report consumer’s perspective

## Implementation Steps

1. Extract provider-neutral enrichment types and merge helpers from `src/observability/issue-report.ts` into focused modules.
2. Extend the report contract in a provider-neutral way so optional enriched token/session detail and evidence-backed final summaries can be represented without forcing provider-specific fields into canonical sections.
3. Update `generateIssueReport()` / `writeIssueReport()` so report generation accepts an optional enricher list and applies enrichers after the canonical core report is built.
4. Implement a Codex runner-log enricher at the runner edge that:
   - finds candidate Codex JSONL files
   - matches them to canonical Codex sessions
   - extracts token totals, session metadata, and final assistant summaries when present
   - returns normalized optional additions only
5. Improve `LocalRunner.describeSession()` so Codex commands produce `provider: "codex"` and parsed model values when derivable, while unknown commands continue to fall back safely.
6. Update markdown rendering to surface enriched token/session detail and any additional factual notes without making sections disappear when enrichment is absent.
7. Add or refresh fixtures for Codex JSONL session logs that cover successful enrichment, missing logs, malformed logs, and ambiguous matches.
8. Update README or reporting docs to describe enrichment as optional and Codex as the first built-in adapter.

## Tests And Acceptance Scenarios

### Unit

1. report generation with no enrichers preserves the current provider-neutral behavior
2. merge logic applies optional enrichment without changing canonical outcome, issue identity, or PR facts
3. `LocalRunner.describeSession()` identifies Codex commands and model flags while keeping unknown commands on the fallback path
4. the Codex adapter parses token counts, source metadata, and final assistant summaries from representative JSONL fixtures
5. ambiguous or malformed Codex JSONL inputs yield no enrichment rather than throwing

### Integration

1. `symphony-report issue --issue <n>` generates a report with enriched token usage and session detail when canonical artifacts plus matching Codex JSONL fixtures are present
2. the same command still succeeds when Codex logs are missing, malformed, or unmatched, and the report explicitly stays partial/unavailable for those additions
3. mixed-session fixtures enrich only the Codex-backed session entries and leave others unchanged

### End-to-End

1. a realistic issue-artifact fixture with Codex-backed sessions generates `report.json` and `report.md` that include optional Codex-derived token/session detail while preserving canonical outcome and artifact references

## Acceptance Scenarios

1. Reports consume zero enrichers and still generate successfully with the current provider-neutral output.
2. Reports consume the built-in Codex enricher and surface optional token totals, richer session metadata, or final summaries when a Codex JSONL match is available.
3. Missing, malformed, or ambiguous Codex logs do not fail report generation.
4. The enrichment seam is explicit enough that a later Claude Code or VM-backed adapter can implement the same interface without changing the core report builder.

## Exit Criteria

1. the report generator has an explicit optional enricher interface
2. Codex enrichment is implemented as one adapter, not embedded into the core report builder
3. canonical local artifacts and canonical report conclusions remain provider-neutral
4. real reports continue to generate with no enrichers or with broken Codex inputs
5. tests cover both enriched and unenriched paths
6. docs explain the optional enrichment behavior and its current Codex-first support

## Deferred To Later Issues Or PRs

1. Claude Code enrichment
2. VM-backed runner enrichment
3. stronger runner-side persistence of provider log pointers when future backends expose stable session ids or file paths
4. cost estimation policies beyond raw token totals
5. any canonical artifact changes that would make runner-log matching more direct
