# Issue 167 Plan: Token And Cost Accounting Projection From Runner Events

## Status

- plan-ready

## Goal

Project backend-provided token and cost facts from runner events into stable runtime and reporting contracts so operators can see what was observed during execution, while reports and status surfaces stay explicit when a backend does not provide those facts.

## Scope

- define a provider-neutral runner accounting snapshot for token and cost facts observed during a session
- normalize backend event payloads into that snapshot at the runner/orchestrator boundary without making the orchestrator depend on Codex-specific payload shapes
- persist per-session accounting into canonical local issue artifacts so reports can use runner-event observations directly
- project aggregate and per-run accounting availability into operator-facing runtime/status surfaces
- update issue and campaign reporting to use canonical runner-event accounting first and keep explicit gap reporting when accounting is partial or unavailable
- add focused unit, integration, and end-to-end coverage for observed, partial, and unavailable accounting cases

## Non-goals

- tracker transport, normalization, or policy changes
- new `WORKFLOW.md` knobs for accounting behavior or pricing configuration
- heuristic token or cost estimation when the backend did not provide those facts
- redesigning the TUI layout beyond the minimum needed to consume the new normalized accounting snapshot
- replacing optional runner-log enrichment; that remains a supplemental path for richer metadata when canonical artifacts are incomplete
- rate-limit policy, retry policy, or review-loop behavior changes

## Current Gaps

- `src/orchestrator/running-entry.ts` extracts only Codex-shaped input/output/total token deltas into mutable in-memory counters
- `src/orchestrator/state.ts` stores only one global `codexTotals` aggregate, so runtime accounting is not provider-neutral and is not attached to canonical session artifacts
- `src/observability/issue-artifacts.ts` session snapshots persist runner/session identity and log pointers but no token or cost accounting facts
- `src/observability/issue-report.ts` still treats canonical token/cost accounting as unavailable and relies on optional read-side enrichment for Codex logs
- operator-facing runtime/status surfaces can show live token totals in limited places, but they cannot distinguish “observed complete”, “observed partial”, and “backend did not provide accounting” as a stable contract

## Decision Notes

- The canonical contract for this slice should be event-derived session accounting, not provider-specific raw payload retention and not report-only enrichment.
- The narrow seam is a provider-neutral accounting snapshot owned by runner/orchestrator normalization, then persisted into canonical session artifacts and consumed by observability.
- Costs should only be recorded when the backend emitted an explicit cost fact. This issue should not infer pricing from tokens.
- Optional log enrichment remains useful for auxiliary metadata, but canonical reports should stop depending on log matching for basic token accounting when the live runner already emitted those facts.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_167/docs/architecture.md).

- Policy Layer
  - belongs: the rule that runtime and reports must distinguish observed accounting from unavailable accounting and must not fabricate missing totals
  - does not belong: provider-specific JSON parsing details or pricing heuristics
- Configuration Layer
  - belongs: unchanged existing workflow/config loading
  - does not belong: new accounting toggles, provider pricing tables, or report-only flags
- Coordination Layer
  - belongs: projecting normalized per-run accounting into runtime state and status snapshots
  - does not belong: provider payload traversal or markdown/report formatting
- Execution Layer
  - belongs: runner-side identification of backend-provided accounting facts and session-level normalized event emission
  - does not belong: tracker mutation, issue-report aggregation policy, or TUI formatting
- Integration Layer
  - belongs: untouched tracker adapters
  - does not belong: runner accounting normalization or observability presentation
- Observability Layer
  - belongs: canonical artifact persistence, status/report aggregation, explicit availability wording, and operator-facing rendering
  - does not belong: direct parsing of live backend payloads once runner/orchestrator normalization has produced the snapshot

## Architecture Boundaries

### Runner

Belongs here:

- provider-neutral `RunnerAccountingSnapshot` / event payload types shared across backends
- backend-specific parsing from raw runner updates into normalized accounting facts at the edge
- emitting accounting updates only when a backend actually provides them

Does not belong here:

- issue-report composition policy
- tracker or orchestrator retry decisions
- provider pricing inference when the backend emitted no cost data

### Orchestrator

Belongs here:

