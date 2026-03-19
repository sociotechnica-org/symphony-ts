# Issue 207 Plan: Require Approved Bot Review Before Landing PRs

## Status

- plan-ready

## Goal

Require Symphony to fail closed before landing a pull request unless at least one configured approved reviewer bot has actually produced review output on the current PR head. A green CI surface and absence of actionable feedback are not sufficient when configured reviewer bots never reported at all.

## Scope

- add an explicit tracker/config contract for bot-review presence requirements separate from existing actionable bot-feedback detection
- normalize whether configured approved reviewer bots have produced qualifying review output for the current PR head
- block clean-PR lifecycle progression to landing and block guarded landing execution when required bot review presence is missing
- surface the missing-review reason in lifecycle summaries, landing-blocked results, and operator-facing docs
- add unit, integration, and end-to-end coverage for the regression where CI is green but configured bots produced no review output

## Non-goals

- redesigning the broader review loop or replacing `tracker.review_bot_logins`
- requiring approval semantics from GitHub review-state APIs beyond the narrower “bot produced qualifying review output on the current head” contract
- changing `/land` approval protocol or broader guarded-landing mechanics outside this missing-review seam
- introducing non-GitHub tracker-specific review-bot implementations
- adding external persistence, new background jobs, or remote reviewer orchestration

## Current Gaps

- `tracker.review_bot_logins` currently means “authors whose comments/threads count as actionable bot feedback,” not “bots whose review presence is required before landing”
- `src/tracker/pull-request-snapshot.ts` collects actionable bot comments and unresolved review threads, but it does not record positive evidence that any configured reviewer bot reviewed the current head
- `src/tracker/pull-request-policy.ts` treats a PR with green checks and no actionable feedback as ready for `/land`, even if no configured reviewer bot ever emitted output
- `src/tracker/guarded-landing.ts` only blocks on actionable feedback, unresolved human threads, checks, mergeability, and stale `/land`; it cannot fail closed when configured review bots are missing
- README and operator guidance currently describe “green and review-clean” without making explicit that configured bot-review presence is a separate merge precondition

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that configured approved reviewer bots must produce qualifying output on the current PR head before Symphony can treat a PR as landing-ready
  - belongs: define fail-closed behavior when required bot review presence is missing
  - does not belong: GitHub comment pagination, GraphQL field mapping, or merge API transport
- Configuration Layer
  - belongs: add typed workflow config for required approved reviewer bots while preserving the existing actionable-feedback bot list
  - does not belong: PR lifecycle decisions or guarded-landing policy evaluation
- Coordination Layer
  - belongs: consume normalized lifecycle / landing-blocked states and wait rather than landing when required bot review presence is missing
  - does not belong: raw GitHub review/comment parsing
- Execution Layer
  - belongs: no workspace or runner behavior changes in this slice
  - does not belong: review-bot policy or tracker normalization
- Integration Layer
  - belongs: fetch and normalize GitHub-side evidence that configured bots produced review output on the current head; separate that from actionable-feedback parsing
  - does not belong: orchestrator retry policy, operator wording, or workflow parsing
