# Issue 289 Plan: Apply Provider Pricing So Issue Reports Can Estimate Cost For Complete Token Runs

## Status

- plan-ready

## Goal

Make generated issue reports turn complete provider-backed token totals into inspectable estimated USD cost totals when Symphony did not observe an explicit backend cost fact, so after-action reporting stops leaving obviously priceable runs at `Estimated cost (USD): Unavailable`.

The intended outcome of this slice is:

1. reports keep canonical backend cost facts as the source of truth when they exist
2. reports can estimate cost for supported provider/model combinations when the session token facts are complete enough for deterministic pricing
3. report JSON/markdown use the existing `estimated` token-usage status instead of collapsing those sessions back to `partial`
4. the change stays on one reviewable seam: observability-layer pricing projection during report generation

## Scope

This slice covers:

1. a checked-in provider-pricing catalog for the supported report-estimation path
2. deterministic report-time cost estimation for sessions that already have complete enough token facts but no explicit backend `costUsd`
3. issue-report aggregation and markdown updates so session, attempt, agent, and issue totals surface those estimated costs clearly
4. keeping campaign digests coherent when they consume stored issue reports that now carry estimated cost totals
5. focused unit and integration coverage for supported, unsupported, and mixed observed-vs-estimated cost cases

## Non-goals

This slice does not include:

1. tracker transport, normalization, or lifecycle-policy changes
2. runner-side pricing inference or canonical artifact schema changes for pricing
3. new `WORKFLOW.md` or CLI knobs for pricing configuration
4. speculative estimation for providers/models whose billing dimensions cannot be derived from stored report-session token facts
5. TUI/live-status cost projection changes
6. historical backfill or archive republishing outside normal report regeneration

## Current Gaps

Today the reporting path stops short of estimation even when token evidence is sufficient:

1. `src/observability/issue-report-enrichment.ts` explicitly states that estimated cost remains unavailable because report generation does not apply provider pricing
2. `src/observability/issue-report.ts` already models `estimated` token-usage status, but no current path upgrades a session or report into that state from provider pricing
3. recent self-hosted issue reports can preserve complete enough Codex/OpenAI token totals to show large aggregate token counts, yet still render `Estimated cost (USD): Unavailable`
4. campaign digests inherit the same gap because they aggregate the stored per-issue report token surface
5. the current default report pipeline has no dedicated observability seam for pricing policy; optional Codex log enrichment and report pricing would be mixed if added ad hoc

## Decision Notes

1. Keep pricing estimation in the observability/report layer. Canonical artifacts should remain a record of what the backend actually emitted, not a store of inferred billing.
2. Reuse the existing report status vocabulary:
   - `complete` for explicit backend cost facts
   - `estimated` for deterministic provider-pricing estimates
   - `partial` / `unavailable` when the needed billing inputs are missing
3. Apply pricing after optional token enrichers run, so Codex-enriched token detail can participate in estimation without making the enricher itself responsible for billing policy.
4. Keep the first slice narrow: support only provider/model combinations whose billing dimensions are derivable from the stored report session facts. Unsupported providers or models should remain explicit rather than guessed.
5. Preserve reviewable layering by adding a dedicated report-pricing module instead of embedding pricing tables or model matching inside `codex-report-enricher.ts`.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule that explicit backend cost facts win, deterministic provider pricing may fill only supported reporting gaps, and unsupported pricing cases stay explicit
  - does not belong: model-string parsing details or markdown rendering
- Configuration Layer
  - belongs: unchanged existing workflow/config loading; pricing support is a checked-in code policy, not a workflow toggle
  - does not belong: per-workflow pricing tables, overrides, or hidden estimation flags
- Coordination Layer
  - belongs: unchanged; no retries, reconciliation, or terminal-follow-through behavior changes
  - does not belong: report pricing logic or provider price catalogs
- Execution Layer
  - belongs: unchanged existing runner accounting and optional Codex token enrichment inputs
  - does not belong: billing estimation policy or report status promotion to `estimated`
- Integration Layer
  - belongs: untouched tracker adapters
  - does not belong: provider-pricing inference during report generation
- Observability Layer
  - belongs: provider-pricing catalog, report-time estimation, issue/campaign report aggregation, and explanatory output
  - does not belong: tracker lifecycle policy, runner event parsing beyond existing normalized report session facts, or live status behavior

## Architecture Boundaries

### `src/observability/`

Owns:

