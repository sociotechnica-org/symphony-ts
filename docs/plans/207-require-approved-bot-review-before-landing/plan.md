# Issue 207 Plan: Require Approved Bot Review Before Landing PRs

## Status

- plan-ready

## Goal

Tighten the GitHub landing guard so Symphony refuses to land a pull request unless at least one configured approved reviewer bot has produced review output for the current PR head. Green checks and the absence of actionable feedback are not sufficient if the required bot-review pass never actually happened.

## Scope

- add an explicit workflow/config seam for approved reviewer bots that must be observed before landing
- normalize fresh bot-review-presence facts from GitHub PR review data for the current PR head
- extend the guarded landing policy to fail closed when required approved bot review output is missing
- keep the existing follow-up and `/land` lifecycle intact while making landing depend on the stronger review gate
- add unit, integration, and end-to-end coverage for missing, stale, and satisfied approved-bot-review cases
- update operator-facing docs so `/land` is described as requiring green checks plus observed approved bot review on the current head

## Non-goals

- redesigning the broader PR review-loop lifecycle
- changing how actionable bot feedback is detected or summarized for follow-up prompts
- introducing tracker-agnostic review-approval abstractions beyond the narrow GitHub landing gate seam
- replacing the existing `/land` handoff or human landing approval path
- making landing depend on every configured review bot unless that is explicitly part of the new config contract

## Current Gaps

- `src/tracker/guarded-landing.ts` currently blocks landing on stale `/land` approval, draft state, mergeability, checks, actionable bot feedback, and unresolved human review threads, but it does not require proof that an approved bot actually reviewed the current head.
- `src/tracker/pull-request-snapshot.ts` normalizes actionable feedback and the `/land` signal, but it does not expose a dedicated normalized fact for “approved reviewer bot emitted review output after the current head commit”.
- `src/domain/workflow.ts` and `src/config/workflow.ts` expose `review_bot_logins` for bot identification, but there is no separate typed policy contract for which bot logins count as required approved reviewers for landing.
- Operator docs still describe `/land` as appropriate for a “green and review-clean” PR, which is weaker than the intended gate for this issue.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that landing requires observed approved reviewer bot output on the current PR head
  - belongs: define fail-closed behavior when required approved bot review is missing or stale
  - does not belong: raw GitHub GraphQL payload shapes or comment/review pagination details
- Configuration Layer
  - belongs: define typed workflow config for the set of bot logins whose review output satisfies the landing guard
  - does not belong: direct landing decisions or GitHub-specific timestamp comparisons
- Coordination Layer
  - belongs: continue treating blocked landing as a non-terminal wait and preserve the existing landing handoff states
  - does not belong: parsing GitHub review/comment payloads or deciding which raw events count as bot-review output
- Execution Layer
  - belongs: no new runner/workspace behavior in this issue
  - does not belong: tracker review policy or landing decisions
- Integration Layer
  - belongs: normalize current-head approved-bot-review observations from GitHub PR review state and pass them into guarded landing
  - does not belong: orchestrator retry policy or status-surface wording policy
- Observability Layer
  - belongs: clear blocked-landing summaries and operator docs that explain missing approved bot review
  - does not belong: recomputing review freshness from raw tracker payloads

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - add the minimal typed config needed for approved reviewer bot landing policy
- `src/config/workflow.ts`
  - parse and validate the new workflow field without changing unrelated tracker config
- `src/tracker/pull-request-snapshot.ts`
  - normalize whether configured approved reviewer bots produced qualifying review output after the PR head commit
- `src/tracker/guarded-landing.ts`
  - extend the landing gate to require the normalized approved-bot-review fact and return a structured blocked reason
- `src/tracker/github.ts`
  - thread the config and normalized fact through `executeLanding()`
- tests
  - add focused unit/integration/e2e coverage for the missing-review regression and clean pass cases
- docs
  - update operator-facing wording around when `/land` is appropriate

### Does not belong in this issue

- a broad refactor of PR lifecycle evaluation or orchestration runtime state
- changes to runner prompting, workspace behavior, or plan-review workflow
- GitHub transport refactors unrelated to review normalization
- a generic “required approvals” framework spanning human reviewers, branch protection, or non-GitHub trackers

## Layering Notes

- `config/workflow`
  - owns the typed config contract for required approved reviewer bot logins
  - must not decide whether a specific PR satisfies the landing gate
