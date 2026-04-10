# Issue 354 Plan: Ignore Closed GitHub Blockers During Dependency Enforcement

## Status

- plan-ready

## Goal

Align GitHub blocked-relationship enforcement with GitHub's open-blocker semantics so `tracker.respect_blocked_relationships: true` blocks dispatch only when a ready issue still has one or more non-closed blockers.

The intended outcome of this slice is:

1. GitHub-ready issues blocked only by closed upstream dependencies remain eligible for `fetchReadyIssues()` and `claimIssue()`.
2. GitHub-ready issues with one or more open or unknown-state blockers continue to be filtered or claim-rejected when blocked-relationship enforcement is enabled.
3. The fix stays inside the GitHub tracker policy seam and reuses the normalized `RuntimeIssue.blockedBy` contract from `#337` instead of moving dependency semantics into orchestrator code.
4. Tests cover the exact observed regression from April 9, 2026 plus adjacent mixed-state and claim-race cases.

## Scope

This slice covers:

1. defining the GitHub tracker-side predicate for whether a normalized blocker still counts as dispatch-blocking
2. updating `GitHubTracker.fetchReadyIssues()` to ignore closed blockers when `respectBlockedRelationships` is enabled
3. updating `GitHubTracker.claimIssue()` to apply the same open-blocker predicate during the claim-time recheck
4. tightening tracker logging so blocked ready reads and claim rejections report the count of still-open blockers, not the raw normalized blocker array length
5. adding focused integration and unit coverage for closed-only, mixed open/closed, and claim-race scenarios
6. auditing docs for consistency with the intended "open blockers only" contract and updating wording only if the checked-in docs are ambiguous

## Non-Goals

This slice does not include:

1. changing the normalized `RuntimeIssueBlocker` contract or GitHub transport payloads
2. redesigning dependency normalization across GitHub, Linear, and future Beads trackers
3. orchestrator-native dependency scheduling or DAG-aware dispatch
4. operator `release-state.json` ready-promotion policy
5. tracker mutation APIs for adding or removing GitHub dependencies
6. expanding TUI or prompt/tool surfaces with richer dependency detail

## Current Gaps

Today the normalized dependency contract already carries blocker state, but GitHub dispatch enforcement does not use it precisely enough:

1. [`src/domain/issue.ts`](../../../src/domain/issue.ts) defines `RuntimeIssueBlocker.state`, so tracker policy already has the fact needed to distinguish open versus closed blockers.
2. [`src/tracker/github-client.ts`](../../../src/tracker/github-client.ts) hydrates blocker state from both GraphQL ready reads and REST single-issue reads.
3. [`src/tracker/github.ts`](../../../src/tracker/github.ts) currently treats any non-empty `issue.blockedBy` array as blocking during `fetchReadyIssues()` and `claimIssue()`.
4. Because closed blockers remain present in normalized `blockedBy`, a ready issue with only closed dependencies is incorrectly filtered as blocked.
5. The checked-in docs already describe `respect_blocked_relationships` in terms of open blockers, so the current runtime behavior is narrower than the documented contract.

## Decision Notes

1. Keep this fix in tracker policy, not transport. GitHub transport should continue reporting normalized blocker facts faithfully, including closed blockers, because other consumers may need the full relation list.
2. Treat `state === "closed"` case-insensitively as non-blocking. Any other state, including `null` or an unexpected value, remains blocking so enabled enforcement stays fail-closed.
3. Use one shared helper inside [`src/tracker/github.ts`](../../../src/tracker/github.ts) for fetch-time filtering and claim-time rechecks so the two paths cannot drift again.
4. Preserve current best-effort versus required dependency hydration behavior. This issue narrows how hydrated blockers are interpreted; it does not change transport failure handling.
5. Keep the PR on one reviewable seam: GitHub tracker policy plus tests. No config, orchestrator, or normalization refactor is needed for this regression.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses [`docs/architecture.md`](../../architecture.md).

### Policy Layer

Belongs here:

1. the rule that enabled GitHub dependency enforcement blocks only on non-closed blockers
2. the rule that unknown blocker states remain blocking under enabled enforcement
3. the rule that disabled enforcement still preserves label-only behavior

Does not belong here:

