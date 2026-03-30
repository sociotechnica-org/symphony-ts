# Issue 253 Plan: Complete Claude Code Token And Cost Accounting In Canonical Session Artifacts And Reports

## Status

`plan-ready`

## Goal

Make Claude Code runs preserve all backend-provided token and cost facts that Symphony can observe in canonical session artifacts, then project those canonical facts through issue and campaign reports so Claude-backed runs stop collapsing to avoidable `null` totals when the live runner already emitted usable accounting data.

## Scope

This slice covers:

1. normalizing Claude Code stdout/result usage payloads into the existing runner-accounting shape
2. deterministically deriving `totalTokens` when canonical Claude component counts are sufficient even if Claude omitted a direct total
3. persisting that normalized accounting in canonical session artifacts during live runs
4. updating per-issue and campaign report aggregation so canonical reports expose both strict full totals and explicit observed subtotals when some sessions remain partial
5. keeping report explanations and markdown explicit about `complete`, `partial`, `estimated`, and `unavailable` accounting
6. focused unit, integration, and end-to-end coverage for the Claude accounting path

## Non-goals

This slice does not include:

1. tracker transport, normalization, or policy changes
2. orchestrator retry, continuation, lease, or landing-policy redesign
3. provider-pricing estimation for runs that did not emit an explicit backend cost fact
4. a new runner-agnostic accounting event protocol or report schema unrelated to Claude accounting gaps
5. archive publication changes under `factory-runs`
6. raw Claude transcript persistence beyond existing log-pointer surfaces

## Current Gaps

Today the accounting path is incomplete for Claude Code:

1. `src/orchestrator/running-entry.ts` only recognizes token/cost shapes already used by Codex-style events and generic flat `usage` objects
2. Claude Code result payloads currently expose usage under Claude-specific nested structures such as `modelUsage`, but that data is not normalized into `RunnerAccountingSnapshot`
3. canonical session artifacts therefore often persist `accounting: unavailable` even when Claude emitted input/output token facts or explicit cost
4. when Claude emits sufficient component counts but omits a direct `totalTokens`, the current normalization path leaves `totalTokens` null instead of deterministically deriving the canonical total from the observed components
5. `src/observability/issue-report.ts` and `src/observability/campaign-report.ts` use strict all-present aggregation for `totalTokens` and `costUsd`, so one missing session nulls the aggregate even when several canonical sessions did contribute observed totals
6. current reports do not distinguish cleanly between “strict aggregate unavailable” and “observed subtotal available from the canonical sessions we do have”

## Decision Notes

1. Keep Claude-specific payload parsing at the execution boundary where runner updates are normalized into `RunnerAccountingSnapshot`. Do not teach report code how to parse raw Claude payloads.
2. Reuse the existing canonical `session.accounting` contract instead of adding a second Claude-only artifact field. The artifact contract should stay provider-neutral.
3. When canonical Claude token component fields are sufficient, derive `totalTokens` during normalization instead of leaving the canonical snapshot permanently partial by default. Keep that derivation deterministic and limited to arithmetic over already-canonical component counts; do not introduce pricing inference or opaque estimation.
4. Extend report schemas only where the canonical reporting surface genuinely needs additional fields to represent observed subtotals. Do not overload `totalTokens` or `costUsd` with mixed semantics.
5. Preserve strict aggregate totals for “all selected sessions/issues supplied this fact” while separately surfacing observed subtotals for partial runs. This keeps exact totals inspectable without hiding useful partial evidence.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: repo-owned reporting rules for when token/cost aggregates are `complete`, `partial`, `estimated`, or `unavailable`, and the rule that canonical artifacts remain the system of record
  - does not belong: Claude JSON parsing details or arithmetic over raw runner payloads
- Configuration Layer
  - belongs: no workflow schema change in this slice
  - does not belong: hidden Claude accounting toggles or report-mode flags
- Coordination Layer
  - belongs: unchanged orchestration flow that keeps storing normalized runner accounting as part of the existing session-state path
  - does not belong: Claude-specific branching, retry policy changes, or new handoff states
- Execution Layer
  - belongs: extracting Claude token/cost facts from live stdout/result payloads, deterministically deriving `totalTokens` from sufficient canonical component fields, and normalizing the result into `RunnerAccountingSnapshot`
  - does not belong: tracker lifecycle decisions or report rendering policy
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: Claude runner-result parsing, which is an execution concern, or report aggregation, which is observability
- Observability Layer
  - belongs: canonical session artifact persistence, issue/campaign report aggregation, markdown rendering, and explicit partial-accounting explanations
  - does not belong: raw Claude payload parsing or provider-pricing estimation

## Architecture Boundaries

### Execution Layer

Belongs here:

1. Claude-result usage extraction from runner stdout/update payloads
2. deterministic `totalTokens` derivation from sufficient canonical component counts
3. normalization into the provider-neutral `RunnerAccountingSnapshot`
4. preserving high-water-mark semantics so repeated or cumulative Claude totals do not double-count

