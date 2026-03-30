# Issue 257 Plan: Operator Report Review First And Follow-Up Issue Filing

## Status

- plan-ready

## Goal

Make completed-run report review a required first checkpoint in the operator wake-up loop so completed factory work feeds back into `symphony-ts` as tracked follow-up issues instead of disappearing into scratchpad prose or operator memory.

The intended outcome of this slice is:

1. newly completed runs are discovered before ordinary queue-advancement work
2. the operator ensures the per-issue report exists and records that review happened
3. evidence-backed report findings can be turned into GitHub follow-up issues through a supported repo-owned path
4. the selected instance scratchpad preserves what was learned and what was queued

## Scope

This slice covers:

1. an operator-owned pending/completed report-review contract for instance-local state under `.ralph/instances/<instance-key>/`
2. wake-up policy updates in the operator skill, prompt, and runbook so report review happens before ordinary queue advancement
3. a narrow report-review helper path that can:
   - detect newly completed issues that need review
   - ensure a local per-issue report exists
   - record review results and linked follow-up issues
4. a supported follow-up issue filing path for concrete factory/runtime/reporting defects grounded in report evidence
5. scratchpad integration so the operator records findings and queued work in a durable instance-local notebook
6. focused tests for pending-review detection, review-state persistence, and at least one report-driven follow-up issue creation path

## Non-Goals

This slice does not include:

1. changing orchestrator completion, retry, reconciliation, or queue-ordering policy
2. making report generation or archive publication part of the orchestrator runtime
3. fully autonomous triage, deduplication, prioritization, or labeling of every possible future issue
4. changing the canonical issue-report schema unless a small additive field is required for operator review state wiring
5. broad GitHub tracker adapter refactors or a new general-purpose issue-management subsystem
6. campaign-digest automation or cross-run analytics beyond the per-issue completed-run seam

## Current Gaps

Today the repo has detached reporting commands and operator guidance, but the operator wake-up loop does not treat completed-run reporting as a first-class checkpoint:

1. completed issues can be merged or forgotten without a report ever being generated or reviewed
2. there is no operator-owned durable record of which completed reports have already been reviewed
3. report findings can remain trapped in scratchpad prose instead of becoming GitHub follow-up issues
4. the operator prompt and runbook prioritize plan review and landing but do not yet force a completed-run report-review pass first
5. there is no narrow, testable repo-owned seam for turning evidence-backed report findings into follow-up tracker work

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that completed-run report review is a mandatory operator checkpoint before ordinary queue advancement
2. the criteria for when a report finding is concrete enough to become a GitHub follow-up issue
3. the requirement that the operator records what was reviewed, what was learned, and what was queued

Does not belong here:

1. GitHub API payload shapes
2. orchestrator retry or dispatch rules
3. hidden operator-memory-only conventions

### Configuration Layer

Belongs here:

1. any narrow operator-facing config or environment contract needed to locate optional archive-publication or issue-filing inputs
2. path resolution for instance-local review state under the selected operator instance root

Does not belong here:

1. new `WORKFLOW.md` runtime semantics for orchestrator completion
2. embedding report-review truth only in prompt text without a typed/local contract

### Coordination Layer

Belongs here:

1. no orchestrator-runtime changes in this slice
2. a small operator-owned review-state model for pending/completed report review, if needed, kept outside orchestrator state

Does not belong here:

1. teaching the orchestrator to own report review, issue filing, or operator notebook updates
2. mixing completed-run review bookkeeping into retry/follow-up/landing counters already owned by the runtime

### Execution Layer

Belongs here:

1. invoking existing detached report-generation and optional publication commands from a repo-owned operator path
2. shelling out to a supported issue-filing path when the operator decides a follow-up issue should be created

Does not belong here:

1. runner changes
2. workspace lifecycle changes
3. provider-specific assumptions about Codex or Claude runs

### Integration Layer

Belongs here:

