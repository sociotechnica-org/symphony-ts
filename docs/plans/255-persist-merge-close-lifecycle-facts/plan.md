# Issue 255 Plan: Persist Merge And Close Lifecycle Facts Into Canonical Issue Artifacts And Reports

## Status

- plan-ready

## Goal

Persist merge timing and exact issue-close timing into the canonical local issue-artifact contract so per-issue reports and campaign digests can describe the full delivery loop from local facts instead of fallback notes.

The intended outcome of this slice is:

1. successful GitHub-backed runs record when the PR merged and when the issue closed in canonical issue artifacts
2. issue reports render concrete `mergedAt` and `closedAt` values when those facts were observed
3. campaign digests stop flagging those fields as unavailable for reports backed by the new artifact facts
4. the implementation stays on one reviewable seam: additive lifecycle-fact persistence plus report consumption

## Scope

This slice covers:

1. additive canonical issue-artifact schema changes for merge and issue-close lifecycle facts
2. GitHub tracker/client normalization needed to surface exact issue close timing and merged PR timing to the runtime boundary
3. orchestrator persistence wiring so terminal success stores those normalized lifecycle facts locally
4. issue-report and campaign-report updates to read the canonical lifecycle facts instead of hardcoded unavailable notes
5. unit and integration coverage for the new artifact contract and report rendering behavior

## Non-Goals

This slice does not include:

1. reconstructing full issue state-transition history or label-transition history
2. changing plan-review, review-loop, guarded-landing, retry, or reconciliation policy
3. re-fetching GitHub during report generation
4. changing tracker semantics for non-GitHub backends beyond preserving compatibility with the additive artifact shape
5. broader report redesign unrelated to merge/close lifecycle facts

## Current Gaps

Today the needed facts are not preserved end-to-end:

1. `src/observability/issue-report.ts` hardcodes merge and close timing as unavailable even though it already models those fields in the report shape
2. `src/observability/campaign-report.ts` can only aggregate `mergedAt` and `closedAt` when issue reports already contain them, so the digest currently reports availability gaps rather than real timing
3. `src/observability/issue-artifacts.ts` does not provide a typed canonical home for merged-at and closed-at facts
4. `src/tracker/github-client.ts` normalizes merged PR timing for handoff detection, but `RuntimeIssue` and the terminal artifact path do not currently preserve exact issue close timing
5. terminal success persistence in `src/orchestrator/service.ts` records a `succeeded` event and attempt snapshot, but not the terminal merge/close lifecycle facts reports need later

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that canonical local artifacts should preserve delivery facts needed for later reporting when the runtime already observed them
2. the rule that reports consume canonical persisted facts rather than making post-hoc remote GitHub guesses
3. the rule that this slice is additive and should not widen into full tracker-history reconstruction

Does not belong here:

1. raw GitHub REST field names
2. artifact file-write mechanics
3. markdown-only fallback wording without a durable storage contract

### Configuration Layer

Belongs here:

1. no workflow or frontmatter changes are required for this slice
2. existing instance/report path resolution remains unchanged

Does not belong here:

1. config switches for whether merge or close facts are persisted
2. report-format knobs for lifecycle fact rendering

### Coordination Layer

Belongs here:

1. terminal-success persistence wiring that attaches normalized lifecycle facts to canonical observations at the point the runtime closes the issue
2. keeping the terminal observation path explicit instead of hiding GitHub fact lookups inside report generation

Does not belong here:

1. tracker transport parsing
2. report aggregation logic
3. retry or handoff-state changes unrelated to terminal fact persistence

### Execution Layer

Belongs here:

1. untouched for this issue

Does not belong here:

1. runner or workspace changes to satisfy reporting

### Integration Layer

Belongs here:

1. GitHub client normalization for exact issue-close timing and merged PR timing
2. tracker-facing normalized lifecycle-fact shape passed into the coordinator without leaking raw transport payloads

Does not belong here:

1. issue-report rendering
2. orchestrator terminal policy
3. canonical artifact file layout decisions

### Observability Layer

Belongs here:

1. additive canonical artifact schema for merge/close lifecycle facts
2. report derivation that reads those facts from stored issue artifacts
3. tests that lock in the canonical persistence and reporting contract

Does not belong here:

