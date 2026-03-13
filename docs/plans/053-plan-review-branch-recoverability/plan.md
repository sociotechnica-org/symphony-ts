# Issue 53 Plan: Push Plan-Review Branches And Recover Reviewed Plans From GitHub

## Status

`plan-ready`

## Goal

Make the plan-review handoff recoverable from the canonical GitHub tracker plus repository by ensuring the reviewed `plan.md` is committed and pushed on the issue branch before the worker posts the `plan-ready` comment, and by making that comment point directly at the branch and file under review.

## Scope

1. update the worker-facing plan-review handoff contract so the branch is pushed before the `plan-ready` comment is posted
2. require the reviewed `plan.md` to be committed on the pushed issue branch before review is requested
3. extend the canonical `plan-ready` comment shape to include the branch name, a direct GitHub link to the reviewed `plan.md`, and the small set of direct inspection links needed for GitHub review
4. keep the tracker-side plan-review lifecycle compatible with the explicit review marker protocol from `#48`
5. add automated coverage that proves the reviewed plan artifact is recoverable from GitHub without relying on local uncommitted workspace state

## Non-goals

1. changing the `awaiting-plan-review` / `awaiting-human-handoff` runtime semantics from `#42`
2. replacing issue comments as the current human review surface
3. inventing a Beads-native plan review UX
4. broadening this issue into generic branch publication rules for all worker handoffs

## Current Gaps

1. the current worker instructions tell the agent to create `docs/plans/<issue>/plan.md` and ask for review, but they do not require that plan file to be committed and pushed first
2. the current `plan-ready` comment contract includes the plan path and reply templates, but it does not include branch identity or direct GitHub file links
3. the GitHub bootstrap runtime can reconstruct the review decision state from issue comments, but the reviewed plan artifact may still exist only in a local uncommitted workspace
4. current tests cover waiting/resume semantics for plan review, but they do not prove the reviewed plan can be recovered from the remote branch after local workspace loss

## Spec / Layer Mapping

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction-level mapping in `docs/architecture.md`.

- Policy Layer
  - Belongs here: the repository-owned requirement that `plan-ready` means "plan committed, branch pushed, links included, then comment posted".
  - Does not belong here: GitHub API calls, branch detection, or parser code.
- Configuration Layer
  - Belongs here: no schema changes are expected.
  - Does not belong here: hiding this behavior behind a new config flag; the recoverability rule is repo-owned workflow policy, not optional runtime configuration.
- Coordination Layer
  - Belongs here: no state-machine redesign; existing waiting semantics stay intact.
  - Does not belong here: new retry or reconciliation states for plan review.
- Execution Layer
  - Belongs here: the worker-run contract that the branch push and committed `plan.md` happen before the plan-review handoff is emitted.
  - Does not belong here: tracker parsing of issue comment metadata.
- Integration Layer
  - Belongs here: tracker-edge tolerance for the richer `plan-ready` comment body and any focused parsing helper needed to keep recoverability metadata legible and testable.
  - Does not belong here: orchestrator policy branching on raw GitHub comment text.
- Observability Layer
  - Belongs here: issue-thread links that make the reviewed branch and file inspectable, plus any status/report enrichment that uses normalized handoff metadata if needed.
  - Does not belong here: making observability a prerequisite for the core recovery behavior.

## Architecture Boundaries

### Belongs in this issue

1. `WORKFLOW.md`, `README.md`, `AGENTS.md`, and `skills/symphony-plan/SKILL.md` updates that make the push-before-comment rule explicit
2. a focused helper for formatting and, if useful for tests/reports, parsing the richer `plan-ready` handoff metadata
3. GitHub bootstrap tests that verify richer `plan-ready` comments remain compatible with existing lifecycle detection
4. end-to-end coverage that the reviewed `plan.md` exists on the pushed issue branch and can be recovered without relying on the original local workspace

### Does not belong in this issue

1. changing how approvals, waivers, or changes-requested replies are detected
2. redesigning pull request creation or CI/review follow-up handling
3. tracker-neutral handoff lifecycle refactors such as `#50`
4. new durable local state stores for plans outside the repo and tracker

## Slice Strategy And PR Seam

This issue should stay in one reviewable PR with one seam: make the existing GitHub issue-comment review station recoverable by pushing the reviewed plan artifact to the issue branch before the handoff comment is posted.

The PR should land in three tightly related slices within that seam:

1. policy and workflow contract updates for the worker
2. small supporting code/tests that keep the richer comment body compatible with the tracker edge
3. one end-to-end recoverability scenario proving a fresh clone/fetch can recover the reviewed plan artifact from GitHub

This stays reviewable because it avoids changing the underlying waiting-state semantics, PR lifecycle logic, or tracker abstraction model.

## Runtime State Model

This issue intentionally preserves the existing plan-review lifecycle from `#42` and `#48`.

### States in play

1. `missing-target`
2. `awaiting-human-handoff`
3. decision comments: `approved`, `changes-requested`, `waived`

### Allowed transitions relevant here

1. worker commits `plan.md`, pushes branch, posts enriched `Plan status: plan-ready` comment -> `awaiting-human-handoff`
2. `awaiting-human-handoff` + `Plan review: approved` -> rerun for implementation
3. `awaiting-human-handoff` + `Plan review: waived` -> rerun for implementation without waiting
4. `awaiting-human-handoff` + `Plan review: changes-requested` -> rerun to revise the plan, then post a fresh enriched `plan-ready` handoff

### Explicit non-transition

1. this issue must not add a new orchestration state for "branch pushed" or "plan published"; those are preconditions of the existing `plan-ready` handoff, not separate lifecycle states

## Failure-Class Matrix

