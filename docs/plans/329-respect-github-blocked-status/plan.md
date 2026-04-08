# Issue 329 Plan: Respect GitHub Blocked Status Before Dispatching Ready Work

## Status

- plan-ready

## Goal

Teach the GitHub tracker adapter to respect GitHub issue Relationship blocking state before returning or claiming `symphony:ready` work, so GitHub-backed workflows do not dispatch issues that GitHub itself still marks as blocked.

The intended outcome of this slice is:

1. GitHub-backed workflows can opt into blocked-relationship enforcement with a repo-owned tracker config switch
2. the GitHub adapter reads GitHub-native blocked/not-blocked facts at the tracker boundary instead of leaking GitHub-specific dependency logic into the orchestrator
3. `fetchReadyIssues()` excludes ready-labeled issues that still have open GitHub blockers
4. `claimIssue()` re-checks the same blocked fact so fetch/claim races do not let blocked work through
5. disabled or omitted config preserves today's label-only behavior exactly

## Scope

This slice covers:

1. adding an optional GitHub tracker config toggle for blocked-relationship enforcement
2. adding GitHub transport support for reading the minimum relationship fact needed for this slice: whether a candidate issue currently has any open blockers
3. normalizing that transport fact into a small GitHub tracker-boundary readiness decision
4. filtering blocked issues out of GitHub ready reads when the toggle is enabled
5. re-checking blocked status inside `claimIssue()` before converting a ready label into a running label
6. focused unit, integration, and docs coverage for enabled, disabled, blocked, unblocked, and fetch/claim race scenarios

## Non-Goals

This slice does not include:

1. orchestrator-native dependency or DAG scheduling
2. tracker-neutral dependency graph modeling across GitHub, Linear, and future Beads adapters
3. changes to operator ready-promotion or `release-state.json`
4. replacing the ready label as the coarse dispatch gate
5. status-surface expansion beyond the minimum logging and test evidence needed to make filtering inspectable
6. broader dependency metadata authoring or synchronization UX

## Current Gaps

Today the GitHub path still trusts labels alone for dispatch eligibility:

1. `GitHubTracker.fetchReadyIssues()` returns every issue with the configured ready label
2. `GitHubTracker.claimIssue()` only checks labels, so an issue that becomes blocked after the ready read can still be claimed
3. `GitHubClient` normalizes issue labels, timestamps, and queue priority, but it does not read GitHub Relationships or blocked state
4. workflow docs expose queue-priority and plan-review GitHub toggles, but there is no repo-owned config switch for blocked-relationship enforcement

## Decision Notes

1. Keep the first usable slice GitHub-specific at the transport boundary. The issue is about honoring a GitHub-owned readiness fact without teaching the orchestrator about GitHub Relationships.
2. Preserve label-first workflow semantics. The ready label remains the coarse gate; blocked status adds a second tracker-owned dispatchability check only when explicitly enabled.
3. Use GitHub GraphQL issue-dependency summary data as the transport source for this slice. It exposes the open-blocker count GitHub already computes, avoids inferring blocked state from ad hoc label conventions, and lets the client batch ready-candidate checks cleanly.
4. Fail closed when the toggle is enabled but blocked-state reads are unavailable or error. Silent fallback would reintroduce the exact dispatch hole this issue is trying to close.
5. Keep transport, normalization, and tracker policy separate. GitHub API details stay in `GitHubClient`; the tracker consumes a normalized blocked-status result and applies the ready/claim policy.
6. Keep the current slice narrow. Adjacent work such as issue `#283` and follow-up dependency normalization can reuse this seam later, but they should not expand this PR into operator or orchestrator changes.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that a GitHub-ready issue is dispatchable only when it has the ready label and no open GitHub blockers, but only when the workflow explicitly enables that rule
2. the rule that claim-time blocked-status rechecks must reject newly blocked work
3. the rule that disabled config preserves today's label-only semantics

Does not belong here:

1. GitHub GraphQL or REST request wiring
2. orchestrator-side GitHub dependency branches
3. operator release-state heuristics

### Configuration Layer

Belongs here:

1. a typed `tracker.respect_blocked_relationships` toggle for GitHub-backed trackers
2. parser-aligned validation and docs that explain the default and enabled behavior

Does not belong here:

1. ad hoc environment-variable-only gates
2. tracker API error recovery logic
3. dependency graph storage

### Coordination Layer

Belongs here:

1. no orchestrator dispatch/retry/reconciliation changes in this slice
2. continued orchestrator reliance on the normalized ready set returned by the tracker

Does not belong here:

