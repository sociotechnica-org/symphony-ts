# Issue 207 Plan: Require Approved Bot Review Before Landing PRs

## Status

- plan-ready

## Goal

Prevent Symphony from landing a GitHub pull request unless at least one configured required review bot has produced review output for the current PR head. A green CI surface and the absence of actionable feedback are not sufficient when the configured bot-review gate has not actually run.

## Scope

- add a narrow tracker-owned contract for "required bot review observed on the current PR head"
- apply that contract both to normalized PR lifecycle evaluation and to guarded landing execution
- keep GitHub transport, normalization, and policy separated while threading the new fact through the existing pull-request snapshot seam
- add operator-facing lifecycle/status wording so a PR that is still waiting on bot review is not presented as ready for `/land`
- add unit, integration, and e2e coverage for the regression where configured bots never review but the PR still lands

## Non-goals

- redesigning the broader review loop or landing command protocol
- changing how actionable bot feedback is summarized for follow-up prompts beyond the narrow facts needed for review-gate policy
- introducing non-GitHub review-bot adapters or remote review services
- changing runner, workspace, retry, or reconciliation behavior outside the review-gate seam
- broad status-surface redesign beyond the new lifecycle/status needed to describe pending bot review

## Current Gaps

- `src/tracker/pull-request-snapshot.ts` records actionable bot review feedback, but it does not normalize whether any required bot has reviewed the current PR head at all
- `src/tracker/pull-request-policy.ts` treats a clean PR with no actionable feedback as `awaiting-landing-command`, even when configured review bots have produced no review output
- `src/tracker/guarded-landing.ts` blocks on actionable bot feedback but does not fail closed when required bot review is missing entirely
- `src/domain/workflow.ts` only exposes `reviewBotLogins`, which conflates "bot authors whose feedback is actionable" with "bots whose review presence is required before landing"
- operator-facing status/docs currently tell humans to post `/land` once the PR is green and review-clean, which is inaccurate for the missing-bot-review failure mode

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that landing is gated on observed required bot review for the current PR head, not only on CI and absence of actionable feedback
  - belongs: define fail-closed behavior when required bot review is configured but not yet observed
  - does not belong: raw GitHub GraphQL nodes, comment parsing details, or status rendering code
- Configuration Layer
  - belongs: express which bot logins are treated as required landing reviewers, while preserving the existing actionable-feedback config seam
  - does not belong: PR lifecycle decisions, guarded-landing evaluation, or GitHub payload parsing
- Coordination Layer
  - belongs: consume the tracker-normalized lifecycle and landing-block reasons without re-deriving bot-review policy in the orchestrator
  - does not belong: deciding whether a given GitHub review/comment counts as bot-review output
- Execution Layer
  - belongs: no workspace or runner behavior changes in this slice
  - does not belong: review-gate policy or tracker config resolution
- Integration Layer
  - belongs: read the GitHub review/comment facts needed to determine whether required bot review exists on the current head, normalize them into PR snapshots, and evaluate lifecycle/landing policy from those normalized facts
  - does not belong: orchestrator retry budgeting or observability inference from raw payloads