1. live GitHub API calls during report generation
2. tracker mutation logic
3. hidden inference beyond the stored local facts

## Architecture Boundaries

### `src/tracker/github-client.ts`

Owns:

1. parsing GitHub issue close timestamps from transport responses
2. continuing to normalize merged PR timing for closed pull requests
3. exposing a narrow normalized shape for the tracker layer to use

Does not own:

1. canonical artifact persistence
2. report rendering
3. orchestrator success/failure policy

### `src/tracker/github.ts`

Owns:

1. keeping GitHub-specific lifecycle fact collection at the tracker edge
2. supplying the terminal-success path with the merged PR / issue-close facts it can observe after completion

Does not own:

1. artifact writes
2. report markdown wording
3. cross-backend report fallback policy

### `src/orchestrator/service.ts`

Owns:

1. requesting the terminal lifecycle facts after tracker completion succeeds
2. attaching those normalized facts to the terminal issue-artifact observation in one explicit seam
3. keeping the success path order inspectable: complete issue, observe final tracker facts, persist canonical artifact, run terminal reporting

Does not own:

1. raw GitHub REST parsing
2. report aggregation internals
3. tracker-specific heuristics beyond calling the tracker boundary

### `src/observability/issue-artifacts.ts`

Owns:

1. the additive canonical schema for terminal merge and close facts
2. durable read/write helpers and backward-compatible loading for older artifacts without those fields

Does not own:

1. live tracker fetches
2. report markdown
3. terminal policy decisions about when facts are available

### `src/observability/issue-report.ts` and `src/observability/campaign-report.ts`

Own:

1. consuming the canonical lifecycle facts from stored artifacts
2. rendering concrete merge/close values and accurate availability notes

Do not own:

1. backfilling facts from GitHub
2. tracker transport knowledge
3. artifact persistence

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one end-to-end lifecycle-fact seam:

1. add a narrow canonical storage contract for `mergedAt` and `closedAt`
2. normalize those facts at the GitHub tracker boundary
3. persist them during terminal success observation
4. update report readers and tests to consume the stored facts

This PR deliberately defers:

1. full issue state-transition history in canonical artifacts
2. label-transition artifacts
3. richer merge identity such as merge commit metadata unless a tiny additive field is required by the final implementation
4. report backfills for older artifact directories that never observed the facts

Why this seam is reviewable:

1. it is additive to the existing artifact contract
2. it keeps transport parsing, persistence, and report reading in separate layers
3. it avoids mixing landing-policy changes, report redesign, and broader tracker-history work

## Storage And Persistence Contract

This issue changes durable state, so the storage contract must be explicit.

### Canonical issue summary

Add additive terminal lifecycle fields to the canonical issue summary document:

1. `mergedAt: string | null`
2. `closedAt: string | null`

These fields should mean:

1. `mergedAt`
   - the exact PR merge timestamp observed from the tracker for the issue branch's landed pull request
2. `closedAt`
   - the exact issue-close timestamp observed from the tracker after terminal success closes the issue

### Canonical event details

Keep the event stream additive and inspectable by including the same lifecycle facts on the terminal success event details when available so the raw event ledger explains why the summary fields changed.

### Backward compatibility

1. older artifact summaries without these fields must still load as `null`
2. reports must continue to render partial/unavailable notes for old artifacts that predate the schema addition
3. schema evolution remains additive rather than replacing existing attempt or event structures

## Runtime Fact Flow

This issue does not change retries, continuations, or reconciliation, so a new orchestration state machine is not required.

The required terminal-success fact flow is:

1. the orchestrator completes the issue through the tracker
2. the GitHub tracker reads the freshly closed issue and latest merged pull-request facts for the branch
3. the orchestrator persists those normalized facts into the canonical issue summary and terminal success event
4. terminal reporting consumes the stored local facts without making additional network calls

## Failure-Class Matrix

Because this slice depends on tracker-observed terminal facts, the plan should make degraded cases explicit.