1. GitHub Relationship parsing
2. claim-time blocked-status transport calls
3. tracker-specific dependency policy branches

### Execution Layer

Belongs here:

1. no runner or workspace changes in this slice

Does not belong here:

1. dependency enforcement in runner prompts
2. workspace-owned dispatch gating

### Integration Layer

Belongs here:

1. GitHub transport support for reading whether a ready issue has open blockers
2. normalized blocked-status facts at the GitHub adapter boundary
3. ready filtering and claim rechecks that consume those normalized facts

Does not belong here:

1. orchestrator-owned dependency state machines
2. release-state operator policy
3. mixing raw GitHub schema parsing directly into orchestrator code

### Observability Layer

Belongs here:

1. structured logs that identify when a ready issue was filtered or claim-rejected because GitHub marked it blocked
2. tests that make the filtering and race behavior explicit and inspectable

Does not belong here:

1. tracker mutations during status rendering
2. a new UI contract in the same PR unless the implementation exposes a gap that logs/tests cannot cover

## Architecture Boundaries

### `src/domain/workflow.ts` and `src/config/workflow.ts`

Own:

1. the typed GitHub tracker config field and parser validation
2. the default-disabled contract for the new toggle

Do not own:

1. GitHub API calls
2. blocked-status normalization logic
3. ready filtering behavior

### `src/tracker/github-client.ts`

Owns:

1. GitHub transport for reading blocked/not-blocked facts for one or more issue numbers
2. raw GitHub schema details and any small response-shape normalization needed before data leaves the client

Does not own:

1. dispatch policy
2. ready-label mutation policy
3. orchestrator coordination decisions

### `src/tracker/github.ts`

Owns:

1. deciding whether blocked-status enforcement is active for this workflow
2. filtering ready issues based on normalized blocked facts
3. claim-time rechecks that refuse to claim issues that are ready-labeled but currently blocked
4. tracker-scoped logging that explains why an issue was filtered or claim-rejected

Does not own:

1. raw GitHub schema parsing
2. workflow config parsing
3. cross-tracker dependency abstractions beyond this narrow GitHub seam

### Tests and Docs

Own:

1. parser coverage for omitted, disabled, enabled, and malformed config
2. client and tracker coverage for blocked-status reads, ready filtering, and claim races
3. workflow docs and README examples for the new toggle

Do not own:

1. implementation-only recovery behavior that code should define explicitly
2. operator-only release-state instructions unrelated to GitHub tracker dispatch

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one narrow seam:

1. add one GitHub tracker config toggle
2. add one GitHub blocked-status transport/read path
3. consume that fact in `fetchReadyIssues()` and `claimIssue()` only
4. document the toggle and cover the exact enabled/disabled/race scenarios with tests

Deferred from this PR:

1. tracker-neutral dependency contracts shared with Beads or Linear
2. operator ready-promotion changes
3. orchestrator-native dependency scheduling
4. richer observability surfaces for blocked ready work

Why this seam is reviewable:

1. it closes the dispatch-safety bug without broad scheduler churn
2. it preserves the existing tracker/orchestrator boundary
3. it limits code changes to config parsing, GitHub transport, GitHub tracker policy, mock support, and tests/docs

## Tracker Eligibility State Model

This slice does not change the orchestrator runtime state machine, but it does add stateful tracker-boundary readiness enforcement for GitHub.

### State Subject

One GitHub issue carrying the ready label under one workflow configuration.

### States

1. `label-only-ready`
   - the issue has the ready label and blocked-relationship enforcement is disabled
2. `ready-unblocked`
   - the issue has the ready label and blocked-relationship enforcement is enabled, and GitHub reports no open blockers
3. `ready-blocked`
   - the issue has the ready label and blocked-relationship enforcement is enabled, and GitHub reports at least one open blocker
4. `claim-rejected`
   - a claim attempt re-checked the issue and refused to move it to running because the ready label or blocked-status facts no longer permit dispatch
5. `claimed-running`
   - the tracker moved the issue from ready to running

### Allowed Transitions

1. `label-only-ready -> claimed-running`
2. `ready-unblocked -> claimed-running`
3. `ready-unblocked -> ready-blocked`
4. `ready-blocked -> ready-unblocked`
5. `ready-unblocked -> claim-rejected`
6. `ready-blocked -> claim-rejected`
7. `claim-rejected -> ready-unblocked`

### Contract Rules