- Observability Layer
  - belongs: explicit summaries, artifacts, and docs that distinguish “no required bot review observed yet” from “review-clean”
  - does not belong: re-deriving required-bot presence from raw GitHub payloads

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts` and `src/config/workflow.ts`
  - add a narrow typed config seam for required approved reviewer bots
- `src/tracker/`
  - extend PR review normalization with qualifying bot-review-presence facts for the current head
  - keep transport, normalization, and policy separate:
    - transport: GitHub review/comment data fetches already needed to inspect bot output
    - normalization: derive per-bot “review observed on current head” facts
    - policy: decide lifecycle / guarded-landing blocking from normalized facts
- `src/tracker/service.ts`
  - extend blocked-landing reasons only as needed for the new fail-closed condition
- `src/orchestrator/`
  - consume the new normalized blocked/waiting state without adding GitHub-specific heuristics
- docs and tests
  - update README/operator wording and add regression coverage

### Does not belong in this issue

- a generic multi-tracker approval framework
- broad lifecycle-domain renaming unrelated to required bot review presence
- runner/workspace/prompt refactors
- GitHub API transport rewrites unrelated to this signal
- broader bot-feedback summarization or prompt trust-boundary changes

## Layering Notes

- `config/workflow`
  - owns the repository-facing list of configured approved reviewer bots
  - does not decide whether a particular PR is ready to land
- `tracker`
  - owns GitHub review/comment normalization and required-bot presence policy
  - must not collapse actionable-feedback detection and required-review-presence detection into one overloaded list or one overloaded boolean
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - waits or records blocked landing based on normalized lifecycle facts
  - must not inspect GitHub review authors or timestamps directly
- `observability`
  - renders normalized missing-bot-review state and landing-blocked reasons
  - must not infer “required review missing” from absence of other signals

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on one policy seam:

1. introduce an explicit config and normalized snapshot field for required approved reviewer bots
2. gate clean-PR lifecycle and guarded landing on that normalized presence check
3. update observability/docs/tests for the new fail-closed reason

Deferred:

- per-bot quorum/threshold configuration beyond “at least one configured approved reviewer bot produced qualifying output”
- tracker-agnostic landing-policy refactors
- richer distinctions between review comment, review thread, and GitHub review-state events if the first slice can stay within current GitHub surfaces

This seam is reviewable because it strengthens one existing landing prerequisite without reopening the full review loop, prompt pipeline, or tracker abstraction stack.

## Runtime State Model

This issue does not add a brand-new top-level lifecycle family, but it does tighten the path from “checks are green” to “landing allowed” by introducing an explicit required-bot-review gate.

### Relevant states

- `awaiting-system-checks`
  - PR checks are absent, pending, or otherwise not terminal green
- `rework-required`
  - actionable bot feedback or failed terminal checks require another coding run
- `awaiting-human-review`
  - human review or required bot-review presence is still outstanding before landing can proceed
- `awaiting-landing-command`
  - PR is clean, required bot-review presence has been satisfied, and Symphony is waiting for `/land`
- `awaiting-landing`
  - `/land` has been observed for the current approved head and guarded landing may execute
- `handoff-ready`
  - merge is observed

### Allowed transitions relevant to this issue

- `awaiting-system-checks` -> `awaiting-human-review`
  - checks are green, but no required bot review output has been observed yet
- `awaiting-system-checks` -> `awaiting-landing-command`
  - checks are green and required bot review output has been observed
- `awaiting-human-review` -> `rework-required`
  - required bot review arrives and is actionable
- `awaiting-human-review` -> `awaiting-landing-command`
  - required bot review arrives and is non-actionable / clean
- `awaiting-landing-command` -> `awaiting-landing`
  - human `/land` approval is observed for the same head after required bot review presence is satisfied
- `awaiting-landing` -> `awaiting-human-review`
  - guarded landing re-check sees the required bot review signal is missing for the current head
- `awaiting-landing` -> `handoff-ready`
  - guarded landing succeeds and merge is observed

### Coordination decision rules

- do not treat “no actionable bot feedback” as equivalent to “required bot review happened”
- when checks are green but required bot review presence is missing, wait in a review-oriented non-landing lifecycle instead of allowing `/land`
- re-evaluate required bot review presence from fresh tracker facts during guarded landing for fail-closed behavior on head changes or flaky/missing bot runs
- keep orchestrator logic tracker-neutral by consuming only normalized lifecycle state and blocked-landing reasons

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Checks green, no configured required bot has produced output on current head | no landing attempt active | required-bot-review presence = missing; actionable feedback count = 0 | remain non-landing; summarize missing bot review |
| Required bot produced non-actionable summary/comment on current head | no landing attempt active | required-bot-review presence = satisfied; actionable feedback count = 0 | allow `awaiting-landing-command` when other gates pass |
| Required bot produced actionable feedback on current head | no landing attempt active | required-bot-review presence = satisfied; actionable feedback count > 0 | enter `rework-required` |
| Required bot reviewed an older head, then Symphony pushed a new head | no landing attempt active or stale `/land` exists | required-bot-review presence = missing for current head | block landing until bot reviews current head again |
| `/land` exists, checks green, but guarded landing re-check finds no required bot review on current head | landing approval recorded | required-bot-review presence = missing | guarded landing returns blocked; lifecycle falls back to waiting for review |
| Required bot list is empty in workflow config | no landing attempt active | no required-bot-review policy configured | preserve current behavior; do not invent a gate |
| Required bot leaves only non-qualifying noise comment/template | no landing attempt active | bot feedback present but qualifying-review-presence = false | keep waiting; do not count noise as required review completion |

## Storage / Persistence Contract

- no new durable store is introduced
- workflow config becomes the source of truth for the optional required approved reviewer bot list
- normalized PR snapshot data remains ephemeral tracker state derived from GitHub facts for the current head
- issue artifacts / landing-blocked events should persist the normalized missing-required-review reason rather than raw bot payloads

## Observability Requirements

- lifecycle summaries must distinguish:
  - actionable bot feedback requiring rework
  - no required bot review observed yet
  - review-clean and ready for `/land`
- guarded-landing blocked results must include an explicit missing-required-bot-review reason
- README and operator docs should say that `/land` is only appropriate after checks are green and configured required bot review has actually appeared on the current head
- tests should prove the visible status/reason for the flaky-no-review failure mode

## Decision Notes

- Keep `tracker.review_bot_logins` for actionable-feedback classification. This issue needs a separate config seam because “bots whose comments count as actionable” and “bots whose presence is required before landing” are related but not identical policy concepts.
- Count review presence only from qualifying output on the current head. Older-head feedback must not satisfy the landing prerequisite after a new commit.
- Prefer reusing already-fetched PR review/comment surfaces when possible. Add transport only if existing review-state data cannot express a stable qualifying signal.

## Implementation Steps

1. Add a new optional workflow/tracker config field for required approved reviewer bot logins and thread it through typed config.
2. Extend PR snapshot normalization to compute:
   - which configured required bots produced qualifying output on the current head
   - whether the required-bot-review gate is satisfied
   - a stable summary/reason surface for missing review presence
3. Update PR lifecycle policy so a green PR with no required bot review presence stays in a review-waiting lifecycle instead of advancing to `awaiting-landing-command`.
4. Extend guarded landing policy and tracker service result types to fail closed when required bot review presence is missing at landing time.
5. Update GitHub tracker landing execution to pass the normalized required-bot-review facts into guarded landing.
6. Update operator-facing docs and any status/report wording that currently equates “review-clean” with “no actionable feedback observed.”
7. Add regression coverage across unit, integration, and e2e layers for:
   - no bot review output
   - non-actionable bot review output that satisfies presence
   - actionable bot review output that triggers rework
   - stale prior-head bot review output after a new commit
8. Run local self-review and repository gates before PR update/open:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- PR snapshot normalization marks qualifying required-bot review presence when a configured bot leaves review output after the current head commit
- PR snapshot normalization ignores stale older-head bot output
- PR snapshot normalization ignores known non-qualifying bot noise/templates for presence
- PR lifecycle policy keeps a green PR in review-waiting state when required bot review presence is missing
- guarded landing rejects when required bot review presence is missing even if checks are green and no actionable feedback exists

### Integration

- `GitHubTracker.inspectIssueHandoff()` returns a non-landing review state for a clean PR with no required bot review output
- `GitHubTracker.inspectIssueHandoff()` returns `awaiting-landing-command` once a configured required bot posts qualifying clean output on the current head
- `GitHubTracker.executeLanding()` returns blocked missing-required-review when the current head lacks qualifying bot review output
- stale required-bot review on an older head no longer satisfies the gate after a new commit

### End-to-end

- factory run opens a PR, CI turns green, configured bots never emit review output, and the issue remains blocked from landing instead of merging
- factory run opens a PR, CI turns green, a configured required bot emits a non-actionable clean review signal on the current head, and the run advances to `awaiting-landing-command`
- after a follow-up push, prior clean bot output becomes stale and the run waits for fresh bot review on the new head

### Acceptance Scenarios

1. BugBot and Devin are configured required reviewer bots, CI is green, neither leaves any review output, and Symphony does not surface the PR as ready to land.
2. BugBot leaves a clean summary comment on the current head, no actionable feedback exists, and Symphony allows `/land`.
3. BugBot reviewed the prior head, Symphony pushes a fix, and landing remains blocked until a configured required bot reviews the new head.
4. A clean PR with checks green and required bot review observed still lands normally once `/land` is posted.

## Exit Criteria

1. Symphony no longer treats “green CI and no actionable feedback” as sufficient when required approved reviewer bots are configured but absent
2. required bot review presence is normalized separately from actionable bot feedback
3. guarded landing fails closed on the current head when required bot review presence is missing
4. lifecycle / operator messaging makes the missing-review state explicit
5. regression coverage exists for the flaky-no-review failure mode and stale-head review presence
6. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- configurable quorum rules such as “all configured bots” or “N of M bots”
- explicit GitHub review-state approval semantics beyond qualifying output presence
- non-GitHub tracker implementations of the same policy
- richer per-bot observability/status surfaces beyond the minimum needed to explain blocked landing
