# Issue 249 Plan: Persist Operator Interventions Beyond Plan Approval Into Canonical Artifacts And Reports

## Status

- plan-ready

## Goal

Preserve meaningful per-issue operator actions as canonical local artifacts so generated issue and campaign reports can describe what the operator actually did during a run, not only whether plan review was explicitly approved or waived.

The intended outcome of this slice is:

1. canonical issue artifacts gain an additive operator-intervention event seam instead of treating operator action as a plan-review-only special case
2. at least one non-plan operator action path is recorded in canonical local artifacts and surfaced in generated reports
3. campaign digests can summarize intervention-heavy runs with better fidelity than the current plan-review-only count
4. legacy artifact directories remain readable and continue to degrade gracefully

## Scope

This slice covers:

1. defining a small additive canonical operator-intervention event taxonomy for per-issue artifacts
2. extending the artifact-writing seam so repo-owned non-orchestrator commands can append canonical per-issue intervention events safely
3. preserving tracker-derived `/land` observations as canonical operator-intervention evidence instead of collapsing them to a boolean-only landing posture
4. recording report-review/report-publication follow-up actions that already run through repo-owned CLI paths and carry an explicit `--issue`
5. updating issue-report and campaign-report derivation so they summarize the broader intervention set
6. focused regression coverage for at least one tracker-derived non-plan intervention and one repo-owned CLI intervention

## Non-Goals

This slice does not include:

1. full archival of raw GitHub comments, operator chats, or shell transcripts
2. changing plan-review semantics, acknowledgement policy, or tracker approval rules
3. instrumenting every possible instance-wide operator action, especially actions without a clean per-issue anchor yet, such as detached factory restarts or global ready-queue reprioritization
4. redesigning orchestrator retry, reconciliation, handoff, or landing state machines
5. introducing a second reporting pipeline or live GitHub re-scrape for completed issue reports
6. broad tracker transport refactors outside the narrow landing-command metadata seam

## Current Gaps

Today the canonical reporting path understates manual intervention:

1. `src/observability/issue-report.ts` derives `operatorInterventions` only from `approved` and `waived` event kinds
2. canonical issue artifacts have no general per-issue operator-intervention append seam for repo-owned CLI commands such as report review, follow-up issue filing, or publication
3. GitHub tracker normalization collapses `/land` to `hasLandingCommand: boolean`, so reports cannot show when or how the operator initiated landing
4. campaign digests count only explicit plan-review handoff events, which misses materially intervention-heavy runs that required landing, report review, or report-driven follow-up work
5. some operator actions named in the issue, such as restarts or queue changes, do not yet have a clean per-issue artifact boundary and would create an oversized first PR if mixed in now

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. defining which operator actions are significant enough to become canonical per-issue interventions in this slice
2. requiring reports to describe stored intervention evidence explicitly instead of implying that no intervention happened
3. narrowing the first slice to interventions that already have a stable per-issue anchor

Does not belong here:

1. raw GitHub body storage
2. CLI implementation details
3. retry or landing state transitions

### Configuration Layer

Belongs here:

1. no new workflow-frontmatter contract is required
2. reuse existing runtime path resolution so operator/report commands can find issue artifacts deterministically

Does not belong here:

1. hiding intervention taxonomy inside prompt text only
2. adding new workflow knobs for report formatting in this slice

### Coordination Layer

Belongs here:

1. orchestrator persistence of tracker-normalized landing-command intervention facts into canonical issue artifacts
2. no changes to retry budgeting, continuation handling, or reconciliation state machines

Does not belong here:

1. ad hoc GitHub comment parsing in orchestrator code
2. instance-global operator bookkeeping mixed into orchestrator runtime state

### Execution Layer

Belongs here:

1. repo-owned CLI/report commands appending canonical per-issue intervention events after successful operator actions
2. no runner or workspace behavior changes

Does not belong here:

1. tracker normalization
2. report aggregation policy
3. provider-specific runner assumptions

### Integration Layer

Belongs here:

1. extending GitHub pull-request normalization from boolean landing-command presence to additive landing-command metadata
2. keeping transport parsing and normalization at the tracker edge

Does not belong here:

1. markdown/report rendering
2. artifact append logic for local CLI commands
3. orchestration policy for retries or human review

### Observability Layer

Belongs here:

1. additive canonical operator-intervention event schema and append helpers
2. report and campaign derivation over the stored intervention events
3. backward-compatible parsing of older artifact directories without the new events

Does not belong here:

1. raw remote API fetches during report generation
2. tracker mutations beyond already-executed repo-owned commands
3. a competing source of truth outside canonical issue artifacts

## Architecture Boundaries

### `src/observability/issue-artifacts.ts`

Owns:

