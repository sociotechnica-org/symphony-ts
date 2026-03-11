# Issue 94 Plan: Await Merged PR Before Completion

## Status

- plan-ready

## Goal

Keep implementation issues non-terminal while their pull request is still open, even if the PR is otherwise clean. Issue completion must require an observed terminal landing event rather than an open merge-ready PR state.

## Scope

- change GitHub PR lifecycle evaluation so an open clean PR does not normalize to terminal completion
- add an explicit non-terminal handoff state for "open and clean but awaiting landing"
- update the orchestrator completion path so open PR handoff states never call `completeIssue()`
- update the status surface so operators can distinguish "awaiting landing" from actual completion
- cover the `#47` / `#92` regression with unit, integration, and bootstrap e2e tests
- update minimal repo docs where the current flow still implies that "merge-ready" is terminal completion

## Non-goals

- implementing automated merge execution or merge gating policy from `#82`
- redesigning the broader PR follow-up loop
- changing manual merge policy or review-bot policy beyond what is required for this regression
- broad tracker abstraction changes outside the GitHub handoff seam needed for this slice
- changing Linear terminal-lifecycle behavior in this issue unless shared status typing requires a narrow compatibility update

## Current Gaps

- `src/tracker/pull-request-policy.ts` currently maps an open PR with no pending checks and no actionable feedback to `handoff-ready`
- `src/orchestrator/service.ts` treats `handoff-ready` as terminal both when refreshing a running issue and when reconciling a successful run
- `src/observability/status.ts` and `src/orchestrator/status-state.ts` do not distinguish "awaiting merge / landing" from "awaiting checks"
- the GitHub mock/e2e flow currently proves the old behavior by closing the issue after the PR becomes clean, even though the PR is still open
- regression coverage does not currently pin the specific `#47` / `#92` failure mode where reopening the issue would immediately re-close it while the PR remains open

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining that issue completion requires a landed PR, not an open clean PR, and documenting the new handoff meaning
  - does not belong: GitHub API response parsing or orchestrator-specific branching details in repo docs
- Configuration Layer
  - belongs: no new runtime configuration in this slice
  - does not belong: landing-state classification logic or status naming policy
- Coordination Layer
  - belongs: orchestrator decisions to wait, rerun, fail, or complete based on normalized handoff lifecycle
  - does not belong: GitHub-specific rules for whether a PR is still open or merged
- Execution Layer
  - belongs: unchanged workspace and runner behavior
  - does not belong: PR landing policy or issue completion rules
- Integration Layer
  - belongs: GitHub-specific normalization from PR open/merged facts plus checks/review state into the handoff lifecycle
  - does not belong: direct issue completion decisions beyond exposing normalized handoff state and explicit completion facts
- Observability Layer
  - belongs: operator-visible status names and summaries that distinguish waiting for landing from terminal completion
  - does not belong: re-deriving GitHub merge state from raw tracker payloads

## Architecture Boundaries

### Belongs in this issue

- `src/domain/handoff.ts`
  - add the new non-terminal lifecycle kind for a clean open PR awaiting landing
- `src/tracker/github-client.ts`
  - expose the minimal PR open/merged fact needed by normalization
- `src/tracker/pull-request-snapshot.ts`
  - carry normalized landing facts alongside existing check/review facts
- `src/tracker/pull-request-policy.ts`
  - classify clean open PRs as awaiting landing rather than terminal
  - classify merged PRs as terminal `handoff-ready`
- `src/tracker/github-bootstrap.ts`
  - keep the orchestrator-facing handoff lifecycle tracker-owned and normalized
- `src/orchestrator/service.ts`
  - only call `completeIssue()` for truly terminal handoff state
- `src/orchestrator/status-state.ts`
  - map the new lifecycle kind into a distinct active issue status
- `src/observability/status.ts`
  - surface the distinct "awaiting landing" status in the status snapshot/rendering
- tests and mock GitHub support needed to observe merged vs still-open PRs
- minimal README wording updates where the lifecycle text still implies that green PRs are terminal

### Does not belong in this issue

- merge execution commands or guarded merge orchestration from `#82`
- mixing GitHub transport, snapshot normalization, and handoff policy in one large module
- changing prompt-template contracts unless a minimal status-string compatibility fix is unavoidable
- broad report-schema redesign beyond a narrow compatibility update if issue artifacts need the new lifecycle name
- Linear workflow redesign beyond shared-type updates required to keep the build green