1. the provider-pricing catalog and model-matching rules used only for report generation
2. deterministic estimation from already-built `IssueReportTokenUsageSession` facts
3. rebuilding report-level token-usage status/explanation/notes after pricing is applied
4. markdown wording that distinguishes observed and estimated cost cleanly

Does not own:

1. raw runner payload parsing
2. tracker mutation or lifecycle transitions
3. canonical issue-artifact persistence of inferred prices

### `src/runner/`

Owns:

1. existing token/accounting normalization and optional Codex JSONL enrichment
2. preserving token facts such as cached-input detail when available

Does not own:

1. pricing tables
2. billing model selection
3. issue-report status promotion from `partial` to `estimated`

### `src/cli/report.ts` and `src/observability/terminal-reporting.ts`

Own:

1. continuing to invoke the standard issue-report generation path

Do not own:

1. pricing logic or provider/model branching

## Layering Notes

- `config/workflow`
  - unchanged; pricing support is repo-owned behavior, not workflow-owned contract
- `tracker`
  - unchanged; reports must not re-fetch or infer pricing from tracker data
- `workspace`
  - unchanged
- `runner`
  - continues to provide normalized token facts and optional enrichment detail
  - should not start writing estimated cost into canonical session accounting
- `orchestrator`
  - unchanged
  - should not grow report-only pricing policy
- `observability`
  - owns the report-time pricing projection and any additive explanation text
  - should not mutate canonical artifacts while estimating cost

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one observability seam:

1. add a dedicated report-pricing helper/catalog in `src/observability/`
2. apply it after optional report enrichers and before markdown rendering
3. update issue and campaign report aggregation/tests to reflect `estimated` cost totals

This PR deliberately defers:

1. runner-side or artifact-side persistence of inferred pricing
2. live TUI/status cost estimation
3. broader multi-provider rollout beyond the provider/model combinations the stored token facts can support deterministically
4. any report archive backfill automation

Why this seam is reviewable:

1. it does not mix tracker work, runner-contract changes, or orchestrator state changes
2. it keeps provider pricing policy in one observability-owned module
3. it reuses the existing report status surface instead of inventing a second report pipeline

## Report Cost-State Model

This issue does not change retries, continuations, leases, reconciliation, or handoff states, so no orchestration state machine change is required.

It does require one explicit report-time cost-state model for each session:

1. `observed`
   - the session already has an explicit backend-provided `costUsd`
2. `estimated`
   - the session lacks explicit `costUsd`, but the provider/model pricing rule is supported and the stored token breakdown is sufficient to derive a deterministic estimate
3. `unavailable`
   - the session lacks explicit `costUsd` and report generation cannot deterministically price it

Allowed report-generation transitions for one session:

1. canonical session starts as `observed` when `costUsd` was stored
2. canonical session may move from `unavailable` to `estimated` only during report generation and only from already-stored token facts
3. canonical session never downgrades `observed` to `estimated`
4. canonical session remains `unavailable` when provider, model, or token dimensions are unsupported or inconsistent

Issue-level/report-level status rules:

1. `complete`
   - all sessions have explicit observed cost facts
2. `estimated`
   - all sessions have total token coverage, and at least one required cost was supplied through deterministic pricing rather than explicit backend cost
3. `partial`
   - at least one session still lacks deterministic total-token or cost coverage after pricing
4. `unavailable`
   - all sessions remain unavailable

## Failure-Class Matrix

| Observed condition                                                                                  | Stored local facts available                                                           | Expected decision                                                                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Session already has explicit backend `costUsd`                                                      | session `costUsd`, token totals                                                        | preserve observed cost exactly; do not re-estimate                                                                     |
| Supported provider/model has input, output, and total token facts but missing `costUsd`            | provider/model, `inputTokens`, `outputTokens`, `totalTokens`, optional cached detail   | estimate cost deterministically from the pricing catalog and mark the session/report `estimated`                       |
| Supported provider/model is missing a required billing dimension                                    | provider/model, incomplete token detail                                                | keep cost unavailable and add an explicit note; do not guess                                                           |
| Provider/model is not in the checked-in pricing catalog                                             | provider/model, otherwise complete token totals                                        | keep cost unavailable and note that pricing support is unavailable for that provider/model                             |
| Token facts are internally inconsistent for the pricing rule                                        | provider/model plus token fields whose arithmetic cannot produce a valid billing split  | keep cost unavailable and note the inconsistency instead of fabricating a price                                        |
| Report mixes observed-cost sessions and estimated-cost sessions, with no remaining cost gaps        | mixed session cost sources, all sessions token-complete                                | aggregate cost totals, mark the report `estimated`, and explain how many sessions were observed vs provider-estimated  |
| Report still contains partial/unavailable token sessions after pricing                              | mixed complete and incomplete session token coverage                                   | preserve `partial` status and explicit notes; estimated cost must not hide missing token coverage                      |