- `tracker`
  - owns GitHub review normalization and landing-policy evaluation
  - must keep transport facts, normalized snapshot facts, and guarded landing policy separated
- `workspace`
  - remains untouched
- `runner`
  - remains untouched
- `orchestrator`
  - continues to treat blocked landing as a tracker-owned decision and should only consume the normalized blocked result
  - must not inspect raw GitHub review comments or infer bot-review freshness itself
- `observability`
  - renders the normalized blocked reason and updates operator guidance
  - must not duplicate tracker policy logic

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one narrow seam: require observed approved bot review as an additional guard inside the existing GitHub landing path.

Current PR:

1. add typed workflow config for the required approved reviewer bots
2. normalize “approved reviewer bot produced output on the current head” in the PR snapshot layer
3. block guarded landing when that fact is absent
4. update tests and operator-facing docs for the stricter landing gate

Deferred:

- making the broader follow-up loop wait for all required bot reviews before it ever reaches `awaiting-landing-command`
- modeling human approvals or GitHub branch-protection approval counts in the same contract
- non-GitHub tracker support for equivalent required-review-bot policy

This seam is reviewable because it strengthens one existing landing precondition without reopening orchestration, retries, or tracker transport architecture.

## Runtime State Model

This issue does not add a new top-level handoff state. It tightens the guarded landing decision inside the existing `awaiting-landing` path.

### Landing review-gate sub-states

- `awaiting-landing-command`
  - the PR is open and otherwise clean enough for a human landing decision, but no `/land` handoff has been issued
- `awaiting-landing`
  - `/land` was observed for the current head and Symphony is allowed to attempt guarded landing
- `landing-review-gate-open`
  - approved reviewer bot output has been observed on the current head and all existing landing guard checks also pass
- `landing-review-gate-closed`
  - approved reviewer bot output is missing or stale for the current head, so merge is not attempted
- `handoff-ready`
  - merge is observed after a successful guarded landing request

### Allowed transitions

- `awaiting-landing-command` -> `awaiting-landing`
  - a valid human `/land` command is observed on the current PR head
- `awaiting-landing` -> `landing-review-gate-open`
  - the current head has qualifying approved bot review output and the rest of the guarded landing policy passes
- `awaiting-landing` -> `landing-review-gate-closed`
  - qualifying approved bot review output is missing or stale, or another landing guard condition fails
- `landing-review-gate-closed` -> `awaiting-landing-command`
  - the approved head is stale and a fresh `/land` handoff is required
- `landing-review-gate-closed` -> `awaiting-human-review`
  - unresolved human review threads still block landing
- `landing-review-gate-closed` -> `awaiting-system-checks`
  - required checks are pending
- `landing-review-gate-closed` -> `rework-required`
  - failing checks or actionable bot feedback still require changes
- `landing-review-gate-open` -> `handoff-ready`
  - merge is observed after the guarded landing request succeeds
- `landing-review-gate-open` -> `awaiting-landing`
  - merge request is accepted but merge has not yet been observed

### Coordination Decision Rules

- keep the existing `/land` approval contract unchanged
- fetch fresh review/check/mergeability facts at landing time
- treat approved reviewer bot output as a separate fail-closed landing requirement, not as a synonym for “no actionable bot feedback”
- require the qualifying bot output to be on the current head, not merely present somewhere in PR history
- keep blocked landings non-terminal and re-enter the normal tracker lifecycle after the refusal

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| No configured approved reviewer bots in workflow | guarded landing invoked | config has empty required-approved-bot set | current issue should decide whether this means “feature disabled” or invalid config; prefer explicit config semantics in parser/tests |
| Required approved bot never commented or reviewed on this PR head | landing attempt active | approved-bot-review observation is false for current head | block landing with a dedicated missing-approved-bot-review reason |
| Approved bot produced output only before the latest push | landing attempt active, current head SHA known | prior bot output exists but is stale relative to latest commit/head | block landing as missing current-head approved bot review |
| One configured approved bot produced qualifying output on current head, others did not | landing attempt active | normalized current-head satisfied set contains at least one required bot if policy is “any-of” | allow landing if all other gate conditions pass |
| Approved bot output exists but actionable bot feedback is still open | landing attempt active | approved-bot-review observation true and actionable feedback remains | block as actionable follow-up, not as missing approved review |
| Human `/land` approval is stale after a new push | approved head SHA stale | approved review may or may not exist on new head | block as stale-approved-head before merge; require fresh `/land` |
| Checks are green and no feedback remains, but approved bot output is absent because the bot flaked | landing attempt active | no actionable feedback, unresolved threads 0, approved-bot-review observation false | block landing with missing-approved-bot-review reason rather than merging |

