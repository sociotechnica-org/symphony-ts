# Issue 264 Plan: Codex Token Usage In Reports And TUI

## Status

- plan-ready

## Goal

Make Codex token usage durable and operator-visible by ensuring real Codex runs persist enough canonical accounting to survive report generation, by making Codex log enrichment deterministic when canonical gaps remain, and by projecting the resulting accounting cleanly into the live TUI and archived issue reports.

## Scope

This slice covers:

1. tracing why Codex-backed session artifacts still reach reports as `accounting: unavailable` or `partial` in real self-hosted runs
2. tightening Codex accounting capture at the execution-to-coordination boundary so canonical session artifacts retain backend-provided token facts whenever Symphony already saw them live
3. making Codex report enrichment deterministic for same-workspace, same-window multi-session cases instead of dropping to “multiple matches, skipped” whenever another recoverable discriminator exists
4. projecting Codex token accounting into live status/TUI surfaces so factory totals, throughput, and per-ticket token cells reflect real active and completed Codex usage instead of fixture-only behavior
5. adding focused unit, integration, and end-to-end coverage for the real-world Codex multi-session reporting case and the live TUI/status projection path

## Non-goals

This slice does not include:

1. tracker transport, normalization, or lifecycle-policy changes
2. broad TUI redesign beyond token/accounting visibility
3. pricing inference when a backend did not emit explicit cost facts
4. generic multi-runner enrichment redesign beyond the Codex seam needed here
5. automated historical archive backfill tooling for old `factory-runs` publications
6. retry, continuation, lease, reconciliation, or landing-state refactors

## Current Gaps

1. Canonical session artifacts can still miss Codex token totals in real runs even though the TUI/accounting path already has partial live Codex facts, which leaves reports dependent on best-effort read-side enrichment.
2. `src/runner/codex-report-enricher.ts` currently matches Codex JSONL sessions by workspace path, optional branch, and a wide time window. In same-workspace multi-session runs this can yield several matches and forces enrichment to skip the session entirely.
3. `src/observability/issue-report.ts` correctly distinguishes canonical partial/unavailable accounting, but once canonical session coverage is incomplete the archived report still reflects those gaps and the operator cannot trust Codex totals without external log luck.
4. The live TUI still drives throughput sampling and header token totals from `snapshot.codexTotals`, while ticket rows mix live-run `codexTokenState` with fallback `runnerAccounting`. Real Codex runs can therefore leave Factory tokens, throughput, or the ticket Tokens column blank or misleading even when per-session accounting exists elsewhere in the snapshot.
5. Existing tests cover idealized Codex token fixtures and the ambiguous-match skip path, but they do not lock down a deterministic multi-session disambiguation rule or a representative self-hosted projection path that proves the TUI shows Codex tokens from real run state.

## Decision Notes

1. The system of record remains canonical session artifacts under `.var/factory/issues/...`, not the optional Codex JSONL enricher.
2. The first fix should prefer preserving live backend-provided accounting in canonical artifacts over teaching reports to recover more from read-side logs.
3. Codex log enrichment should stay additive and deterministic. If multiple local logs exist, the enricher may choose one only when explicit canonical facts make that selection inspectable and reproducible.
4. TUI token surfaces should consume the normalized runtime accounting contract rather than re-parsing Codex-specific payload details.
5. This issue fits one reviewable PR because it stays on one vertical seam: Codex accounting evidence from runner/orchestrator capture through observability projection.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that token usage surfaces must project observed accounting truthfully, prefer canonical evidence, and avoid nondeterministic enrichment guesses
  - does not belong: Codex JSONL parsing mechanics or TUI string formatting details
- Configuration Layer
  - belongs: unchanged existing workflow and observability config
  - does not belong: new workflow knobs for Codex token recovery or display mode
- Coordination Layer
  - belongs: threading normalized live accounting through active run state and snapshot projection so status/TUI surfaces can consume it reliably
  - does not belong: tracker policy changes or report-only log parsing heuristics
- Execution Layer
  - belongs: Codex-specific accounting capture and Codex log-session disambiguation rules at the runner edge
  - does not belong: issue-report markdown policy or tracker mutation
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: Codex accounting capture, enrichment, or TUI token rendering
- Observability Layer
  - belongs: canonical artifact persistence checks, issue-report aggregation, TUI/status token projection, and regression coverage
  - does not belong: raw backend payload traversal once execution/coordinator normalization has produced stable accounting facts

## Architecture Boundaries

### Execution Layer

Belongs here:

1. Codex-specific normalization of backend token facts into the existing runner accounting contract
2. Codex JSONL enrichment matching/disambiguation rules
3. preserving any discriminators needed to choose the right Codex log deterministically when canonical accounting is incomplete