## Storage / Persistence Contract

The canonical local issue artifacts remain the system of record and stay unchanged in this slice.

Contract rules:

1. `IssueArtifactSessionSnapshot.accounting.costUsd` continues to mean only explicit backend-observed cost
2. inferred provider-pricing estimates live only in generated issue reports and campaign digests derived from them
3. report generation may update existing report `status`, `costUsd`, `observedCostSubtotal`, and notes/explanations, but it must not rewrite canonical issue artifacts
4. if the implementation can stay within the current report schema by reusing `status: estimated`, do that; only bump the report schema if a new additive report field is required by the final implementation

## Observability Requirements

1. issue reports must clearly distinguish explicit backend cost from provider-estimated cost in explanation/notes even when both render under `Estimated cost (USD)`
2. session lines in `report.md` should show `status estimated` when provider pricing filled the cost gap
3. aggregate issue totals should sum estimated session costs when all sessions are priceable, while still preserving observed-cost subtotals when only some sessions were observed
4. campaign digests should inherit the same `estimated` posture from stored issue reports rather than reverting to unavailable cost

## Implementation Steps

1. Add a focused observability module for provider-pricing support:
   - checked-in pricing catalog
   - model normalization/matching helpers
   - deterministic cost estimation from report-session token facts
2. Update issue-report generation so pricing runs after optional enrichers and before markdown rendering.
3. Refactor report token-usage rebuilding so it can recompute session, attempt, agent, and issue cost totals/statuses after pricing fills previously missing session costs.
4. Update explanation and note generation so mixed observed/estimated/unavailable cost coverage is explicit and high-signal.
5. Confirm campaign-report aggregation/markdown correctly preserve the new `estimated` issue-report posture, and add targeted changes only if the existing aggregation is insufficient.
6. Add focused fixtures/builders for supported provider-pricing scenarios rather than repeating ad hoc token/pricing setup across tests.
7. Update minimal docs if report semantics need a short README note.

## Tests And Acceptance Scenarios

### Unit tests

1. `tests/unit/issue-report.test.ts`
   - supported provider/model with complete token facts and missing `costUsd` produces `status: estimated` and a deterministic aggregate issue cost
   - mixed observed and estimated sessions keep aggregate totals and explanation text correct
   - unsupported provider/model or incomplete billing dimensions remain explicit and non-guessing
2. `tests/unit/issue-report-enrichment.test.ts`
   - Codex-enriched cached-input detail can participate in pricing after enrichment without the enricher owning billing policy
3. `tests/unit/campaign-report.test.ts`
   - campaign aggregation preserves estimated issue-report cost totals/status counts

### Integration tests

1. `tests/integration/report-cli.test.ts`
   - regenerated report markdown/json shows estimated cost for a supported complete-token run
   - regenerated report keeps explicit `Unavailable` cost for an unsupported or insufficient-token case

### Acceptance scenarios

1. A self-hosted Codex/OpenAI issue report has complete enough stored token facts, no explicit backend cost, and report generation now renders a deterministic estimated USD total instead of `Unavailable`.
2. A mixed issue with one observed-cost session and one provider-estimated session renders an aggregate cost total and marks the report `estimated`, not `complete`.
3. A report whose provider/model token facts are still insufficient for pricing stays explicit about why cost remains unavailable.

## Exit Criteria

1. supported complete-token issue reports no longer leave estimated cost unavailable when pricing can be derived deterministically from stored report-session facts
2. explicit backend cost facts remain authoritative and are never overwritten by pricing
3. issue and campaign reports use the existing `estimated` status meaningfully for provider-priced runs
4. unsupported or insufficient-token pricing cases remain explicit and non-guessing
5. local validation passes:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`

## Deferred To Later Issues Or PRs

1. expanding provider-pricing support to additional providers/models whose billing dimensions are not yet represented cleanly in stored report-session facts
2. live TUI/status cost estimation
3. canonical artifact persistence of inferred pricing
4. automated backfill/republication of previously generated historical reports
