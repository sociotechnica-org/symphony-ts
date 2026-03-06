# Phase 1.2 Technical Plan: Make the Factory Own PR Lifecycle and Review Loop

## Goal

Extend the Phase 1 runtime so a claimed issue remains under Symphony control until its pull request is truly merge-ready, not merely opened.

For issue `#16`, "merge-ready" means:

- a PR exists for the issue branch
- all observed PR checks have reached a terminal successful state
- required review bots have reached terminal state because they surface as PR checks
- unresolved, non-outdated review threads are zero
- no newer actionable automated review feedback remains on the PR after the latest Symphony follow-up

## Scope

Required outcomes for issue `#16`:

1. add explicit PR lifecycle state to the normalized runtime model
2. teach the tracker to locate the active PR for an issue branch and refresh its CI/review state
3. keep issues in an in-flight PR stage after PR creation instead of closing them immediately
4. let the orchestrator revisit the same running issue branch when CI fails or review feedback appears
5. explicitly resolve addressed review threads after a successful follow-up run
6. extend tests and the e2e harness to cover the full post-PR loop

## Current Gaps

Today the runtime still behaves like a Phase 0 handoff:

- `GitHubBootstrapTracker.completeRun()` only checks whether a PR exists for the branch
- the tracker closes the issue immediately after the first successful run with a PR
- the orchestrator only polls `symphony:ready` issues and has no post-PR continuation loop
- the runtime state does not distinguish "implementation complete" from "PR review in progress"
- the mock GitHub server does not model PR checks, review threads, or review thread resolution

## Design Direction

### 1. Add a normalized PR lifecycle model

Introduce explicit runtime types for:

- active PR identity
- aggregate check status
- actionable review feedback
- PR lifecycle state such as `missing`, `awaiting-review`, `needs-follow-up`, and `ready`

The orchestrator should consume these normalized states rather than GitHub-specific payloads.

### 2. Keep the issue running until the PR is merge-ready

After the first successful implementation run:

- if no PR exists, treat the run as failed
- if a PR exists but checks/review are still pending, keep the issue labeled `symphony:running`
- only close the issue and post the success comment once the PR lifecycle state is `ready`

This makes "PR opened" an intermediate state instead of terminal success.

### 3. Add tracker support for PR lifecycle refresh

Extend the GitHub tracker to:

- list currently running issues in addition to ready issues
- find the PR attached to an issue branch
- inspect check results for the PR head
- inspect unresolved, non-outdated review threads
- inspect actionable automated review comments posted after the latest Symphony commit
- resolve review threads after Symphony pushes a follow-up fix

The GitHub-specific policy lives in the tracker; the orchestrator only reacts to normalized lifecycle state.

### 4. Extend orchestration for post-PR continuation

Update the orchestrator loop so it:

- continues polling claimed/running issues
- refreshes PR lifecycle state for those issues
- waits when the PR is still pending external checks/review
- re-enters the existing workspace and reruns the agent when CI or review feedback is actionable
- completes the issue only when the tracker reports the PR as merge-ready

### 5. Expand prompt context for follow-up work

The prompt builder should receive PR lifecycle context so follow-up runs can see:

- PR URL and branch
- failing or pending checks
- unresolved actionable review feedback

That keeps prompt construction at the workflow boundary while making follow-up runs concrete.

## Implementation Plan

### 1. Domain and service contracts

Add domain types for PR lifecycle and update service contracts so the orchestrator can:

- fetch ready issues
- fetch running issues
- refresh PR lifecycle state for an issue branch
- finalize a merge-ready issue
- resolve addressed review feedback after successful follow-up runs

### 2. GitHub tracker implementation

Update `src/tracker/github-bootstrap.ts` to:

- keep issue completion separate from "PR exists"
- query PR, check, and review-thread state from GitHub
- normalize that data into lifecycle state
- close the issue only after the PR is clean

### 3. Orchestrator behavior

Refactor `src/orchestrator/service.ts` and runtime state so:

- ready issues still start at implementation attempt `1`
- running issues are refreshed each poll for PR lifecycle state
- only issues with actionable follow-up work are rerun
- pending-only PRs are observed without unnecessary reruns
- the orchestrator consumes normalized handoff state only and does not embed
  GitHub-specific PR/check heuristics

### 3.1 Architecture correction

During implementation review, two boundary corrections were identified and are
now part of this issue's scope:

- no-check stabilization policy must live in tracker normalization rather than
  orchestrator heuristics
- post-run review resolution must stay behind the tracker contract rather than
  exposing raw review-thread mutations to the orchestrator

### 4. Mock and test harness

Extend the mock GitHub server and fixture `gh` shim so tests can model:

- PR creation
- check states transitioning through pending, failure, and success
- unresolved review threads
- post-fix review thread resolution
- PR becoming merge-ready only after follow-up work

### 5. Validation and docs

Update README / workflow documentation to describe the new lifecycle and validate with:

- unit tests for orchestrator decisions
- integration tests for GitHub tracker PR lifecycle inspection
- e2e tests for PR-open, CI-fail, review-feedback, follow-up-push, and merge-ready paths

## Risks

### GitHub API complexity

Review thread resolution and lifecycle inspection are easier through GraphQL than the REST endpoints already in use. Keep the GraphQL usage narrowly scoped to PR review state so the tracker remains understandable.

### Over-triggering follow-up runs

The orchestrator must not rerun the agent simply because a PR exists. It should only rerun when checks fail or actionable feedback exists.

### Mock fidelity

The e2e harness must model the PR lifecycle closely enough that it tests the actual control flow rather than a toy shortcut.

## Exit Criteria

This issue is complete when:

1. the runtime models PR lifecycle explicitly
2. the tracker can refresh active PR, checks, and review state for a running issue branch
3. the orchestrator keeps working a single issue through PR follow-up until merge-ready
4. tests cover the post-PR CI/review loop
5. the self-hosting flow no longer treats "PR opened" as completion