| Observed condition                                                            | Local facts available                            | Normalized tracker facts available       | Expected decision                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR merged and issue closed successfully                                       | terminal success path, branch name, issue number | `mergedAt` and `closedAt` available      | persist both facts; reports render concrete merge/close timing                                                                                        |
| PR merged successfully but closed issue fetch does not yield exact `closedAt` | terminal success path, branch name, issue number | `mergedAt` available, `closedAt` missing | persist `mergedAt`, leave `closedAt` null, keep close note partial                                                                                    |
| Issue closed successfully but no merged PR is found for the branch            | terminal success path, branch name, issue number | `closedAt` available, `mergedAt` missing | persist `closedAt`, leave `mergedAt` null, keep merge note partial                                                                                    |
| Tracker completion succeeds but follow-up lifecycle fact fetch fails          | terminal success path only                       | no terminal lifecycle facts              | preserve terminal success artifact/report flow, store null facts, and surface the persistence gap in logs/tests rather than failing report generation |
| Older artifact directory predates this schema                                 | summary/events/attempts only                     | none                                     | load compatibly and keep existing unavailable notes                                                                                                   |

## Observability Requirements

1. canonical raw issue artifacts remain the sole source for issue-report merge/close timing
2. issue reports explicitly distinguish complete versus partial lifecycle fact availability
3. campaign digests summarize availability based on stored issue-report facts without new tracker dependencies
4. the raw success event and canonical issue summary remain sufficient to audit why a report claims a given merge/close timestamp

## Implementation Steps

1. extend the canonical issue-artifact summary and read/write helpers with additive `mergedAt` and `closedAt` fields plus compatibility defaults
2. extend the GitHub client/runtime normalization to capture `closed_at` for issues and keep merged PR timing available through a narrow tracker-owned helper
3. add a focused tracker/coordinator seam that obtains final terminal lifecycle facts after `completeIssue()` and before artifact persistence/report generation
4. include those lifecycle facts in the success observation summary/event details without mixing raw transport payloads into observability code
5. update issue-report derivation to read stored `mergedAt` and `closedAt`, replacing the current hardcoded unavailable notes with fact-aware notes/status
6. update campaign digest aggregation and notes so availability reflects the new stored values
7. add or extend fixture helpers and tests for artifact persistence, issue-report rendering, and campaign digest availability
8. run the relevant local checks and inspect representative generated report output

## Tests And Acceptance Scenarios

### Unit

1. issue-artifact summary read/write preserves additive `mergedAt` and `closedAt` values
2. issue-artifact readers default missing `mergedAt` and `closedAt` to `null` for older summaries
3. issue-report generation renders concrete merge/close timestamps when the canonical summary contains them
4. issue-report generation keeps partial notes when only one of the two facts is available
5. campaign digest availability notes report full coverage once all selected reports contain merge/close timing

### Integration

1. terminal reporting over seeded successful artifacts containing canonical merge/close facts writes reports that include the concrete timestamps
2. GitHub-backed integration coverage proves the terminal success path persists exact issue close timing and merged PR timing into canonical artifacts after completion

### Acceptance Scenarios

1. a successful GitHub issue with a merged PR produces canonical issue artifacts where both `mergedAt` and `closedAt` are non-null and the issue report markdown prints both values
2. a campaign digest built from representative successful reports no longer says merge/close timing is unavailable when those reports observed the facts
3. an older artifact directory generated before this slice still loads and produces a partial report rather than failing

## Exit Criteria

This issue is complete when:

1. canonical issue artifacts persist additive merge/close lifecycle facts for successful GitHub runs
2. issue reports consume those facts and stop rendering unconditional unavailable placeholders
3. campaign digests reflect the new availability accurately
4. local unit, integration, and repo-required checks pass
5. the implementation remains within one PR that preserves tracker transport, normalization, persistence, and report-reading boundaries

## Deferred To Later Issues Or PRs

1. exact issue state-transition history and label-transition ledgers
2. merge-commit identity or richer release metadata if campaign analysis needs it later
3. backfill tooling to enrich already-generated historical artifact directories
4. parity work for non-GitHub tracker backends if they later expose equivalent terminal lifecycle facts

## Decision Notes

1. Persist lifecycle facts on the canonical issue summary instead of only on derived reports so later report generators and campaign digests can share one source of truth.
2. Keep GitHub-specific fact discovery at the tracker boundary; report generation should remain offline and artifact-driven.
3. Treat the slice as additive storage plus read-side consumption, not as a broader tracker-history project, to keep the PR reviewable.