1. additive event kinds or a typed operator-intervention payload shape for canonical issue artifacts
2. a focused append path for event-only writes from repo-owned commands
3. idempotent event persistence rules

Does not own:

1. GitHub comment parsing
2. operator policy about when to land or publish
3. campaign summarization logic

### `src/tracker/`

Owns:

1. landing-command normalization from GitHub review/comment data into stable metadata
2. keeping raw GitHub comment fields out of the orchestrator except for the normalized landing-command facts this slice needs

Does not own:

1. issue artifact writes
2. report markdown wording
3. operator CLI action logging

### `src/orchestrator/service.ts`

Owns:

1. recording tracker-derived landing-command intervention evidence into canonical artifacts during lifecycle observation

Does not own:

1. direct GitHub parsing
2. report CLI side effects
3. generalized operator ledgers

### `src/cli/report.ts` plus related observability/integration helpers

Owns:

1. appending canonical intervention events for report publication, review recording, and follow-up issue filing after those actions complete
2. preserving existing blocked/error behavior when the primary command side effect succeeds but canonical persistence fails afterward

Does not own:

1. redefining report-review ledger semantics
2. hand-rolled artifact file writes outside the observability seam
3. campaign aggregation

### `src/observability/issue-report.ts`, `src/observability/issue-report-markdown.ts`, `src/observability/campaign-report.ts`

Owns:

1. grouping and summarizing the broader intervention event set
2. rendering timestamps, concise details, and improved campaign counts
3. graceful fallback for legacy artifacts

Does not own:

1. discovering new remote facts from GitHub
2. tracker normalization
3. operator workflow decisions

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one additive observability seam:

1. extend canonical issue artifacts with a generic operator-intervention event path
2. wire two bounded producers into that path:
   - tracker-derived landing-command observation
   - repo-owned report CLI actions with explicit issue numbers
3. update issue/campaign reports to summarize the new stored evidence
4. add focused tests across those producers and the read-side report surfaces

This PR deliberately defers:

1. instance-global interventions without a stable per-issue anchor, including detached factory restart/recovery actions and ready-queue reprioritization
2. storing arbitrary operator notes or free-form infrastructure commentary as canonical artifacts
3. any broader GitHub comment archival
4. TUI/status redesign for intervention counts unless a small additive field is already shared naturally

Why this seam is reviewable:

1. it keeps canonical truth in the existing issue artifact ledger
2. it avoids reopening orchestrator control flow or tracker transport architecture beyond the small landing-command metadata extension
3. it reuses repo-owned CLI paths that already have issue numbers instead of inventing a new operator-state service

## Operator Intervention Event Model

This slice should use one additive event model rather than more special-case report logic.

### Intervention classes in scope

1. `plan-approved` / `plan-waived`
   - preserved through the existing event kinds and mapped into the generalized intervention summary
2. `landing-command-observed`
   - tracker-derived evidence that a human `/land` command was observed on the current PR head
3. `report-published`
   - a report publication completed through `symphony-report publish`
4. `report-review-recorded`
   - the operator recorded a completed-run review decision through `symphony-report review-record`
5. `report-follow-up-filed`
   - the operator filed a report-driven GitHub follow-up issue through `symphony-report review-follow-up`

### Event payload expectations

Each stored intervention entry should preserve only normalized facts needed for reporting, for example:

1. timestamp
2. intervention class
3. concise summary
4. source such as `tracker` or `operator-cli`
5. additive details such as PR URL/number, follow-up issue number/URL, publication root, or review status

The payload should not store raw GitHub-authored comment bodies beyond the already-normalized command fact.

## No Runtime State Machine Change

This issue does not change retry, continuation, reconciliation, lease, or handoff transitions. A new orchestrator runtime state machine is therefore not required for this slice.

Instead, the explicit model here is the additive intervention event taxonomy plus idempotent append rules:

1. tracker-derived interventions are appended when a newly observed normalized fact appears
2. repo-owned CLI interventions are appended after the primary command side effect succeeds
3. repeated polls or repeated reads must not emit duplicate canonical events for the same underlying action

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| `/land` exists on the current PR head and has not been recorded yet | current issue artifact ledger, latest PR artifact snapshot | landing-command metadata with stable identity and timestamp | append one `landing-command-observed` intervention event |
| `/land` remains visible on later polls after the same command | existing event with same stable identity | same landing-command metadata | do not append a duplicate event |
| `symphony-report publish` completes but event append fails afterward | publication metadata and archive path, command return already succeeded | none | fail loudly so the operator knows canonical persistence is incomplete; do not silently claim full success |
| `review-follow-up` creates a GitHub issue but canonical append or ledger persistence fails | created issue number/url, local review-state context | none | preserve existing blocked review-state handling, report the persistence failure clearly, and record as much normalized local evidence as the narrow seam allows |
| Older issue artifact directories do not contain generalized intervention events | legacy `issue.json`, `events.jsonl`, report artifacts | maybe plan-review events only | generate readable reports with partial/legacy wording instead of crashing or inventing missing interventions |