1. GitHub REST or GraphQL schema details
2. orchestrator dispatch queue logic
3. operator release dependency policy

### Configuration Layer

Belongs here:

1. no workflow-schema change in this slice; the existing `respectBlockedRelationships` toggle semantics become accurate in code

Does not belong here:

1. a new config field for blocker-state filtering
2. transport fallback logic
3. tracker logging behavior

### Coordination Layer

Belongs here:

1. no orchestrator state-machine or retry changes in this slice
2. continued reliance on the tracker's normalized ready set

Does not belong here:

1. GitHub blocker-state interpretation
2. claim-time dependency rechecks
3. GitHub-specific dispatch branches

### Execution Layer

Belongs here:

1. no runner or workspace changes in this slice

Does not belong here:

1. blocker enforcement in prompts or runner commands
2. workspace-owned dependency gating

### Integration Layer

Belongs here:

1. GitHub tracker policy that interprets normalized blocker state for ready filtering and claim rechecks
2. tests proving GitHub transport plus tracker policy preserve closed-blocker facts without over-blocking dispatch

Does not belong here:

1. orchestrator-native dependency graphs
2. release promotion coordination
3. observability-specific presentation logic beyond tracker logs

### Observability Layer

Belongs here:

1. logs that report how many still-open blockers caused a filter or claim rejection
2. test evidence for the visible ready-versus-blocked outcome

Does not belong here:

1. new dashboard or TUI surfaces in the same PR
2. tracker mutations triggered by status rendering

## Architecture Boundaries

### [`src/tracker/github.ts`](../../../src/tracker/github.ts)

Owns:

1. the predicate that decides whether normalized GitHub blockers are still dispatch-blocking
2. applying that predicate in `fetchReadyIssues()` and `claimIssue()`
3. tracker-scoped logs for blocked ready reads and blocked claim attempts

Does not own:

1. raw GitHub dependency transport
2. the `RuntimeIssueBlocker` type definition
3. orchestrator scheduling or retry state

### [`src/tracker/github-client.ts`](../../../src/tracker/github-client.ts)

Owns:

1. reading normalized blocker facts, including blocker `state`
2. preserving the full blocker list even when some blockers are already closed

Does not own:

1. deciding whether a closed blocker should still block dispatch
2. workflow toggle evaluation
3. ready-label mutation policy

### Tests

Primary coverage belongs in:

1. [`tests/integration/github-bootstrap.test.ts`](../../../tests/integration/github-bootstrap.test.ts) for ready filtering and claim rechecks against the mock GitHub server
2. [`tests/unit/github-client.test.ts`](../../../tests/unit/github-client.test.ts) only if transport assertions need to pin that closed blockers are still hydrated into the normalized contract

Tests do not own:

1. new production-only policy abstractions that code should state directly
2. broad orchestrator regressions unrelated to tracker enforcement

## Slice Strategy And PR Seam

This issue fits in one reviewable PR by staying on one narrow seam:

1. keep GitHub transport unchanged
2. change only the GitHub tracker policy that interprets normalized blockers
3. add the smallest tests needed to prove closed blockers no longer suppress ready work

Deferred from this PR:

1. tracker-neutral helper extraction shared across GitHub and Linear
2. richer dependency observability surfaces
3. operator or orchestrator dependency-aware scheduling

Why this seam is reviewable:

1. it fixes a concrete regression without reopening the broader dependency-contract work from `#337`
2. it preserves transport, normalization, and policy boundaries
3. it keeps the diff centered on one tracker adapter and its tests

## Tracker Eligibility State Model

This slice does not change the orchestrator runtime state machine, but it does refine GitHub tracker eligibility when blocked enforcement is enabled.

### State Subject

One GitHub issue carrying the ready label under one workflow where `respectBlockedRelationships` is enabled.

### States

1. `ready-no-blockers`
   - `blockedBy` is empty
2. `ready-closed-only-blockers`
   - `blockedBy` is non-empty, but every blocker state is closed
3. `ready-open-blockers`
   - at least one blocker state is open, null, or otherwise not recognized as closed
4. `claim-rejected`
   - a claim-time recheck observed `ready-open-blockers` and refused to mutate labels
5. `claimed-running`
   - the tracker moved the issue from ready to running