## Storage / Persistence Contract

- tracker remains the source of truth for review/comment/check facts
- no new durable local store is introduced
- approved-bot-review presence is a derived normalized snapshot fact, not independently persisted state
- issue artifacts and status summaries should expose the blocked reason through existing landing-result pathways rather than inventing a new persistence surface

## Observability Requirements

- blocked landing summaries must say that required approved bot review on the current head is missing
- operator docs must stop describing `/land` as gated only by “green and review-clean”
- existing status/artifact consumers should receive a distinct blocked-reason enum rather than an overloaded generic review failure string

## Decision Notes

- Keep `review_bot_logins` as the broad bot-identification list for actionable feedback and `/land` trust boundaries; introduce a separate config field for the narrower set of bot logins whose output satisfies the landing gate.
- Evaluate approved-bot-review presence in the normalized PR snapshot layer so guarded landing consumes a simple fact instead of scanning raw review payloads itself.
- Treat current-head freshness using the same commit-time boundary the repo already uses for actionable top-level bot comments and `/land` approval, so the policy remains legible and testable.
- Prefer an “at least one configured approved reviewer bot” policy for this issue because that matches the stated failure mode and keeps the seam narrow; requiring every configured bot would be a broader workflow-policy change.

## Implementation Steps

1. Add typed workflow/domain config for required approved reviewer bot logins, including parser validation and defaults.
2. Extend PR review normalization with a focused helper that determines whether any configured required approved bot produced qualifying review output after the current head commit.
3. Thread that normalized fact through the tracker snapshot used by `executeLanding()`.
4. Extend `src/tracker/service.ts` and `src/tracker/guarded-landing.ts` with a dedicated blocked reason for missing approved bot review.
5. Update `GitHubTracker.executeLanding()` to fail closed on the new guarded-landing result.
6. Add unit tests for workflow parsing, review normalization, and guarded landing policy.
7. Add integration coverage for the GitHub tracker landing path when approved bot review is missing, stale, and present.
8. Add e2e coverage for the regression where CI is green but no configured approved reviewer bot reviewed the current head.
9. Update operator-facing docs to describe the stronger landing precondition.
10. Run self-review plus repo checks:
   - local review tool if available and reliable
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts a configured approved-review-bot list and rejects malformed values
- PR snapshot normalization returns false when no required approved bot output exists on the current head
- PR snapshot normalization ignores stale approved-bot output from before the latest push
- PR snapshot normalization returns true when a configured approved bot emits qualifying output on the current head
- guarded landing rejects when approved bot review is missing even if checks are green and no actionable feedback remains
- guarded landing still rejects for actionable feedback, unresolved human threads, stale `/land`, or failed checks with their existing reasons

### Integration

- `GitHubTracker.executeLanding()` blocks merge when a PR is otherwise clean but no required approved bot reviewed the current head
- `GitHubTracker.executeLanding()` blocks merge when the only approved-bot output predates the latest head commit
- `GitHubTracker.executeLanding()` allows merge when a configured approved bot reviewed the current head and the rest of the guarded gate passes
- `inspectIssueHandoff()` behavior remains unchanged for existing review-clean vs actionable-follow-up paths unless a later issue intentionally broadens that policy

### End-to-End

- factory run reaches `awaiting-landing-command`, receives `/land`, but remains unmerged because the configured approved reviewer bots produced no output on the current head
- factory run remains blocked when approved bot output is stale after a follow-up push
- factory run lands normally when checks are green, actionable feedback is clear, and at least one configured approved reviewer bot emitted qualifying output on the current head

## Exit Criteria

1. landing no longer proceeds on a green PR unless at least one configured approved reviewer bot has produced qualifying output on the current head
2. missing or stale approved bot review produces a distinct blocked landing reason
3. existing landing blockers for checks, actionable feedback, unresolved human threads, draft state, and stale `/land` continue to work
4. operator-facing docs reflect the stronger landing requirement
5. unit, integration, and e2e coverage prove the missing-review regression and the clean pass case
6. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- requiring all configured approved reviewer bots instead of any one
- making approved-bot-review presence part of the earlier lifecycle classification before `/land`
- non-GitHub tracker equivalents for required bot-review landing policy
- richer observability surfaces that enumerate which specific required bots have or have not reviewed