- integrating normalized accounting updates into active run state
- maintaining per-run and aggregate accounting projection for live status surfaces
- persisting accounting into canonical session snapshots/artifacts

Does not belong here:

- raw backend payload traversal after the runner edge has normalized facts
- tracker lifecycle compensation
- markdown rendering or campaign-report wording

### Observability

Belongs here:

- extending canonical session artifact and report contracts to store accounting availability and totals
- aggregating session accounting into issue- and campaign-level summaries
- rendering explicit observed/partial/unavailable accounting states in status and report surfaces

Does not belong here:

- runner protocol parsing
- second-source-of-truth reconstruction from raw logs when canonical accounting is present

### Tracker / Workspace / Config

- untouched in this slice except for any minimal fixture wiring required by tests
- must not gain accounting policy, storage, or provider-specific parsing logic

## Layering Notes

- `src/config/`
  - stays unchanged; accounting availability is derived from runner facts, not configured policy
- `src/tracker/`
  - remains out of scope; no tracker label or lifecycle behavior changes
- `src/workspace/`
  - remains out of scope beyond existing session/workspace metadata already used by artifacts
- `src/runner/`
  - owns provider-edge accounting normalization and provider-neutral event contracts
  - should not write artifacts or reports directly
- `src/orchestrator/`
  - owns active-run accounting state and artifact/status projection
  - should not keep Codex-only accounting semantics as the public runtime contract
- `src/observability/`
  - owns durable artifact/report/status schemas and operator wording
  - should not re-parse raw runner payloads to recover accounting

## Slice Strategy And PR Seam

One reviewable PR with one seam:

1. introduce a provider-neutral runner accounting projection contract
2. thread that contract through live runtime state and canonical session artifacts
3. update reports and status surfaces to consume the canonical accounting contract and report gaps explicitly

Why this stays reviewable:

- it does not combine tracker changes, retry/recovery redesign, or workspace policy
- it narrows the work to one cross-layer contract centered on runner accounting
- optional log enrichment remains in place, so the PR does not need to redesign the entire reporting pipeline

Deferred from this PR:

- provider pricing catalogs or cost estimation
- non-canonical analytics/history storage beyond current session and report artifacts
- broader TUI redesign or additional dashboard drill-downs
- richer runner-log enrichment changes not required to coexist with the new canonical accounting contract

## Runtime State Model

This issue does not change retries, continuations, reconciliation, leases, or handoff states, so no orchestration state-machine change is required.

It does require one explicit accounting-availability model shared across runtime and reports:

1. `unavailable`
   - no normalized accounting snapshot has been observed for the session
2. `partial`
   - at least one accounting fact was observed, but required totals are missing or incomplete
3. `complete`
   - the backend provided the full normalized accounting snapshot expected for that session

Aggregate runtime/report views should derive their status from session-level availability instead of assuming that numeric zero means “no usage”.

## Failure-Class Matrix

| Observed condition | Local facts available | Expected decision |
| --- | --- | --- |
| Backend emits no accounting-bearing event for a session | runner session exists, no accounting snapshot observed | persist session/report accounting as `unavailable`; do not estimate tokens or cost |
| Backend emits token totals but no cost fact | normalized token totals observed, cost absent | persist session/report accounting as `partial`; show observed tokens and explicit cost gap |
| Backend emits token and cost totals | normalized accounting snapshot observed | persist session/report accounting as `complete`; aggregate into runtime/report totals |
| Backend emits decreasing cumulative token totals | previous high-water accounting plus lower later payload | clamp deltas/high-water marks to avoid double counting; keep prior observed totals |
| Multiple accounting-bearing events arrive for one session | normalized cumulative snapshots over time | update session high-water marks and aggregate totals deterministically |
| Canonical session artifact has accounting, optional log enrichment disagrees or is missing | canonical artifact plus optional enrichment inputs | canonical runner-event accounting remains the source of truth; enrichment may add metadata notes only |

## Storage / Persistence Contract

This issue extends the canonical local artifact contract.

Contract rules:

1. per-session accounting must be stored on canonical session snapshots under `.var/factory/issues/...`
2. stored accounting must be provider-neutral and nullable, with explicit availability/status fields rather than magic numbers
3. session artifacts remain the canonical source for report generation; report enrichment becomes additive, not foundational, for runner-event accounting
4. generated reports and campaign digests may aggregate only from canonical session accounting plus optional additive metadata
5. if the artifact/report schema version changes, stored-report compatibility handling must remain explicit and test-covered