- Observability Layer
  - belongs: expose a distinct waiting/block reason when required bot review is still pending
  - does not belong: reconstructing review-gate truth from GitHub transport payloads after the fact

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts` and `src/config/workflow.ts`
  - add a narrow config seam for required landing-review bots if needed
- `src/tracker/pull-request-snapshot.ts`
  - normalize required-bot-review coverage for the current PR head
- `src/tracker/pull-request-policy.ts`
  - keep a PR out of landing-command state until required bot review is observed
- `src/tracker/guarded-landing.ts`
  - fail closed if guarded landing runs before required bot review is observed
- `src/tracker/github.ts`
  - thread the normalized bot-review facts into lifecycle and landing evaluation without mixing transport and policy
- shared lifecycle/status/report types under `src/domain/`, `src/observability/`, and orchestrator consumers
  - add the minimal new lifecycle/status shape needed to represent pending required bot review cleanly
- tests and docs
  - cover the new gate and update `/land` guidance

### Does not belong in this issue

- a generic multi-tracker review-approval framework
- changes to merge transport or `/land` authorization rules
- prompt-contract redesign for follow-up work
- workspace cleanup, lease recovery, or runner continuation refactors
- broad observability/TUI polish unrelated to the new waiting state

## Layering Notes

- `config/workflow`
  - owns the configured required-bot-review list
  - does not own review evidence parsing or lifecycle policy
- `tracker`
  - owns GitHub review transport, normalization of bot-review coverage, and lifecycle/landing policy
  - must keep transport, normalization, and policy in separate focused modules
- `workspace`
  - remains untouched
- `runner`
  - remains untouched
- `orchestrator`
  - consumes normalized lifecycle and landing results only
  - must not inspect raw bot comments/reviews to decide if landing is allowed
- `observability`
  - renders the normalized pending-bot-review state and blocked landing reason
  - must not reimplement bot-review counting or current-head matching

## Slice Strategy And PR Seam

Keep this as one reviewable PR centered on one narrow seam: required bot-review presence as a tracker-owned landing prerequisite.

Current PR:

1. add a normalized required-bot-review fact on pull-request snapshots
2. add the minimal config/lifecycle/status support needed to represent "waiting on required bot review"
3. apply that fact in both PR lifecycle policy and guarded landing
4. add regression coverage and operator docs

Deferred:

- richer per-bot approval policies such as "all configured bots" versus "one of N bot groups"
- tracker-agnostic abstractions for non-GitHub bot review sources
- any broader cleanup of review-feedback prompt context

This seam is reviewable because it stays inside the existing GitHub review/landing boundary and avoids reopening runner, workspace, or retry-state design.

## Runtime State Model

This issue changes the PR handoff path, so the waiting states must stay explicit.

### Relevant states

- `awaiting-system-checks`
  - checks have not stabilized or gone terminal green yet
- `awaiting-human-review`
  - human review threads remain unresolved
- `awaiting-bot-review`
  - required bot review has not yet been observed on the current PR head
- `rework-required`
  - failing terminal checks or actionable bot feedback require another coding run
- `awaiting-landing-command`
  - checks are terminal green, no actionable feedback remains, and required bot review has been observed; the PR is now eligible for a human `/land`
- `awaiting-landing`
  - a valid `/land` was observed and guarded landing may execute
- `handoff-ready`
  - merge has been observed

### Allowed transitions relevant to this issue

- `awaiting-system-checks` -> `awaiting-bot-review`
  - checks become terminal green and no actionable feedback remains, but required bot review is still missing
- `awaiting-system-checks` -> `awaiting-landing-command`
  - checks become terminal green and required bot review is already observed
- `awaiting-bot-review` -> `rework-required`
  - a required bot produces actionable feedback
- `awaiting-bot-review` -> `awaiting-human-review`
  - a human unresolved review thread appears
- `awaiting-bot-review` -> `awaiting-landing-command`
  - at least one required bot review is observed on the current PR head and no blocking feedback remains
- `awaiting-landing-command` -> `awaiting-bot-review`
  - the PR head changes and prior required bot review becomes stale for the new head
- `awaiting-landing-command` -> `awaiting-landing`
  - a valid `/land` is posted for the current clean PR head
- `awaiting-landing` -> `awaiting-bot-review`
  - guarded landing refresh sees the approved head is current but required bot review is still missing
- `awaiting-landing` -> `handoff-ready`
  - merge is observed

### Coordination decision rules

- the orchestrator continues to wait on normalized tracker states
- the tracker must not surface `awaiting-landing-command` until required bot review is satisfied
- guarded landing must independently re-evaluate required bot review on fresh tracker data and fail closed if it is missing
- a new PR head invalidates prior required bot-review observations unless the new head has its own qualifying bot review output

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Checks are green, no actionable feedback exists, and no required bot has reviewed the current head | no landing attempt active | required-bot-review coverage is missing for current head | stay `awaiting-bot-review`; do not surface `/land` readiness |
| Required bot left only a non-actionable summary comment on the current head | no landing attempt active | bot-review output classification says non-qualifying | stay `awaiting-bot-review` |
| Required bot left actionable feedback on the current head | no landing attempt active | bot-review observed and actionable bot feedback present | `rework-required` |
| Required bot reviewed an older head, then the branch was pushed | current PR head SHA changed | stale bot-review coverage tied to prior head | return to `awaiting-system-checks` or `awaiting-bot-review` based on check state; do not allow landing |
| Human posts `/land` before any required bot review exists | landing approval observed | guarded landing snapshot shows missing required bot review | block landing with explicit reason and return to `awaiting-bot-review` |
| One required bot reviewed current head and another configured bot did not | no landing attempt active | policy says minimum threshold satisfied | allow `awaiting-landing-command` if other conditions pass |
| A workflow has no required bot-review config | no landing attempt active | required-bot-review gate disabled | preserve existing lifecycle and landing behavior |

## Storage / Persistence Contract

- no new external durable store is introduced
- tracker state remains the source of truth for PR head SHA and observed review output
- workflow config becomes the source of truth for which bot logins are required reviewers
- issue artifacts and status snapshots should persist the new lifecycle or blocked reason when bot review is still pending
- no local cache should outlive the current normalized PR snapshot; required-bot-review coverage should be recomputed from fresh tracker facts

## Observability Requirements

- status snapshots should distinguish a PR waiting on required bot review from one waiting on human review or `/land`
- landing-blocked artifacts should capture a distinct blocked reason for missing required bot review
- issue reports and summaries should describe the PR as waiting on required bot review when that is the active gate
- README/runbook guidance should tell operators not to post `/land` until required bot review has actually appeared

## Decision Notes

- Add a dedicated workflow/config seam such as `tracker.required_review_bot_logins` rather than overloading `tracker.review_bot_logins` as both "actionable bot authors" and "required landing reviewers". To preserve current self-hosting behavior, the new field should default to `tracker.review_bot_logins` when omitted.
- Count required bot review from normalized review/comment output attached to the current PR head. The plan should make the qualifying signal explicit in normalization so guarded landing and lifecycle policy consume the same fact instead of each interpreting raw comments differently.
- Prefer a distinct lifecycle such as `awaiting-bot-review` instead of reusing `awaiting-human-review` or `awaiting-system-checks`, because the operator action and blocked reason are different and should stay inspectable.

## Implementation Steps

1. Extend the GitHub workflow config contract with a narrow required-review-bot list and document the defaulting/backward-compatibility behavior.
2. Introduce a normalized pull-request snapshot fact for required bot-review coverage on the current PR head, including enough detail to explain whether coverage is missing and which bot satisfied it.
3. Update PR lifecycle policy so a clean PR remains in `awaiting-bot-review` until the required review gate is satisfied, then advances to `awaiting-landing-command`.
4. Update guarded landing policy so `executeLanding()` refuses to merge when required bot review is still missing on a fresh snapshot.
5. Thread the new lifecycle and landing-block reason through shared types, orchestrator status projection, issue artifacts, and reports.
6. Extend the mock GitHub harness to simulate:
   - no bot review output
   - qualifying bot review output on the current head
   - stale bot review on an older head after a push
   - actionable bot feedback after review output
7. Update operator-facing docs in `README.md` and relevant runbooks/self-hosting guidance.
8. Run local self-review and repo gates before opening or updating the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - local review tool if available and reliable

## Tests And Acceptance Scenarios

### Unit

- pull-request snapshot normalization distinguishes required bot-review presence on the current head from missing or stale bot review
- PR lifecycle policy returns `awaiting-bot-review` for a green PR with no actionable feedback and no required bot review
- PR lifecycle policy advances to `awaiting-landing-command` once required bot review is observed
- guarded landing rejects when required bot review is missing even if checks are green and no actionable feedback exists
- guarded landing still returns `rework-required` when required bot review exists but actionable bot feedback remains open

### Integration

- GitHub tracker reports `awaiting-bot-review` for a clean PR whose configured required bots have not reviewed the current head
- GitHub tracker returns `awaiting-landing-command` once one required bot review appears on the current head
- GitHub tracker invalidates prior bot-review coverage when the PR head changes
- `executeLanding()` returns a blocked result with the new missing-bot-review reason when `/land` is present but required bot review has not happened
- workflows without required bot-review config preserve existing behavior

### End-to-End

- regression: a PR with green checks and `/land`, but no configured required bot review output, remains open and records a landing-blocked/pending-bot-review outcome
- a PR stays active in `awaiting-bot-review` until a configured required bot emits qualifying review output on the current head
- after qualifying bot review and `/land`, the clean PR lands and completes normally
- after a new push, previously satisfied bot review becomes stale and the PR returns to the pre-landing wait path until bots review the new head

### Acceptance Scenarios

1. BugBot and Devin never review the PR head. Symphony does not mark the PR ready for `/land`, and guarded landing still refuses to merge if `/land` is posted anyway.
2. A required bot reviews the current head with no actionable findings. Symphony surfaces `awaiting-landing-command` and allows landing once `/land` arrives.
3. A required bot reviewed an older head, then the branch changed. Symphony treats that approval as stale and waits for fresh bot review.
4. A workflow that intentionally has no required review bots configured still behaves like the current system.

## Exit Criteria

1. a GitHub PR cannot reach landing readiness or pass guarded landing unless required bot review has been observed on the current PR head
2. missing required bot review is represented as an explicit normalized lifecycle or blocked reason, not hidden under human review or CI states
3. required bot-review coverage is normalized once at the tracker boundary and consumed consistently by lifecycle and landing policy
4. the regression where a green PR lands without any configured bot review is covered by automated tests
5. operator docs describe the new landing prerequisite accurately
6. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass before PR handoff

## Deferred To Later Issues Or PRs

- per-bot quorum rules beyond the minimum "at least one required bot" gate
- bot-specific terminal-state modeling that distinguishes summaries, approvals, and richer review outcomes
- non-GitHub tracker implementations of the same review gate
- any broader review-status UI redesign beyond the minimal new waiting state introduced here