1. blocked-status filtering happens only when the toggle is enabled
2. when the toggle is enabled, `fetchReadyIssues()` must not surface `ready-blocked` issues
3. when the toggle is enabled, `claimIssue()` must re-check blocked status before applying the label transition
4. if blocked-status data cannot be read while the toggle is enabled, the tracker must fail closed rather than silently dispatch

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Toggle omitted or `false` | issue has ready label | blocked-status contract intentionally inactive | preserve current label-only behavior |
| Toggle enabled, issue has ready label, GitHub reports open blockers | ready label present | `isBlocked = true` | exclude from `fetchReadyIssues()` and log the filter |
| Toggle enabled, issue was unblocked during fetch but becomes blocked before claim | stale fetch result, fresh claim recheck | fresh `isBlocked = true` | `claimIssue()` returns `null` and leaves labels unchanged |
| Toggle enabled, issue clears blockers before claim and still has ready label | stale fetch result, fresh claim recheck | fresh `isBlocked = false` | allow the normal ready -> running claim path |
| Toggle enabled, issue loses the ready label before claim | fresh issue read at claim | label missing regardless of blocked status | `claimIssue()` returns `null` |
| Toggle enabled, blocked-status transport errors or is unsupported | no safe blocked-status fact | blocked-status unavailable | throw a tracker error and fail closed instead of silently dispatching |

## Implementation Steps

1. Extend the GitHub tracker config type and resolver with `respectBlockedRelationships`, defaulting to `false` when omitted.
2. Add parser coverage and workflow-doc examples for omitted, enabled, disabled, and malformed values.
3. Add a focused GitHub client transport method that reads GitHub GraphQL issue-dependency summary facts for issues and returns a normalized per-issue result keyed by issue number.
4. Keep GitHub schema handling inside the client and expose only the minimum normalized result the tracker needs for this slice.
5. Update `GitHubTracker.fetchReadyIssues()` to apply blocked-status filtering only when configured, with structured logs for filtered issues.
6. Update `GitHubTracker.claimIssue()` to re-read the current issue plus a single-issue blocked-status fact and return `null` when the issue is no longer dispatchable.
7. Extend the mock GitHub server support needed by client/tracker tests to represent blocked/unblocked issue-relationship facts.
8. Add unit and integration tests for config parsing, client normalization, ready filtering, disabled behavior, and claim-time race rejection.
9. Update README and the frontmatter reference to document the new toggle and its fail-closed enabled behavior.

## Tests And Acceptance Scenarios

### Unit Tests

1. workflow parsing keeps `respectBlockedRelationships` disabled by default when omitted
2. workflow parsing accepts explicit `true` and `false`
3. workflow parsing fails clearly when `tracker.respect_blocked_relationships` is not a boolean
4. GitHub client normalizes blocked-status transport results into a per-issue blocked fact
5. GitHub client treats zero open blockers as unblocked and one or more open blockers as blocked

### Integration Tests

1. disabled config returns the same ready issue set as today even when the mock server marks a ready issue blocked
2. enabled config filters a blocked ready issue out of `fetchReadyIssues()`
3. enabled config still returns an unblocked ready issue
4. enabled config makes `claimIssue()` return `null` when the issue becomes blocked after the initial ready read
5. enabled config still allows a normal claim when the issue remains unblocked
6. enabled config surfaces a tracker error when blocked-status data cannot be read

### Acceptance Scenarios

1. `respect_blocked_relationships` omitted:
   - a ready-labeled GitHub issue behaves exactly as it does on `main`
2. `respect_blocked_relationships: true`, blocked issue:
   - the issue remains ready-labeled in GitHub but is not dispatchable through Symphony
3. `respect_blocked_relationships: true`, unblocked issue:
   - the issue appears in the ready set and can be claimed normally
4. `respect_blocked_relationships: true`, race between fetch and claim:
   - the issue is visible during one ready read, becomes blocked, and the later claim is refused

## Exit Criteria

1. the new GitHub tracker config toggle is typed, parsed, and documented
2. blocked-status reads stay inside the GitHub transport boundary
3. `GitHubTracker.fetchReadyIssues()` excludes blocked issues when enabled
4. `GitHubTracker.claimIssue()` re-checks blocked status and rejects blocked work without mutating labels
5. disabled config preserves today's behavior
6. unit and integration tests cover the enabled, disabled, blocked, unblocked, and race cases
7. README and workflow reference docs explain the toggle and its default behavior

## Deferred To Later Issues Or PRs

1. promoting GitHub blocked relationships into a tracker-neutral dependency contract
2. sharing the same normalized dependency seam with Beads and Linear
3. richer status/TUI projection of blocked ready work
4. broader dependency-aware scheduling beyond the label-plus-blocked GitHub slice