1. the narrow GitHub issue-filing boundary for report-driven follow-up issues
2. keeping any tracker interaction for follow-up issue creation at the edge
3. normalization of any issue-filing inputs derived from reports or review notes before they hit GitHub

Does not belong here:

1. orchestrator-owned lifecycle interpretation
2. report composition logic
3. tracker transport mixed into operator prompt text or scratchpad formatting

### Observability Layer

Belongs here:

1. completed-run report discovery helpers
2. operator-owned review-state storage for which reports are pending, reviewed, published, and linked to follow-up issues
3. rendering or reading the local report evidence used during operator review
4. scratchpad-facing summaries of report-review outcomes

Does not belong here:

1. tracker mutations in the middle of report parsing
2. new runtime state authority for issue completion
3. inventing a second source of truth that competes with canonical issue reports

## Architecture Boundaries

### `skills/symphony-operator/`

Owns:

1. wake-up ordering rules
2. report-review and issue-filing policy
3. concise operator checklists

Does not own:

1. the only durable state of what reports were reviewed
2. GitHub transport details
3. report derivation logic

### `docs/guides/operator-runbook.md`

Owns:

1. the canonical completed-run review procedure
2. the order of operator checkpoints
3. how to interpret pending/completed report-review state

Does not own:

1. the only copy of machine-readable review state
2. GitHub CLI implementation details that belong in code/tests

### operator instance state under `.ralph/instances/<instance-key>/`

Owns:

1. append-only or otherwise explicit review records for completed issue reports
2. linked follow-up issue references
3. local operator notes in the scratchpad

Does not own:

1. orchestrator runtime truth
2. canonical issue-report artifacts
3. tracker state that must live in GitHub

### reporting/observability services

Owns:

1. locating generated per-issue reports
2. ensuring a missing report can be generated on demand
3. exposing the evidence the operator uses to review a completed run

Does not own:

1. queue advancement policy
2. GitHub issue creation decisions without an explicit operator-owned rule

### GitHub interaction seam

Owns:

1. creating the follow-up issue when the operator review decides one is warranted
2. recording the returned issue number/URL back into local operator review state

Does not own:

1. report parsing
2. scratchpad narrative formatting
3. orchestrator lifecycle transitions

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one operator/reporting seam:

1. add a small operator-owned review-state contract under `.ralph/instances/<instance-key>/`
2. add helper code for pending completed-report discovery and on-demand report generation
3. add the narrow follow-up issue filing path and persistence of linked issue refs
4. update operator docs/prompt/skill to make this checkpoint first
5. add focused tests around the new operator-owned seam

This PR deliberately defers:

1. campaign-level report review automation
2. automated issue deduplication against all existing open issues
3. orchestrator-owned report publishing or report-review queues
4. broad archive-publication configuration design beyond any minimal operator-facing input needed for this slice
5. broader tracker adapter abstractions for issue creation beyond the one GitHub self-hosting path needed here

Why this seam is reviewable:

1. it keeps completed-run learning in operator tooling and observability instead of reopening orchestrator control flow
2. it reuses existing per-issue report artifacts as evidence instead of redefining the reporting pipeline
3. it keeps tracker writes at the edge through one focused issue-filing path

## Operator Review State Model

This issue does not change the orchestrator runtime state machine, but it does introduce operator-owned state for completed-run report review. That state should be explicit instead of living as ad hoc scratchpad prose.

### Review subject

One review subject is a completed issue report keyed by:

1. instance key
2. issue number
3. generated report identity, preferably the report path plus `generatedAt`

### Review states

1. `discovered`
   - a completed issue exists, but the operator has not yet ensured a current report exists
2. `report-ready`
   - the current per-issue report exists and is awaiting operator review
3. `reviewed-no-follow-up`
   - the operator reviewed the report and concluded that no concrete follow-up issue was needed
4. `reviewed-follow-up-filed`
   - the operator reviewed the report, filed at least one follow-up issue, and recorded the links locally