### Allowed Transitions

1. `ready-no-blockers -> claimed-running`
2. `ready-closed-only-blockers -> claimed-running`
3. `ready-no-blockers -> ready-open-blockers`
4. `ready-closed-only-blockers -> ready-open-blockers`
5. `ready-open-blockers -> ready-closed-only-blockers`
6. `ready-open-blockers -> ready-no-blockers`
7. `ready-open-blockers -> claim-rejected`

### Invariants

1. closed blockers remain visible in normalized issue data even when they no longer block dispatch
2. fetch-time and claim-time GitHub enforcement must use the same open-blocker predicate
3. enabled enforcement must fail closed for unknown blocker state values rather than silently treating them as closed

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Ready issue has only closed blockers | ready label present | `blockedBy.length > 0`, every blocker `state` is `closed` | keep issue eligible for `fetchReadyIssues()` and `claimIssue()` |
| Ready issue has mixed closed and open blockers | ready label present | at least one blocker `state` is open | filter from ready reads and reject claim attempts |
| Ready issue has a blocker with `null` or unknown state | ready label present | blocker list present, state not known closed | fail closed; treat as blocking |
| Ready read saw only closed blockers, later claim sees an open blocker | stale ready read, fresh claim read | fresh `blockedBy` contains an open blocker | `claimIssue()` returns `null` and leaves labels unchanged |
| Dependency hydration is required but unavailable | no safe transport fallback | no trustworthy blocker state facts | throw the existing dependency-support error; do not silently allow dispatch |

## Implementation Steps

1. Add a small private helper in [`src/tracker/github.ts`](../../../src/tracker/github.ts) that filters normalized blockers down to the still-dispatch-blocking subset.
2. Update `fetchReadyIssues()` to return issues whose blocking subset is empty, even when `blockedBy` still contains closed blockers.
3. Update `claimIssue()` to reuse the same helper for claim-time rechecks and for log payloads.
4. Add integration coverage for:
   - closed-only blockers staying ready
   - mixed open and closed blockers still blocking
   - a claim-time transition from closed-only blockers to an open blocker
5. Extend or retain client coverage proving blocker state remains hydrated as-is, including closed blockers, so the policy seam stays explicit.
6. Audit README and workflow reference wording; update only if the checked-in docs do not already clearly say "open blockers."

## Tests And Acceptance Scenarios

### Unit / Contract Coverage

1. keep GitHub client coverage that normalized blocker state includes both open and closed blockers
2. add a focused tracker-policy assertion path if the helper benefits from direct unit coverage without bootstrapping the full tracker flow

### Integration Coverage

1. `respect_blocked_relationships: true`, closed-only blocker:
   - `fetchReadyIssues()` returns the ready issue
   - `claimIssue()` succeeds and leaves `blockedBy` visible on the returned issue
2. `respect_blocked_relationships: true`, mixed blocker states:
   - `fetchReadyIssues()` filters the issue out
   - `claimIssue()` returns `null`
3. `respect_blocked_relationships: true`, race from closed-only to open blocker:
   - initial ready read returns the issue
   - later claim recheck returns `null` and does not mutate labels
4. `respect_blocked_relationships: false`, closed blockers:
   - existing label-only behavior remains unchanged

### Named Acceptance Scenario

1. Reproduce the Alexandria-style case:
   - issue `#296` equivalent is labeled ready
   - issue `#295` equivalent appears in `blockedBy` but is already closed
   - Symphony still reports the downstream issue as ready and claimable

## Exit Criteria

1. GitHub blocked-relationship enforcement ignores closed blockers while continuing to block open or unknown blockers
2. fetch-time and claim-time enforcement use the same predicate and produce consistent outcomes
3. integration tests cover the closed-only regression and at least one mixed-state blocking case
4. the build-standard checks for touched code paths pass locally
5. any doc wording around `respect_blocked_relationships` matches the actual behavior

## Deferred To Later Issues Or PRs

1. shared dependency-policy helpers beyond the GitHub tracker
2. richer dependency state surfaced in status, prompt context, or tools
3. orchestrator-native dependency ordering
4. broader review of whether other tracker consumers should collapse closed blockers differently for non-dispatch use cases