## Layering Notes

- `config/workflow`
  - remains unchanged in this slice
- `tracker`
  - owns GitHub PR open vs merged normalization and the mapping into handoff lifecycle
  - does not leak raw GitHub `merged_at` or `state` branching into the orchestrator
- `workspace`
  - remains responsible only for branch/workspace lifecycle
- `runner`
  - remains responsible only for agent execution
- `orchestrator`
  - consumes the normalized lifecycle and only completes on truly terminal handoff
  - does not decide whether an open PR is "close enough" to completion
- `observability`
  - renders the lifecycle that the tracker/orchestrator already resolved
  - does not infer merge state independently

## Slice Strategy And PR Seam

This issue should remain one reviewable PR by limiting the change to the existing handoff seam:

1. add a new normalized non-terminal lifecycle for a clean but unmerged PR
2. teach the GitHub tracker to emit that lifecycle only while the PR is still open
3. update orchestrator and status handling to wait on that lifecycle instead of completing
4. add focused regression coverage at unit, integration, and bootstrap e2e layers

This seam is reviewable because it deliberately avoids:

- merge automation
- PR transport redesign
- runner/workspace changes
- tracker-agnostic lifecycle refactors beyond the new shared lifecycle value required here

## Runtime State Model

The orchestrator-facing handoff lifecycle states relevant to this issue are:

- `missing-target`
  - no valid plan-review or PR handoff target exists yet
- `awaiting-human-handoff`
  - waiting for human plan review
- `awaiting-system-checks`
  - a PR exists but checks or human review are still settling
- `actionable-follow-up`
  - another agent run is required
- `awaiting-landing`
  - the PR is open, clean, and ready for humans or other systems to land, but merge has not yet been observed
- `handoff-ready`
  - terminal landing has been observed and the issue may now complete

### Allowed transitions

- `missing-target` -> `awaiting-human-handoff`
  - valid `plan-ready` handoff is posted
- `missing-target` -> `awaiting-system-checks`
  - PR exists and checks/review are still active
- `awaiting-human-handoff` -> `missing-target`
  - review result requires another run
- `awaiting-system-checks` -> `actionable-follow-up`
  - checks fail with no pending checks left, or actionable bot feedback appears
- `awaiting-system-checks` -> `awaiting-landing`
  - PR is open, checks are clean, and no actionable feedback remains
- `actionable-follow-up` -> `awaiting-system-checks`
  - follow-up run pushes new work and checks/review resume
- `actionable-follow-up` -> `awaiting-landing`
  - follow-up run resolves blockers and returns to an open clean PR
- `awaiting-landing` -> `handoff-ready`
  - the tracker observes a merged or otherwise terminally landed PR state
- `handoff-ready` -> terminal completion
  - orchestrator closes the issue and records success

### Runtime decision rules

- wait on `awaiting-human-handoff`
- wait on `awaiting-system-checks`
- wait on `awaiting-landing`
- rerun on `actionable-follow-up`
- fail on `missing-target` after a successful run still leaves no valid handoff target
- complete only on `handoff-ready`

## Failure-Class Matrix

| Observed condition                                                    | Local facts available   | Normalized tracker facts available                                | Expected decision                                                                                              |
| --------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Successful run finishes with no PR                                    | workspace branch exists | `missing-target`                                                  | fail / retry under existing missing-target behavior                                                            |
| PR exists with pending checks                                         | no runner active        | `awaiting-system-checks`                                          | wait                                                                                                           |
| PR exists with failing checks and no pending checks                   | no runner active        | `actionable-follow-up`                                            | rerun with follow-up budget                                                                                    |
| PR exists with unresolved actionable bot feedback                     | no runner active        | `actionable-follow-up`                                            | rerun with follow-up budget                                                                                    |
| PR exists, all checks green, no actionable feedback, `mergedAt: null` | no runner active        | `awaiting-landing`                                                | wait and keep issue open/running                                                                               |
| Issue is reopened while the same clean PR remains open                | no runner active        | `awaiting-landing`                                                | do not immediately re-close; keep issue visible as waiting for landing                                         |
| PR merge is observed after prior `awaiting-landing`                   | no runner active        | `handoff-ready`                                                   | complete issue                                                                                                 |
| PR is closed without merge and no replacement PR exists               | no runner active        | `missing-target` or equivalent tracker-owned non-terminal absence | use existing missing-target failure/retry path unless a narrower resolution rule emerges during implementation |