5. `review-blocked`
   - review could not be completed because report generation, publication, or issue filing failed and needs another wake-up

### Allowed transitions

1. `discovered -> report-ready`
2. `discovered -> review-blocked`
3. `report-ready -> reviewed-no-follow-up`
4. `report-ready -> reviewed-follow-up-filed`
5. `report-ready -> review-blocked`
6. `review-blocked -> report-ready`
7. `review-blocked -> reviewed-no-follow-up`
8. `review-blocked -> reviewed-follow-up-filed`

### Notes

1. this review state is operator-owned local observability, not tracker-owned lifecycle state
2. the state must distinguish “report missing” from “review completed”
3. follow-up issue references must be stored explicitly so later wake-ups do not recreate the same issue blindly

## Failure-Class Matrix

| Observed condition                                                                             | Local facts available                                                                         | Expected decision                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed issue has canonical raw artifacts but no generated report yet                        | `.var/factory/issues/<issue-number>/...`, no `.var/reports/issues/<issue-number>/report.json` | Generate the per-issue report first, record `report-ready`, then review it before queue advancement                                           |
| Completed issue already has a generated report and no local review record                      | `report.json` / `report.md`, no operator review entry                                         | Treat it as pending report review and handle it first in the wake-up                                                                          |
| Report review finds no concrete defect worth tracking                                          | report evidence plus operator review notes                                                    | Record `reviewed-no-follow-up` with summary in local review state and scratchpad                                                              |
| Report review finds a clear factory/runtime/reporting defect and no linked follow-up issue yet | report evidence plus proposed issue summary/body                                              | Create the follow-up GitHub issue, record the returned issue reference, and mark `reviewed-follow-up-filed`                                   |
| Report review finds a defect but issue creation fails                                          | report evidence plus command/API failure                                                      | Record `review-blocked`, preserve the draft issue content or summary locally, and retry on the next wake-up                                   |
| Follow-up issue was already filed for the same report finding and linked locally               | prior review record includes follow-up issue refs                                             | Do not recreate the issue; record the existing linkage and continue                                                                           |
| Optional report publication is configured but publication fails                                | generated report plus publication target info                                                 | Record `review-blocked` or an explicit partial result, keep the review inspectable locally, and avoid pretending the review completed cleanly |
| Completed issue is still active in runtime state or awaiting landing                           | status surface shows non-terminal lifecycle                                                   | Do not enter completed-run review yet; leave ownership with the existing lifecycle checkpoint                                                 |

## Storage / Persistence Contract

This slice should add explicit operator-owned local review persistence under the selected operator instance root, separate from canonical runtime artifacts.

Preferred contract:

1. keep canonical issue artifacts under `.var/factory/issues/<issue-number>/`
2. keep canonical generated reports under `.var/reports/issues/<issue-number>/`
3. add operator review records under `.ralph/instances/<instance-key>/` in a machine-readable file such as:
   - `report-review-state.json`
   - or `report-reviews.jsonl`
4. continue to keep narrative notes in `.ralph/instances/<instance-key>/operator-scratchpad.md`

Contract rules:

1. operator review records must be recoverable without scanning free-form scratchpad prose
2. local review records must store enough identity to avoid re-reviewing the same report blindly
3. local review records must store linked follow-up issue numbers/URLs when they exist
4. failures should preserve inspectable local evidence rather than silently dropping draft follow-up issue content

## Observability Requirements

1. the operator wake-up loop must make pending completed-report review visible before ordinary queue advancement work
2. local review state must distinguish pending, completed, and blocked report reviews
3. scratchpad updates must summarize what report was reviewed, what defects were found, and what follow-up work was queued
4. if a report is missing, blocked, or stale relative to the completed issue review, that condition should be explicit in the operator-facing output
5. docs must tell operators where the review ledger lives and how it relates to `.var/reports/`

## Implementation Steps

