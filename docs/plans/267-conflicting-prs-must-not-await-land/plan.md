# Issue 267 Plan: Conflicting PRs Must Not Await `/land`

## Scope

Prevent GitHub PRs with merge conflicts or other non-passing mergeability states from entering `awaiting-landing-command`.

## Non-goals

- No reviewer-app policy redesign.
- No landing execution changes beyond the pre-landing lifecycle gate.
- No new handoff lifecycle kind in this slice.

## Current gap

- `executeLanding()` already blocks non-mergeable PRs.
- `inspectIssueHandoff()` can still classify a PR as `awaiting-landing-command` before a human `/land`, even when GitHub reports `mergeable=false` or `mergeable_state=dirty`.
- That solicits `/land` too early and makes the factory appear merge-ready when it is not.

## Layer map

- Policy: tighten the normalized PR lifecycle gate for merge conflicts.
- Configuration: none.
- Coordination: none.
- Execution: none.
- Integration: carry GitHub mergeability facts into the normalized PR snapshot.
- Observability: status/handoff summaries should explain the mergeability blocker.

## Architecture boundaries

- Keep the fix inside tracker normalization/policy:
  - `src/tracker/pull-request-snapshot.ts`
  - `src/tracker/pull-request-policy.ts`
- Reuse existing lifecycle kinds instead of inventing a new conflict-only lifecycle in this slice.

## Implementation steps

1. Extend normalized PR snapshots to include GitHub mergeability facts needed by lifecycle policy.
2. Update PR lifecycle evaluation so:
   - `mergeable === null` waits for mergeability to settle
   - conflicting / non-passing merge states return a blocked non-landing lifecycle
3. Add unit coverage for conflicting and unknown-mergeability PRs.
4. Add integration coverage for a green-check PR whose merge gate is `dirty`.

## Tests

- `tests/unit/pull-request-policy.test.ts`
- `tests/integration/github-bootstrap.test.ts`
- repo validation:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Acceptance scenarios

1. A PR with green checks and satisfied review state but `mergeable=false` / `mergeable_state=dirty` does not surface `awaiting-landing-command`.
2. A PR whose mergeability is still unknown waits rather than looking landable.
3. Conflicting PRs remain clearly blocked in the status surface.

## Exit criteria

- Conflicting PRs no longer solicit `/land`.
- Tests cover the normalized snapshot + lifecycle path that regressed on `#261`.

## Deferred

- A dedicated lifecycle/status kind for merge conflicts, if we later want something more specific than `rework-required`.