Does not belong here:

1. TUI formatting
2. report explanation text
3. tracker lifecycle policy

### Coordination Layer

Belongs here:

1. active-run accounting state and token-total projection for the TUI/status snapshot
2. ensuring canonical session snapshots inherit the best normalized accounting facts Symphony observed during the run
3. exposing one stable token-visibility contract to observability consumers

Does not belong here:

1. raw Codex JSONL parsing
2. tracker-specific compensation logic
3. markdown/report wording

### Observability Layer

Belongs here:

1. issue-report aggregation from canonical session accounting, plus additive Codex enrichment only when canonical evidence is incomplete
2. TUI header/throughput/ticket rendering from normalized snapshot facts
3. targeted tests and fixtures for multi-session Codex runs and token-visibility regressions

Does not belong here:

1. new runner transport behavior
2. tracker state transitions
3. speculative token estimation

### Tracker / Config / Workspace Layers

- remain unchanged except for minimal fixture plumbing required by tests
- must not gain Codex token-accounting policy or report-enrichment logic

## Layering Notes

- `src/runner/`
  - owns Codex log parsing and deterministic match rules
  - does not own report aggregation or TUI presentation
- `src/orchestrator/`
  - owns normalized live accounting state and snapshot projection
  - does not become a second Codex-log parser
- `src/observability/`
  - owns report/TUI presentation and canonical-artifact consumption
  - does not guess among ambiguous Codex logs without an execution-layer rule

## Slice Strategy And PR Seam

One PR, one seam:

1. close the Codex accounting evidence gap at the runner/orchestrator boundary
2. make Codex enrichment deterministic only for the residual canonical-gap cases that still need local log recovery
3. update the TUI/report surfaces and tests to consume that stabilized accounting path

Why this seam is reviewable:

1. it does not combine tracker work, retry-state redesign, or workflow/config changes
2. it keeps Codex-specific parsing at the execution edge and TUI/report wording in observability
3. it limits the PR to one user-visible problem family: missing Codex token visibility

## Runtime State Model

This issue does not change retries, continuations, leases, reconciliation, or handoff-state transitions.

It does require an explicit token-evidence model for Codex sessions across live runtime and reporting:

1. `canonical`
   - the run produced normalized accounting that was persisted into the canonical session artifact
2. `enriched`
   - the canonical session artifact remained incomplete, but one deterministic Codex log match supplied additive token/session detail during report generation
3. `unavailable`
   - neither canonical accounting nor deterministic enrichment could supply token totals

Allowed transitions for one session/report view:

1. start as `canonical` when live runner accounting is sufficient and persisted
2. remain `canonical` regardless of whether optional enrichment is later available
3. start as `unavailable` when canonical accounting is absent
4. move from `unavailable` to `enriched` only when exactly one deterministic enrichment match is derivable under the execution-layer rule
5. never move from `canonical` to `enriched` as a replacement source of truth

For live TUI rows, the existing `pending -> observed` Codex token-state model remains, but the snapshot must also expose the normalized accounting totals that back header totals and throughput.

## Failure-Class Matrix

| Observed condition | Local facts available | Canonical / normalized facts available | Expected decision |
| --- | --- | --- | --- |
| Live Codex run emits token-bearing updates but final session artifact still lacks totals | active run state, runner updates, session snapshot write path | normalized accounting seen during run | persist canonical accounting from live facts; do not require report-time enrichment |
| Codex report generation sees one canonical-gap session and exactly one matching JSONL session | session workspace/branch/time facts, one parsed match | canonical accounting incomplete | enrich deterministically from that one log and mark the session/report notes accordingly |
| Codex report generation sees multiple same-workspace logs in the time window but one additional canonical discriminator isolates a single match | workspace/branch/time plus extra canonical fact such as backend session identity, exact branch, or other persisted session metadata | canonical accounting incomplete | apply the documented deterministic disambiguation rule and enrich from the unique surviving match |
| Codex report generation still has multiple indistinguishable matches after all deterministic filters | several parsed matches, no unique discriminator | canonical accounting incomplete | leave the session partial/unavailable, add an explicit note, and do not guess |
| TUI snapshot has live `runnerAccounting` totals for Codex but `codexTotals` / throughput sampling remain zero | running entries, snapshot projection, live token deltas | normalized accounting observed | drive header totals, throughput, and ticket Tokens from the stabilized runtime accounting projection so live surfaces reflect the observed totals |
| Session never emitted token-bearing facts and no deterministic log match exists | session artifact, optional local logs | no token totals | keep report/TUI wording explicit about unavailable accounting; do not fabricate totals |

## Storage / Persistence Contract

This issue keeps the canonical storage contract rooted in `IssueArtifactSessionSnapshot.accounting`.