Does not belong here:

1. issue-report wording
2. campaign aggregation policy
3. tracker-specific handoff logic

### Observability Layer

Belongs here:

1. persisting normalized accounting into canonical session artifacts
2. deriving issue-level strict totals and observed subtotals from canonical session snapshots
3. deriving campaign-level strict totals and observed subtotals from stored issue reports
4. explicit markdown/report notes about partial accounting coverage

Does not belong here:

1. parsing raw Claude stdout structures
2. provider-specific pricing estimation when the backend never emitted cost
3. orchestration state transitions

### Orchestrator Layer

Belongs here:

1. continuing to pass normalized live accounting through the existing session-artifact write path
2. no structural change beyond consuming the improved normalized accounting

Does not belong here:

1. ad hoc Claude payload inspection inside orchestrator branches
2. report-specific subtotal logic
3. retry or continuation-state refactors

### Tracker / Config / Workspace Layers

Belongs here:

1. nothing new in this slice

Does not belong here:

1. Claude accounting normalization
2. report aggregation changes

## Layering Notes

- `src/runner/` and `src/orchestrator/running-entry.ts`
  - own normalization from provider payloads to `RunnerAccountingSnapshot`
  - do not own report-level subtotal wording or markdown
- `src/observability/issue-artifacts.ts`
  - continues to store the normalized accounting snapshot only
  - does not become a second parser for Claude payloads
- `src/observability/issue-report.ts` and `src/observability/campaign-report.ts`
  - own strict-vs-observed aggregate derivation and explanatory notes
  - do not infer accounting directly from raw logs or raw runner stdout

## Slice Strategy And PR Seam

This should fit in one reviewable PR because it stays on one narrow vertical seam:

1. improve Claude accounting normalization at the execution boundary
2. keep the existing canonical artifact contract but populate it more completely for Claude runs
3. extend issue/campaign report models just enough to represent observed subtotals without weakening strict totals
4. prove the path with focused tests and one realistic Claude-backed report flow

This PR deliberately avoids:

1. tracker changes
2. orchestration policy refactors
3. new workflow config
4. archive publication changes
5. broad report redesign unrelated to accounting

## Runner Accounting State Model

This issue does not change orchestration retries, leases, or handoff states. The stateful surface is the per-session accounting normalization lifecycle.

### States

1. `unavailable`
   - no token or cost facts have been observed for the session
2. `partial`
   - some token and/or cost facts were observed, but the canonical snapshot still lacks either a derivable/explicit `totalTokens` or an explicit `costUsd`
3. `complete`
   - canonical snapshot contains both `totalTokens` and `costUsd`

### Allowed transitions

1. `unavailable -> partial`
   - Claude emits some token components or cost, but not enough to derive/fill the full complete set
2. `unavailable -> complete`
   - Claude emits enough facts to populate or derive `totalTokens` and also provides `costUsd` immediately
3. `partial -> partial`
   - later cumulative payloads add more token detail without yet completing the full set
4. `partial -> complete`
   - later payloads supply the missing explicit cost or enough canonical token components to derive the final total
5. `complete -> complete`
   - later cumulative payloads can increase totals, but normalized accounting remains complete

### Contract rules

1. Claude-specific nested usage payloads must normalize to the same `RunnerAccountingSnapshot` shape used by other runners.
2. If canonical Claude component fields are sufficient to compute `totalTokens`, normalization must derive that total deterministically before setting status.
3. Accounting updates must stay monotonic; decreasing or duplicate cumulative totals must not double-count.
4. Canonical artifacts store only normalized accounting facts, never raw Claude usage payloads.

## Failure-Class Matrix

| Observed condition                                                            | Local facts available                                         | Canonical/normalized facts available                | Expected decision                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Claude final JSON includes nested input/output tokens but no explicit total or cost | live stdout/update payload, session state                     | canonical component counts sufficient to derive total tokens | derive `totalTokens`, persist a `partial` accounting snapshot because cost is still missing, and expose strict totals plus observed subtotal |
| Claude final JSON includes nested input/output tokens and explicit cost but no explicit total | live stdout/update payload, session state                     | canonical component counts plus explicit cost       | derive `totalTokens`, persist a `complete` accounting snapshot, and include it in strict aggregates |
| Claude final JSON includes explicit cost and total tokens                     | live stdout/update payload, session state                     | complete normalized accounting                      | persist a `complete` accounting snapshot and include it in strict aggregates      |
| Claude emits multiple cumulative usage payloads for one session               | prior high-water marks, new payload                           | monotonic accounting state                          | integrate only positive deltas; do not double-count repeated cumulative totals    |
| Claude emits usage under an unrecognized nested shape                         | raw payload only                                              | no new normalized accounting                        | keep canonical accounting unchanged and leave report status partial/unavailable   |
| Some issue sessions have normalized totals and others remain unavailable      | canonical session snapshots                                   | mixed strict and observed facts                     | keep strict aggregate totals null, publish observed subtotals and explicit notes  |
| Campaign selection mixes complete and partial issue reports                   | stored issue reports                                          | mixed issue-level totals and observed subtotals     | keep strict campaign totals null when required, surface observed subtotals clearly |

