# Issue 208 Plan: Treat Missing Reviewer-App Output As Degraded Infrastructure

## Status

- plan-ready

## Goal

Treat the absence of expected reviewer-app output on the current PR head as degraded external infrastructure once the normal check surface has settled, so Symphony blocks automation with an explicit degraded reason instead of treating the PR as a normal review wait or a clean review surface.

## Scope

- normalize a distinct tracker-side state for "required reviewer app output missing after checks settled"
- project that state through PR lifecycle evaluation and guarded landing with an explicit degraded reason
- surface the degraded reviewer-app condition in operator-facing status, artifacts, and docs
- add regression coverage for the outage path where configured reviewer apps never produce output at all

## Non-goals

- redesigning the broader review loop beyond the missing-reviewer-app outage seam
- introducing remote reviewer orchestration, app retries, or bot-trigger APIs
- changing `review_bot_logins` actionable-feedback semantics
- inventing a tracker-agnostic approval framework beyond the GitHub bootstrap/runtime contract already in place
- reworking unrelated degraded runtime posture families such as restart recovery or watchdog recovery

## Current Gaps

- `src/tracker/pull-request-snapshot.ts` records whether required approved bot review has been observed, but it does not distinguish "still naturally pending" from "expected reviewer app never produced output"
- `src/tracker/pull-request-policy.ts` currently reports missing required approved bot review as ordinary `awaiting-human-review`, which reads like a normal review wait instead of an infrastructure failure
- `src/tracker/guarded-landing.ts` blocks on missing required bot review, but the blocked reason is not modeled as degraded reviewer-app infrastructure
- orchestrator and status surfaces only receive the existing handoff lifecycle kinds, so this outage path is easy to mistake for ordinary review debt
- README and operator guidance do not yet say that a configured reviewer app silently disappearing is degraded external infrastructure

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that configured required reviewer-app output is mandatory coverage and that silent absence after checks settle is degraded infrastructure, not ordinary review waiting
  - does not belong: GitHub transport details, raw comment parsing, or merge API behavior
- Configuration Layer
  - belongs: reuse the existing `approved_review_bot_logins` contract as the source of "expected reviewer app output" for this slice unless implementation evidence forces a narrower config seam
  - does not belong: lifecycle/degraded-state evaluation logic
- Coordination Layer
  - belongs: consume a normalized degraded review-output lifecycle/reason and block further progression without adding GitHub-specific heuristics
  - does not belong: raw review/comment/check interpretation
- Execution Layer
  - belongs: no workspace or runner changes in this slice
  - does not belong: reviewer-app outage detection or handoff policy
- Integration Layer
  - belongs: normalize when required reviewer-app output is satisfied, naturally pending, or missing after the PR check surface has settled
  - does not belong: orchestrator retry policy or operator rendering logic