## Observability Requirements

- live status surfaces must show aggregate accounting derived from normalized session facts, including explicit pending/unavailable gaps
- per-issue reports must explain whether token/cost totals came from canonical runner events and whether any fields remain unavailable
- campaign digests must preserve the distinction between complete, partial, estimated, and unavailable accounting after canonical projection lands
- when a backend provides no accounting data, the operator-facing wording must say that clearly instead of implying a zero total

## Implementation Steps

1. Introduce provider-neutral accounting types near the runner contract, including per-session availability and nullable token/cost fields.
2. Refactor raw accounting extraction out of `src/orchestrator/running-entry.ts` into a normalization seam that can consume backend payloads and update per-session accounting state without exposing Codex-specific shapes downstream.
3. Extend active run state and status snapshot projection to carry normalized per-run and aggregate accounting totals/availability.
4. Extend `IssueArtifactSessionSnapshot` and artifact-writing paths so canonical session snapshots persist observed accounting facts.
5. Update issue-report generation to build token/cost sections from canonical session accounting first, with optional enrichers limited to supplemental metadata or backfill only when canonical accounting is missing.
6. Update campaign-report aggregation and any touched status/TUI helpers to consume the new canonical availability model.
7. Add focused test builders/fixtures for runner-event accounting snapshots so unit, integration, and e2e coverage do not duplicate ad hoc setup.
8. Update README or observability docs where needed to describe canonical runner-event accounting and explicit gap semantics.

## Tests And Acceptance Scenarios

### Unit

- `tests/unit/running-entry.test.ts`
  - token-only event yields `partial` accounting with observed token totals and missing cost
  - token-plus-cost event yields `complete` accounting
  - decreasing cumulative totals do not double count
- `tests/unit/issue-artifacts.test.ts`
  - canonical session snapshots persist normalized accounting fields
- `tests/unit/issue-report.test.ts`
  - report token usage becomes complete/partial from canonical session accounting without requiring enrichment
  - explicit unavailable wording remains when canonical sessions provide no accounting
- `tests/unit/campaign-report.test.ts`
  - campaign aggregation uses canonical session accounting and preserves partial/unavailable counts
- `tests/unit/status.test.ts` and/or `tests/unit/tui.test.ts`
  - live status surfaces distinguish pending/unavailable from observed zero/complete totals

### Integration

- `tests/integration/report-cli.test.ts`
  - `symphony-report issue` emits canonical token usage from stored session accounting without any enricher
  - optional Codex enrichment still coexists without replacing canonical totals

### End-to-End

- extend a realistic runner-driven fixture or e2e scenario so a backend emitting accounting-bearing events produces canonical session artifacts and an issue report with the expected availability state

## Acceptance Scenarios

1. A backend emits token totals but no cost information during a run.
   - Expected: runtime and reports show observed token totals, mark cost unavailable, and classify accounting as partial.
2. A backend emits both token and cost facts during a run.
   - Expected: canonical session artifacts, live status surfaces, and reports all project complete accounting consistently.
3. A backend emits no accounting facts.
   - Expected: status and reports say accounting is unavailable rather than showing an implied zero.
4. Optional Codex log enrichment is present alongside canonical runner-event accounting.
   - Expected: canonical totals remain authoritative while enrichment adds only supplemental metadata or fills gaps explicitly allowed by policy.

## Exit Criteria

- provider-neutral runner accounting is normalized into a stable runtime contract
- canonical session artifacts persist observed accounting facts and explicit availability state
- issue and campaign reports consume canonical accounting instead of defaulting to unavailable when runner events already provided the facts
- operator-facing runtime surfaces no longer blur unavailable accounting with zero totals
- local typecheck, lint, unit/integration/e2e tests for touched seams pass

## Deferred To Later Issues Or PRs

- provider-specific pricing/estimation policy when backends provide only tokens
- additional runner adapters beyond the minimal contract changes needed here
- archival analytics beyond existing session/report artifacts
- deeper dashboard/report UX work beyond the canonical accounting projection seam