## Storage / Persistence Contract

This issue keeps the canonical storage contract rooted in `.var/factory/issues/<issue-number>/sessions/<session-id>.json`.

Contract rules:

1. `IssueArtifactSessionSnapshot.accounting` remains the canonical provider-neutral storage field for live runner accounting
2. no Claude-only sibling field is added to session artifacts
3. session accounting snapshots may remain `partial` when the backend did not emit an explicit cost or enough canonical token components to derive a final total
4. generated issue reports remain derived outputs; they may add explicit observed-subtotal fields, but they must continue pointing back to canonical session artifacts as evidence

## Observability Requirements

1. issue reports must keep strict aggregate totals separate from observed subtotals
2. campaign reports must do the same across selected issue reports
3. markdown output must explain why strict totals are null when observed subtotals are still available
4. canonical artifact paths should remain the evidence trail for all accounting facts shown in reports

## Implementation Steps

1. Extend Claude accounting extraction in `src/orchestrator/running-entry.ts` so normalized accounting recognizes Claude result payloads, including nested `modelUsage` token fields and any explicit cost fields Claude emits.
2. Add deterministic `totalTokens` derivation to the normalization path when the canonical Claude component counts are sufficient, keeping the rule provider-neutral at the `RunnerAccountingSnapshot` boundary rather than in report code.
3. Add or update targeted runner/orchestrator tests that prove Claude payloads produce the expected `RunnerAccountingSnapshot` transitions, including component-only derivation cases, and avoid duplicate counting across repeated cumulative payloads.
4. Keep canonical session artifact persistence on the existing path, adding coverage that a Claude-backed run records the normalized accounting in `sessions/<session-id>.json`.
5. Extend the issue-report token-usage model and builder to expose:
   - existing strict `totalTokens` and `costUsd`
   - explicit observed token and cost subtotals derived from whatever canonical sessions did report
   - clear explanations and notes for mixed complete/partial/unavailable sessions
6. Extend the campaign-report token-usage model and builder to aggregate both strict totals and observed subtotals from stored issue reports without weakening the strict fields.
7. Update markdown renderers and any related CLI/report tests to show the new observed-subtotal facts clearly.
8. Run the relevant unit, integration, and end-to-end coverage for Claude-backed reporting.

## Tests And Acceptance Scenarios

### Unit tests

1. Claude result payloads with nested `modelUsage` token facts normalize into `RunnerAccountingSnapshot`.
2. Claude payloads with sufficient canonical component counts but no explicit `totalTokens` derive `totalTokens` deterministically.
3. Claude payloads with explicit cost normalize to `costUsd` without double-counting repeated cumulative totals.
4. Issue-report generation from canonical Claude session artifacts keeps strict totals null when needed but publishes observed subtotals and accurate status/explanation text.
5. Campaign-report aggregation does the same across mixed issue reports.

### Integration tests

1. `report-cli` coverage verifies the rendered issue report includes the observed subtotal fields and explanations for partial Claude accounting.
2. `campaign-report-cli` coverage verifies campaign markdown includes the observed subtotal fields and partial-accounting explanation for mixed reports.

### End-to-end coverage

1. the Claude-backed bootstrap/e2e fixture produces canonical session artifacts with normalized accounting and derived `totalTokens` where component counts are sufficient
2. generating an issue report from that run shows the expected token/cost status and subtotals

### Acceptance scenarios

1. A Claude Code run that emits sufficient canonical input/output token facts but no direct `totalTokens` ends with a canonical session artifact whose `totalTokens` was derived deterministically rather than left null by default.
2. A Claude Code run that emits sufficient canonical token component facts plus explicit cost ends with `complete` canonical accounting and strict issue/campaign totals even if Claude omitted a direct total token field.
3. A Claude Code run that emits derivable tokens but no cost ends with a canonical session artifact marked `partial` and an issue report that preserves the observed token subtotal instead of hiding it behind all-null accounting.
4. A mixed campaign with complete, partial, and unavailable issue reports keeps strict aggregate totals null when necessary while still surfacing observed subtotals from the canonical evidence that exists.
5. Existing Codex accounting behavior remains unchanged.

## Exit Criteria

1. canonical session artifacts preserve Claude token/cost facts whenever the live runner emitted them in a recognized payload shape, including deterministic `totalTokens` derivation from sufficient canonical component fields
2. issue reports distinguish strict totals from observed subtotals and explain partial accounting cleanly
3. campaign reports do the same across selected issue reports
4. focused unit, integration, and e2e coverage prove the Claude accounting path end to end
5. no tracker, workflow-config, or orchestration-policy changes are required for this slice

## Deferred To Later Issues Or PRs

1. provider-pricing estimation for sessions where the backend never emitted a cost fact
2. richer Claude log enrichment beyond canonical live accounting
3. any broader report-schema or archive-publication redesign