## Storage / Persistence Contract

- no new durable store is introduced
- the tracker remains the source of truth for whether the PR is still open or has merged
- status snapshots and issue artifacts should record the new lifecycle/status name when an issue is waiting for landing
- any compatibility translation required for existing artifact/status readers should stay explicit and local

## Observability Requirements

- the machine-readable status snapshot must expose a distinct active-issue status for waiting on landing
- terminal rendering should make that state visibly different from both `awaiting-system-checks` and actual completion
- lifecycle summaries should say that the PR is awaiting merge / landing rather than "merge-ready" when it is still open
- if issue artifacts persist lifecycle summaries or statuses, they should preserve the new state without pretending the issue succeeded

## Implementation Steps

1. Add the new shared handoff lifecycle kind and corresponding active-issue status.
2. Extend GitHub PR transport/normalization to carry whether the PR is still open or already merged.
3. Update PR lifecycle policy so:
   - clean open PR -> `awaiting-landing`
   - merged PR -> `handoff-ready`
   - existing pending/failure/follow-up behavior remains intact
4. Update orchestrator handling so `awaiting-landing` is treated as a blocking wait state, never a completion path.
5. Update status rendering and any issue-artifact/status helpers that need to surface the new state cleanly.
6. Extend the mock GitHub server so tests can keep a PR open, then mark it merged later.
7. Add regression coverage for the open-clean-PR case and the reopened-issue case.
8. Update minimal docs that still imply green/open PRs are terminal completion.
9. Run repo gates and self-review before opening the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main`

## Tests And Acceptance Scenarios

### Unit

- `evaluatePullRequestLifecycle()` returns `awaiting-landing` for an open PR with no pending checks, no failing checks, and no actionable feedback
- `evaluatePullRequestLifecycle()` returns `handoff-ready` only when the PR has been observed as merged
- orchestrator tests prove that `awaiting-landing` does not call `completeIssue()` and leaves the issue active in the status surface
- status rendering tests show the distinct `awaiting-landing` label

### Integration

- GitHub bootstrap tracker reports `awaiting-landing` for an open clean PR
- GitHub bootstrap tracker reports `handoff-ready` after the same PR is marked merged
- calling `completeIssue()` is not part of the open-clean-PR path anymore
- reopening an issue with the same still-open clean PR does not produce immediate re-completion on the next inspection

### End-to-end

- bootstrap factory leaves the issue open and `symphony:running` after a successful run opens a PR and all checks become green while the PR is still open
- bootstrap factory reports the active issue as `awaiting-landing`
- after the mock server marks the PR merged, the next poll completes the issue
- reopening the regression case remains non-terminal until merge is observed

### Acceptance Scenarios

1. An implementation run opens PR `#92`, its checks are green, and the issue remains open because the PR is still open.
2. The factory status surface shows the issue as waiting for landing rather than completed.
3. The PR later merges, and only then does the orchestrator post the success comment and close the issue.
4. Reopening issue `#47` while PR `#92` remains open no longer causes immediate auto-closure.

## Exit Criteria

- an open clean PR no longer normalizes to terminal `handoff-ready`
- the orchestrator no longer closes issues while their PR is still open
- the status surface distinguishes waiting for landing from completion
- the `#47` / `#92` regression is covered in unit, integration, and e2e tests
- the change remains one reviewable PR without pulling in merge-automation scope from `#82`

## Deferred To Later Issues Or PRs

- automated or guarded merge execution from `#82`
- broader landing-policy automation for non-GitHub trackers
- richer terminal-resolution handling for closed-unmerged PRs if a separate policy slice is needed
- any larger renaming of prompt or artifact vocabulary beyond what is required for this fix

## Decision Notes

- This issue intentionally introduces a new non-terminal lifecycle value instead of overloading `awaiting-system-checks`, because the repo requires the status surface to distinguish "awaiting merge / landing" from "checks still in flight."
- Terminal completion remains represented as `handoff-ready` so the current orchestrator completion contract stays narrow: only the tracker decides when landing is truly terminal.
- GitHub-specific merge facts stay in tracker transport/normalization and do not become orchestrator policy branches.

## Revision Log

- 2026-03-11: Initial draft created for issue `#94`.
- 2026-03-11: Promoted to `plan-ready` and prepared for issue-thread review handoff.