| Observed condition                                                                    | Local facts available                               | Canonical tracker/repo facts available                                                                                   | Expected decision                                                                                                           |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Worker wrote `plan.md` locally but did not commit or push it                          | local file exists, branch may be ahead only locally | no remote branch update, no remote plan file                                                                             | invalid handoff; worker contract must prevent posting `plan-ready` in this state                                            |
| Worker committed and pushed `plan.md`, then posted enriched `plan-ready` comment      | local workspace exists                              | issue comment shows branch + plan link, remote branch contains `plan.md`                                                 | valid `awaiting-human-handoff`                                                                                              |
| Fresh factory starts with no prior local workspace                                    | no local workspace                                  | issue comment shows `plan-ready`; remote branch contains `plan.md`                                                       | factory can fetch/clone branch and recover reviewed plan artifact                                                           |
| Human requests changes after a recoverable plan-ready handoff                         | local workspace may be gone                         | review reply exists on issue; remote branch still contains prior reviewed plan                                           | rerun from tracker state, revise plan on same branch, push updated plan, post fresh enriched `plan-ready`                   |
| Latest comment is legacy or malformed plan-ready body without recoverability metadata | local workspace unknown                             | tracker can still detect waiting state if marker is valid, but review artifact may not be inspectable from comment alone | preserve backward compatibility for detection, but require richer metadata in current worker contract and cover it in tests |

## Storage / Persistence Contract

The reviewed plan artifact must be durable in the canonical repo state, not just local workspace state.

1. canonical workflow state remains the issue comment thread
2. canonical reviewed artifact becomes the committed `docs/plans/<issue>/plan.md` on the pushed issue branch
3. the `plan-ready` comment must carry enough direct GitHub metadata to inspect that artifact without local shell access:
   - branch name
   - repo-relative plan path
   - GitHub file URL for `plan.md` on that branch
   - direct branch inspection URL, and if needed a compare or tree URL that makes review practical in the browser
4. no new local persistence mechanism should be introduced for this slice

## Observability Requirements

1. the issue thread should make the reviewed branch and plan file obvious to a human reviewer
2. tracker-side plan-review detection must remain stable with the richer comment body
3. if code introduces normalized plan-review metadata, it should stay at the tracker/observability edge rather than leaking into orchestrator policy

## Implementation Steps

1. add a small plan-review handoff formatter/helper that defines the enriched `plan-ready` comment shape, including branch and GitHub links
2. update `WORKFLOW.md`, `README.md`, `AGENTS.md`, and `skills/symphony-plan/SKILL.md` so workers must:
   - commit the reviewed `plan.md`
   - push the issue branch
   - verify the branch/file is inspectable on GitHub
   - only then post the `plan-ready` comment
3. keep `parsePlanReviewSignal` and GitHub tracker lifecycle detection compatible with the richer comment body; add parsing support only if needed for normalized metadata or report/status use
4. add unit coverage for the richer `plan-ready` comment shape and for any formatting/parsing helper introduced
5. add integration coverage that a richer `plan-ready` comment still yields `awaiting-human-handoff`
6. add an end-to-end GitHub bootstrap test where the worker:
   - creates `docs/plans/.../plan.md`
   - commits and pushes the branch without opening a PR
   - posts the enriched `plan-ready` comment
   - leaves the issue in `awaiting-human-handoff`
   - proves the reviewed `plan.md` is recoverable from the remote branch after local workspace loss or from a fresh clone/fetch

## Tests And Acceptance Scenarios

### Unit

1. richer `plan-ready` comment formatter emits branch name, plan path, and GitHub plan URL
2. existing marker parsing still recognizes `Plan status: plan-ready` when the body includes extra metadata blocks

### Integration

1. GitHub bootstrap tracker reports `awaiting-human-handoff` for the enriched `plan-ready` comment body
2. any tracker-edge metadata helper remains compatible with the existing acknowledgement flow from `#48`

### End-to-end

1. a worker stops at plan review after committing and pushing `docs/plans/<issue>/plan.md`
2. the issue thread contains the enriched `plan-ready` comment with direct GitHub links
3. the remote issue branch contains the reviewed `plan.md`
4. after deleting the original local workspace or using a fresh clone/fetch, the reviewed `plan.md` can still be read from the pushed branch

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review command is available

## Exit Criteria

1. the checked-in worker contract explicitly requires pushing the issue branch before posting `plan-ready`
2. the checked-in worker contract explicitly requires the reviewed `plan.md` to exist on the pushed branch before review is requested
3. the canonical `plan-ready` comment includes branch identity and a direct GitHub file link to the reviewed plan
4. GitHub bootstrap lifecycle detection remains compatible with the enriched comment body
5. automated coverage proves a fresh factory can recover the reviewed `plan.md` from GitHub without depending on local uncommitted workspace state

## Deferred Work

1. tracker-neutral recovery contracts for non-GitHub backends
2. richer status/report surfaces that display reviewed plan metadata beyond the issue thread
3. any runtime enforcement stronger than the worker contract for arbitrary manual agent behavior

## Decision Notes

1. This slice should prefer the existing worker contract plus end-to-end proof over a large new runtime enforcement mechanism. The current factory already relies on the worker to push implementation commits and open PRs; this issue tightens that same contract for the plan-review handoff.
2. If recoverability metadata needs code support, keep it in a focused helper at the tracker edge. Do not spread GitHub URL construction and parsing rules across orchestrator code.
3. Backward compatibility for older `plan-ready` comments should be preserved for lifecycle detection, but the current checked-in protocol should be stricter and recoverability-oriented.

## Revision Log

- 2026-03-13: Initial draft created for issue `#53`.