1. Add `docs/plans/257-operator-report-review-follow-ups/plan.md` with the operator/reporting seam, local review-state contract, and failure matrix.
2. Add typed operator review-state paths under the existing instance-identity/state-root utilities.
3. Implement a focused helper/service that:
   - finds completed issues eligible for review
   - ensures their per-issue reports exist, generating them when missing
   - loads/stores local operator review-state entries
4. Add a narrow follow-up issue filing helper for the self-hosting GitHub path and keep tracker writes at that edge.
5. Update the operator loop/prompt/skill/runbook so completed-run report review is the first checkpoint after factory-health inspection and before ordinary queue advancement.
6. Update scratchpad integration so each completed review records:
   - the reviewed issue/report
   - the main findings
   - any follow-up issue links
   - any blocked publication/filing work
7. Add tests for:
   - pending completed-report detection
   - review-state persistence and replay across wake-ups
   - at least one report-driven follow-up issue creation path
   - operator-loop integration where a completed report-review task is prioritized ahead of normal queue advancement work
8. Update `README.md` and `docs/guides/operator-runbook.md` only where needed to point to the new report-review-first checkpoint and local state paths.
9. Run local QA, self-review the diff, and carry the issue through PR/CI/review completion.

## Tests And Acceptance Scenarios

### Unit

1. detect a completed issue with no review record as pending report review
2. detect a completed issue with a matching review record as already handled
3. keep review identity stable across repeated wake-ups for the same `generatedAt` report
4. preserve linked follow-up issue references in local review state

### Integration

1. when a completed issue lacks `report.json`, the operator-owned helper generates the report before review
2. when review produces a concrete finding, the follow-up issue helper creates one GitHub issue and records the returned issue reference
3. when issue creation fails, the review stays locally inspectable as blocked instead of silently completing

### Operator-loop / end-to-end seam

1. one wake-up cycle with a newly completed run performs completed-report review before ordinary queue-advancement work
2. the cycle updates the scratchpad and local review ledger with the reviewed issue and queued follow-up issue

## Acceptance Scenarios

1. A completed self-hosted issue that has no generated report is surfaced during the next operator wake-up, the report is generated, and the issue becomes ready for review before the operator moves on to ordinary queue work.
2. A completed issue with an unreviewed report is treated as a mandatory checkpoint before plan-review or landing-adjacent queue advancement work that is not already an explicit blocker.
3. A report that exposes a concrete factory/runtime/reporting defect can produce a tracked GitHub follow-up issue through the supported repo-owned path, and the created issue link is recorded locally.
4. A reviewed report with no actionable defect is still recorded explicitly so later wake-ups do not keep surfacing it.
5. If report generation, publication, or issue filing fails, the operator sees a blocked review state with inspectable local evidence instead of a silent skip.

## Exit Criteria

1. completed-run report review is an explicit first-class operator checkpoint in checked-in guidance and operator automation
2. the selected operator instance has durable machine-readable review state for completed reports
3. the operator can turn report-backed defects into tracked GitHub follow-up issues through a supported repo-owned path
4. scratchpad notes preserve what was learned and what was queued
5. focused automated coverage exists for the new operator-owned seam
6. local QA passes and the resulting PR is green with review feedback addressed

## Deferred

1. global issue deduplication across historic report findings
2. campaign-digest-driven issue creation
3. orchestrator-owned review queues or report publication hooks
4. non-GitHub follow-up issue filing backends
5. richer prioritization/labeling heuristics for all future report-driven issues

## Decision Notes

1. Keep completed-run learning in operator-owned state, not orchestrator runtime state. The orchestrator already owns lifecycle completion; the operator owns after-action review.
2. Reuse existing per-issue reports as the evidence base. Do not invent a second reporting pipeline just to support wake-up review.
3. Keep GitHub issue creation at the edge. The operator/reporting seam should decide that a follow-up issue is needed, then call one narrow tracker-facing helper to file it.