## Storage / Persistence Contract

1. keep canonical per-issue local artifacts under `.var/factory/issues/<issue-number>/` as the system of record
2. extend the event schema additively so older artifact ledgers remain readable
3. prefer a focused helper that appends events without requiring every operator CLI command to rewrite issue summaries manually
4. preserve stable event identity for deduplication, especially for tracker-derived landing commands
5. keep the report schema additive where possible; intervention entries should generalize beyond the current `"approved" | "waived"` shape without breaking older generated reports

## Observability Requirements

1. issue reports should summarize all recorded intervention evidence in canonical local artifacts, not only plan-review approvals/waivers
2. markdown rendering should show concise per-entry timing and detail without turning into a raw event dump
3. campaign digests should count issues with recorded operator interventions using the broadened event set and should avoid the phrase `plan-review interventions` when that is no longer true
4. legacy artifacts should remain explicit about limited intervention coverage rather than implying complete absence of manual action

## Decision Notes

1. The first slice intentionally excludes detached factory restart/recovery actions because they are instance-scoped, not cleanly per-issue, and would widen the PR into a second artifact boundary.
2. The first slice should preserve `/land` via tracker normalization instead of scraping issue reports later, because the tracker layer already decides whether the command is current-head-valid.
3. Repo-owned report commands are the right second producer because they already take explicit issue numbers and represent meaningful operator work that today lives only in separate ledgers or side effects.

## Implementation Steps

1. Extend the canonical issue-artifact event contract with a generalized operator-intervention shape and add a focused append helper for event-only writes.
2. Extend GitHub pull-request normalization to preserve landing-command metadata beyond the current boolean flag.
3. Update orchestrator lifecycle artifact recording so a newly observed landing command appends one canonical intervention event without duplicating on every poll.
4. Update report CLI paths for `publish`, `review-record`, and `review-follow-up` to append normalized intervention events after successful issue-scoped operator actions.
5. Generalize issue-report derivation and markdown rendering so `operatorInterventions` can summarize the broader intervention event set while still mapping legacy `approved` and `waived` events.
6. Update campaign-report conclusions/counting to use the broadened intervention set and wording.
7. Update README or other docs only where command/report semantics materially change.
8. Add focused regression coverage across unit/integration/e2e layers.

## Tests And Acceptance Scenarios

### Unit

1. issue-artifact append helper records additive intervention events without duplicating identical stable events
2. pull-request normalization preserves landing-command metadata for a valid current-head human `/land`
3. issue-report derivation groups plan-review and non-plan interventions together and remains backward compatible with older artifacts
4. campaign-report conclusions/counts reflect the broadened intervention set and wording
5. report CLI paths append intervention events after successful review/publication actions and surface persistence failures clearly

### Integration

1. GitHub bootstrap tracker/orchestrator coverage where a valid `/land` command is observed and a canonical intervention event becomes report-visible
2. report CLI coverage where `review-record`, `review-follow-up`, or `publish` writes both its existing side effect and the additive canonical intervention event

### End-to-end

1. a realistic issue run reaches `awaiting-landing-command`, receives `/land`, and the generated issue report names that operator intervention instead of implying no manual action beyond plan review
2. a completed-run report review or follow-up issue filing path produces a generated issue report and campaign summary that count the run as intervention-bearing

### Acceptance scenarios

1. When a human `/land` command is valid for the current PR head, canonical local artifacts preserve a normalized intervention entry with timestamped landing evidence.
2. When the operator records or publishes a completed-run report through repo-owned CLI paths, the issue’s canonical artifact ledger preserves that intervention.
3. The issue report’s operator-intervention section no longer defaults to `No explicit operator handoff events were recorded` when one of those non-plan interventions happened.
4. Campaign conclusions/counts describe recorded operator interventions broadly rather than only `plan-review interventions`.

## Exit Criteria

1. representative non-plan operator interventions appear in canonical issue artifacts
2. generated `report.json` and `report.md` expose those interventions explicitly and remain backward compatible with older artifacts
3. campaign digests summarize intervention-bearing runs using the broadened event set
4. local validation passes:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`

## Deferred To Later Issues Or PRs

1. instance-scoped operator interventions such as detached factory restart/recovery actions without a stable per-issue anchor
2. ready-queue reprioritization or other tracker-level interventions that span multiple issues
3. broader operator observability in status/TUI beyond the additive carry-through of per-issue intervention facts
4. archival of raw operator notes, transcripts, or free-form degraded-infrastructure commentary