Contract rules:

1. Codex runs must persist normalized accounting into canonical session artifacts whenever Symphony observed token facts live.
2. Canonical session snapshots remain provider-neutral; no Codex-only sibling accounting field is added.
3. If deterministic enrichment supplies token totals for a report, that remains additive report evidence and must not silently overwrite the canonical artifact.
4. Any new canonical discriminator added to support deterministic Codex matching must live on the existing session snapshot contract and be test-covered.

## Observability Requirements

1. archived issue reports must clearly show whether Codex token totals came from canonical session accounting or additive enrichment
2. live TUI Factory tokens, throughput, and per-ticket Tokens must reflect real observed Codex accounting for representative self-hosted runs
3. pending live runs must still render as pending until token-bearing facts are observed
4. partial or unavailable cases must remain explicit and truthful

## Implementation Steps

1. Inspect the live Codex runner/orchestrator path that writes `IssueArtifactSessionSnapshot.accounting` and fix the seam where observed Codex accounting is currently dropped before artifact persistence.
2. If canonical sessions still need extra metadata to disambiguate Codex JSONL files deterministically, extend the session snapshot contract with the smallest stable discriminator and thread it from the execution boundary.
3. Refine `src/runner/codex-report-enricher.ts` matching so same-workspace, same-window multi-session cases can resolve deterministically when those canonical discriminators are present, while keeping the no-guess fallback when they are not.
4. Update `src/orchestrator/service.ts` and `src/observability/tui.ts` so Factory tokens, throughput sampling, and ticket Tokens consume the stabilized runtime accounting projection for live and completed Codex runs.
5. Update report generation/tests so issue reports prefer canonical Codex accounting, fall back to deterministic enrichment only when needed, and annotate the evidence source clearly.
6. Add shared fixtures/builders for representative Codex multi-session artifact/log setups rather than repeating ad hoc session-log wiring across tests.
7. Run the repo-required checks plus the TUI QA dump and a representative report-generation path.

## Tests And Acceptance Scenarios

### Unit tests

1. `tests/unit/running-entry.test.ts` or adjacent orchestrator tests
   - Codex token-bearing updates persist normalized accounting that survives into session snapshots
2. `tests/unit/issue-report-enrichment.test.ts`
   - deterministic Codex log disambiguation succeeds for a same-workspace multi-session case with one unique canonical discriminator
   - truly ambiguous multi-match cases still skip enrichment explicitly
3. `tests/unit/issue-report.test.ts`
   - issue reports use canonical Codex accounting when present and do not depend on enrichment for ordinary Codex totals
4. `tests/unit/tui.test.ts`
   - Factory tokens, throughput, and ticket Tokens reflect live/runtime Codex accounting in representative active-run snapshots

### Integration tests

1. `tests/integration/report-cli.test.ts`
   - regenerating a report from canonical Codex session artifacts yields token totals without requiring ambiguous best-effort enrichment
2. `tests/integration/report-cli.test.ts`
   - a multi-session Codex fixture with deterministic matching enriches the right session and records the expected note/evidence path

### End-to-end tests

1. extend the representative Codex-backed bootstrap or self-hosted fixture so a real run produces canonical session accounting and a TUI/status snapshot with visible token totals

### Visual QA

1. `npx tsx tests/fixtures/tui-qa-dump.ts`
   - verify Factory tokens, throughput, and the ticket Tokens column reflect the stabilized Codex accounting projection

### Acceptance scenarios

1. Regenerating the issue `#253` report no longer leaves most Codex sessions `unavailable` when Symphony already had enough live evidence or one deterministic enrichment match.
2. A self-hosted Codex run with live token-bearing updates shows non-misleading Factory tokens, throughput, and per-ticket token values in the TUI.
3. A genuinely ambiguous multi-log case remains explicit and non-guessing instead of silently choosing a likely file.

## Exit Criteria

1. Codex canonical session artifacts retain backend-provided token facts observed during real runs
2. Codex report enrichment is deterministic when a unique match can be derived and explicitly unavailable when it cannot
3. issue reports project Codex token usage from canonical facts first and annotate any additive enrichment path
4. live TUI token surfaces reflect representative Codex runtime accounting
5. targeted unit, integration, and end-to-end tests for the touched seams pass
6. `npx tsx tests/fixtures/tui-qa-dump.ts`
7. `pnpm typecheck`
8. `pnpm lint`
9. `pnpm test`

## Deferred To Later Issues Or PRs

1. automated re-publication or backfill of historical `factory-runs` report archives
2. non-Codex runner enrichment redesign
3. new pricing estimation policy for sessions without explicit backend cost facts
4. broader TUI layout redesign unrelated to token/accounting visibility