- Observability Layer
  - belongs: expose the degraded reviewer-app reason in lifecycle summaries, issue artifacts, status surfaces, and docs
  - does not belong: re-deriving outage state from raw GitHub payloads

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/pull-request-snapshot.ts`
  - add a normalized reviewer-app output state/reason instead of a single overloaded boolean
- `src/tracker/pull-request-policy.ts`
  - map the normalized missing-output outage state to a degraded lifecycle outcome rather than ordinary human-review waiting
- `src/tracker/guarded-landing.ts` and `src/tracker/service.ts`
  - preserve fail-closed landing behavior while surfacing a degraded reviewer-app reason that matches lifecycle evaluation
- `src/domain/handoff.ts`, `src/observability/`, and orchestrator status projection
  - carry the new degraded lifecycle/reason through existing read models without leaking GitHub-specific parsing upward
- docs and tests
  - update operator/user-facing wording and add regression coverage

### Does not belong in this issue

- workflow prompt changes
- tracker transport rewrites or GraphQL schema reshaping unrelated to reviewer-app evidence
- generic degraded-state refactors across all lifecycle families
- landing-policy changes unrelated to missing reviewer-app output
- multi-tracker parity work for Linear

## Layering Notes

- `config/workflow`
  - remains the repository-owned source of configured required reviewer bots
  - should not decide when missing output becomes degraded
- `tracker`
  - owns the normalization and policy distinction between pending reviewer execution and missing reviewer output
  - should keep review/comment parsing separate from policy decisions
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - consumes a normalized degraded lifecycle/reason and blocks progression
  - must not inspect bot logins, comment bodies, or GitHub check names directly
- `observability`
  - renders the normalized degraded state clearly
  - must not infer degraded reviewer-app outages by reverse-engineering tracker payload side effects

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on a single state-contract seam:

1. normalize reviewer-app output into distinct states rather than a single "approved review satisfied" boolean
2. project the "missing output after checks settled" state as degraded handoff/landing policy
3. update status/docs/tests for the new degraded reason

Deferred:

- reviewer-app-specific timeout/backoff policy beyond the current "checks settled but output missing" detection
- richer per-bot operator dashboards or quorum rules
- Linear or other tracker implementations of the same degraded reviewer-app contract

This seam is reviewable because it strengthens one existing GitHub handoff contract without reopening runner execution, plan review flow, or broader recovery posture design.

## Runtime State Model

This issue changes stateful handoff behavior, so the plan makes the reviewer-app-output states explicit.

### Normalized reviewer-app coverage states

1. `not-required`
   - no approved reviewer bots are configured for this workflow
2. `waiting-on-check-surface`
   - the PR still has pending checks or is still in the no-check stabilization pass, so reviewer apps may still appear naturally
3. `satisfied`
   - at least one configured approved reviewer bot produced qualifying output on the current head
4. `missing-output-degraded`
   - checks have settled past the natural waiting phase, but no configured approved reviewer bot produced qualifying output on the current head

### Handoff lifecycle states relevant to this issue

- `awaiting-system-checks`
  - used while the review/check surface is still naturally pending
- `rework-required`
  - used when bot feedback or failed terminal checks require another run
- `degraded-review-infrastructure`
  - new explicit lifecycle for silent missing reviewer-app output after checks settle
- `awaiting-landing-command`
  - only allowed once reviewer-app coverage is satisfied and no other gates remain
- `awaiting-landing`
  - `/land` observed; guarded landing still re-checks reviewer-app coverage
- `handoff-ready`
  - merge observed

### Allowed transitions relevant to this issue

- `awaiting-system-checks` -> `degraded-review-infrastructure`
  - checks/no-check stabilization have settled, but required reviewer-app output is still absent
- `awaiting-system-checks` -> `awaiting-landing-command`
  - checks are settled and reviewer-app coverage is satisfied with no other blockers
- `degraded-review-infrastructure` -> `rework-required`
  - reviewer app eventually reports actionable feedback on the current head
- `degraded-review-infrastructure` -> `awaiting-landing-command`
  - reviewer app eventually reports qualifying non-actionable output on the current head
- `awaiting-landing` -> `degraded-review-infrastructure`
  - guarded landing re-check sees that reviewer-app coverage is still missing for the current head
- `awaiting-landing` -> `handoff-ready`
  - guarded landing succeeds and merge is observed

### Coordination decision rules

- do not classify reviewer-app absence as degraded while checks are still pending or while the no-check stabilization pass is still active
- once the PR is otherwise check-clean and reviewer-app output is still absent, fail closed with an explicit degraded lifecycle/reason
- keep the orchestrator tracker-neutral by consuming only normalized lifecycle kinds/reasons

## Failure-Class Matrix

| Observed condition                                                                                   | Local facts available     | Normalized tracker facts available                                  | Expected decision                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Pending CI or requested reviewer-app status is still visible                                         | no landing attempt active | coverage state = `waiting-on-check-surface`; pending checks present | stay in `awaiting-system-checks`                                            |
| No checks were visible on first inspection                                                           | no landing attempt active | no-check stabilization observation absent                           | stay in `awaiting-system-checks` for stabilization                          |
| No checks are visible after the stabilization pass, and no approved reviewer bot has produced output | no landing attempt active | coverage state = `missing-output-degraded`                          | report `degraded-review-infrastructure` with explicit missing-output reason |
| Checks are green and a configured approved reviewer bot leaves a qualifying clean output             | no landing attempt active | coverage state = `satisfied`; actionable feedback count = 0         | move to `awaiting-landing-command`                                          |
| Checks are green and a configured approved reviewer bot leaves actionable feedback                   | no landing attempt active | coverage state = `satisfied`; actionable feedback count > 0         | move to `rework-required`                                                   |
| `/land` exists, but guarded landing re-check still finds no reviewer-app output on current head      | landing approval recorded | coverage state = `missing-output-degraded`                          | block landing with degraded reviewer-app reason and lifecycle fallback      |
| Required approved reviewer bot list is empty                                                         | no landing attempt active | coverage state = `not-required`                                     | preserve existing non-degraded behavior                                     |

## Storage / Persistence Contract

- no new durable store is introduced
- workflow config remains the source of truth for configured approved reviewer bots
- reviewer-app coverage/degraded state remains a normalized, ephemeral tracker snapshot derived from GitHub facts on the current PR head
- issue artifacts and landing-blocked summaries should persist the normalized degraded reason, not raw GitHub review payloads

## Observability Requirements

- status and lifecycle summaries must distinguish:
  - normal review waiting
  - reviewer-app output satisfied
  - degraded reviewer-app infrastructure because expected output never appeared
- issue artifacts/reporting should preserve the explicit degraded lifecycle/reason for later inspection
- operator docs should state that silent absence from configured reviewer apps is treated as degraded external infrastructure, not a clean review surface
- landing-blocked output should use the same degraded reason vocabulary as handoff inspection

## Decision Notes

- Reuse `approved_review_bot_logins` as the expected reviewer-app contract for this slice unless implementation evidence shows an unavoidable mismatch between "required reviewer app" and "approved review bot" semantics. That keeps the change narrow and avoids inventing a second overlapping workflow list without proof it is needed.
- Model this as a distinct normalized state, not just a different summary string. The issue is specifically about classification and operator posture, not only wording.
- Prefer a dedicated degraded lifecycle kind over overloading `awaiting-human-review`; otherwise operator surfaces and downstream logic will continue to treat infrastructure outage as ordinary review debt.

## Implementation Steps

1. Extend the handoff domain types with a dedicated degraded reviewer-app lifecycle kind and any supporting normalized reason surface needed for artifacts/status.
2. Replace the single `requiredApprovedReviewSatisfied` gate in `src/tracker/pull-request-snapshot.ts` with a normalized reviewer-app coverage state that can distinguish waiting, satisfied, and missing-output-degraded.
3. Update `src/tracker/pull-request-policy.ts` so the current-head missing-output outage path returns the degraded lifecycle kind after the check surface has settled.
4. Update `src/tracker/guarded-landing.ts` and `src/tracker/service.ts` so guarded landing uses the same degraded reviewer-app reason and lifecycle fallback.
5. Thread the new lifecycle kind through orchestrator/status/artifact projections without adding GitHub-specific logic above the tracker boundary.
6. Update README and any operator docs that currently imply missing reviewer-app output is ordinary review waiting.
7. Add regression coverage across unit, integration, and e2e layers for the missing-output-degraded path and the satisfied/actionable follow-up paths.
8. Run local self-review and repository gates before opening/updating the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- reviewer-app coverage normalization distinguishes `waiting-on-check-surface` from `missing-output-degraded`
- PR lifecycle evaluation returns `degraded-review-infrastructure` once checks are settled and required reviewer-app output is still absent
- PR lifecycle evaluation stays in `awaiting-system-checks` during the no-check stabilization pass
- guarded landing rejects with the degraded reviewer-app reason when current-head reviewer output is still missing

### Integration

- `GitHubTracker.inspectIssueHandoff()` reports `degraded-review-infrastructure` for a clean PR whose configured reviewer apps never emit output after checks settle
- `GitHubTracker.inspectIssueHandoff()` remains `awaiting-system-checks` while requested/in-progress reviewer-app statuses are still present
- `GitHubTracker.inspectIssueHandoff()` transitions from degraded to `awaiting-landing-command` once a configured reviewer app leaves qualifying clean output on the current head
- `GitHubTracker.executeLanding()` returns a blocked degraded reviewer-app result when `/land` is present but required reviewer output is still absent

### End-to-end

- factory run opens a PR, CI turns green, configured reviewer apps never emit output, and the run remains visibly degraded instead of looking review-clean
- factory run opens a PR, reviewer-app output is initially missing, then a configured app emits a clean review on the current head, and the run advances to `awaiting-landing-command`
- after a follow-up push, stale prior-head reviewer output does not satisfy the requirement for the new head, and the run returns to the degraded/waiting path according to the new normalized state

### Acceptance Scenarios

1. Bugbot is configured in `approved_review_bot_logins`, CI is green, Bugbot never leaves any review output, and Symphony reports degraded reviewer-app infrastructure instead of ordinary human-review waiting.
2. Bugbot has a requested or in-progress check/status, and Symphony stays in `awaiting-system-checks` rather than prematurely calling the PR degraded.
3. Bugbot eventually leaves a qualifying clean summary on the current head, and Symphony clears the degraded condition and waits for `/land`.
4. A `/land` comment on a PR with missing reviewer-app output still fails closed with the same degraded reviewer-app reason.

## Exit Criteria

1. Symphony no longer reports silent missing reviewer-app output as an ordinary review wait once the PR check surface has settled
2. reviewer-app outage classification is normalized in the tracker instead of inferred ad hoc in observability
3. guarded landing and handoff inspection use the same degraded reviewer-app vocabulary
4. operator-facing status/artifacts/docs make the degraded reason explicit
5. regression coverage exists for pending, degraded, satisfied, and actionable reviewer-app outcomes
6. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- reviewer-app-specific timers, escalation comments, or automatic retrigger behavior
- per-app quorum rules such as "all configured reviewer apps must respond"
- non-GitHub implementations of degraded reviewer-app infrastructure semantics
- broader unification of degraded lifecycle families across handoff, recovery posture, and factory control surfaces
