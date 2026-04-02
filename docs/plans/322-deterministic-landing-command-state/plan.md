# Issue 322 Plan: Deterministic Landing Command State

## Goal

Make the current pull request command state deterministic so successive operator wake-up cycles do not post duplicate `/land` comments on the same PR when landing has already been requested for the current head.

## Scope

- Tighten GitHub pull request comment normalization so tracker state can reliably tell whether the current head already has a qualifying `/land` command.
- Keep `inspectIssueHandoff()` authoritative for the landing-command vs awaiting-landing distinction across wake-ups.
- Add coverage for the reproduced duplicate-command posture: same PR head, `/land` already present, merge not yet observed, next inspection must remain `awaiting-landing`.

## Non-goals

- No redesign of guarded landing execution or merge dispatch.
- No operator prompt/policy rewrite beyond consuming the corrected tracker state.
- No new durable local memory for operator wake-ups.
- No changes to plan-review, review-thread, or check-state semantics outside the landing-command seam.

## Current Gaps

- The operator loop treats tracker handoff state as the system of record when deciding whether a PR still needs `/land`.
- The GitHub tracker already carries `landingCommand` on the normalized pull request lifecycle, but the current command-observation rule can still leave a PR in `awaiting-landing-command` after a prior `/land` comment should have advanced it.
- When that happens on a later wake-up with the same PR head still open, the operator sees the same landing-eligible posture again and posts a duplicate `/land`.
- The bug should be fixed by tightening tracker-owned comment normalization and lifecycle evaluation, not by adding in-memory operator suppression.

## Spec Alignment By Abstraction Level

- Policy Layer
  - Belongs: the repo-owned rule that one qualifying current-head `/land` comment suppresses further landing commands until the head changes or merge is observed.
  - Does not belong: transport-specific GraphQL pagination or GitHub author-shape parsing details.
- Configuration Layer
  - Belongs: none in this slice.
  - Does not belong: new workflow knobs for landing-command interpretation.
- Coordination Layer
  - Belongs: consuming normalized lifecycle state deterministically across wake-ups.
  - Does not belong: bespoke operator-side duplicate-command memory or counters.
- Execution Layer
  - Belongs: none in this slice.
  - Does not belong: runner or workspace changes.
- Integration Layer
  - Belongs: normalizing current-head PR comments into a stable landing-command observation and preserving the separation between GitHub transport, snapshot normalization, and lifecycle policy.
  - Does not belong: operator prompt policy or orchestrator retry logic.
- Observability Layer
  - Belongs: preserving correct `awaiting-landing-command` vs `awaiting-landing` status/summaries once normalization is fixed.
  - Does not belong: a broader status/TUI redesign.

## Layer Map

- Policy Layer: `WORKFLOW.md`, issue plan, and checked-in operator guidance continue to say that `/land` is explicit and tracker-driven.
- Configuration Layer: untouched.
- Coordination Layer: the operator/orchestrator continue to read lifecycle facts; they should not gain local duplicate-suppression state.
- Execution Layer: untouched.
- Integration Layer: `src/tracker/github-client.ts`, `src/tracker/pull-request-snapshot.ts`, and `src/tracker/pull-request-policy.ts` own the fix.
- Observability Layer: existing status and artifact flows should reflect the corrected lifecycle without new contracts.

## Architecture Boundaries

- Keep GitHub transport concerns in `src/tracker/github-client.ts`.
- Keep current-head comment interpretation in `src/tracker/pull-request-snapshot.ts` or a focused helper under `src/tracker/`.
- Keep the lifecycle transition between `awaiting-landing-command` and `awaiting-landing` in `src/tracker/pull-request-policy.ts`.
- Do not push GitHub-specific author/comment heuristics into the orchestrator, operator state files, or guarded landing execution.
- Do not mix this fix with unrelated review, retry, mergeability, or operator-session work.

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one narrow seam: GitHub landing-command normalization for the current PR head.

What lands in this PR:

1. A tighter normalized rule for when a current-head `/land` comment counts as an already-issued landing command.
2. Lifecycle tests proving the tracker remains in `awaiting-landing` on subsequent inspections once that command exists.
3. Integration coverage for the wake-up regression on the same open PR head.

What is deferred:

- Any broader operator-loop heuristics for review/landing automation.
- Any redesign of who is authorized to land beyond the minimal normalization needed to make tracker state deterministic.
- Any new observability surface specifically for PR command provenance.

Why this seam is reviewable:

- The bug is visible because tracker state is wrong across wake-ups.
- The repo already models landing state in normalized tracker lifecycle types.
- Fixing that boundary does not require changing the operator loop contract or landing executor.

## Runtime State Model

This issue changes tracker-owned handoff interpretation for a stateful landing path, so the current PR-head command state must stay explicit.

States in scope:

- `awaiting-landing-command`
  - Open PR, current head is otherwise landable, and no qualifying current-head `/land` command has been observed.
- `awaiting-landing`
  - Open PR, a qualifying current-head `/land` command has been observed, and merge is still pending.
- `handoff-ready`
  - Merge has been observed.
- `awaiting-system-checks` / `awaiting-human-review` / `rework-required` / `degraded-review-infrastructure`
  - Existing non-landable gates remain unchanged and continue to supersede landing-command readiness.

Allowed transitions in scope:

1. clean current head, no qualifying command -> `awaiting-landing-command`
2. clean current head, qualifying command observed -> `awaiting-landing`
3. `awaiting-landing` with same head and no merge yet -> stay `awaiting-landing`
4. `awaiting-landing` with a new head commit that invalidates prior command scope -> reevaluate current-head comments and, if none qualify after the new head, return to `awaiting-landing-command`
5. `awaiting-landing` -> `handoff-ready` once merge is observed
6. any landing-wait state -> existing blocked review/check/rework states when tracker facts on the current head are no longer landable

State ownership rule:

- Tracker state, derived from the current PR head plus current-head comments, is the only source of truth for whether `/land` has already been issued.
- No local operator memory, retry counter, or wake-up-local cache should be required to suppress duplicates.

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Open PR, same head, no qualifying `/land` comment | no local landing memory required | `landingCommand: null`, all other landing gates satisfied | return `awaiting-landing-command` |
| Open PR, same head, qualifying `/land` already present | no local landing memory required | `landingCommand` observed for current head | return `awaiting-landing`; do not solicit another `/land` |
| Open PR, new head after an older `/land` | no local landing memory required | prior command is stale for the new head | reevaluate on current-head comments only; if none qualify, return `awaiting-landing-command` |
| Open PR, same head, prior `/land` present, merge blocked by checks/review/mergeability | no local landing memory required | current head no longer landable | return the existing blocked lifecycle (`awaiting-system-checks`, `awaiting-human-review`, `rework-required`, or `degraded-review-infrastructure`) |
| PR merged after `/land` | no local landing memory required | merged lifecycle facts | return `handoff-ready` |
| PR comment looks like `/land` but does not satisfy the qualifying-command rule | no local landing memory required | comment present but not accepted as landing command | remain `awaiting-landing-command` |

## Storage / Persistence Contract

- No new local persistence is introduced.
- The durable source of truth remains the tracker:
  - current PR head SHA / commit time
  - current-head PR issue comments
  - normalized `landingCommand` on the handoff lifecycle
- The operator should be able to restart or wake up in a fresh process and derive the same landing-command state from GitHub alone.

## Observability Requirements

- Existing lifecycle summaries must continue to distinguish:
  - `awaiting-landing-command`: still needs `/land`
  - `awaiting-landing`: `/land` was already observed; waiting for merge observation
- Existing issue artifact and status/report logic should continue to consume `landingCommand` without contract changes.
- Tests should pin the user-visible summary for the duplicate-command regression so the status surface does not regress back to soliciting another `/land`.

## Implementation Steps

1. Inspect the current-head PR comment normalization path and isolate the exact qualifying-command rule into a small, testable helper if the existing inline logic is too implicit.
2. Tighten the normalization rule so a prior qualifying `/land` comment on the current head is preserved deterministically in `PullRequestSnapshot`.
3. Keep `evaluatePullRequestLifecycle()` responsible only for mapping normalized command presence into `awaiting-landing-command` vs `awaiting-landing`.
4. Add or extend unit tests for command normalization edge cases and lifecycle mapping.
5. Add GitHub tracker integration coverage that reproduces the same-head, already-commanded PR and proves successive inspections stay in `awaiting-landing`.

## Tests

- `tests/unit/pull-request-snapshot.test.ts`
  - qualifying current-head `/land` comment is recognized for the intended actor shape
  - stale or non-qualifying comments do not count
- `tests/unit/pull-request-policy.test.ts`
  - `hasLandingCommand` continues to map to `awaiting-landing`
- `tests/integration/github-bootstrap.test.ts`
  - same open PR head with prior `/land` remains `awaiting-landing` across repeated inspections
- Repo validation
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Acceptance Scenarios

1. A PR reaches a landable posture with no qualifying current-head command and is reported as `awaiting-landing-command`.
2. After a qualifying `/land` comment is posted on that same head, the next tracker inspection reports `awaiting-landing`.
3. A later wake-up with the same unmerged head still reports `awaiting-landing` instead of reverting to `awaiting-landing-command`.
4. If a new commit lands after `/land`, the prior command no longer counts for the new head and the tracker requires a fresh landing command.
5. Non-qualifying comments that happen to contain `/land` do not suppress the required explicit landing handoff.

## Exit Criteria

- Tracker handoff state alone is sufficient to suppress duplicate `/land` comments across wake-ups for the same PR head.
- The normalized landing-command rule is explicit and covered by unit tests.
- GitHub integration coverage reproduces the same-head duplicate-command posture and passes.
- No new operator-local memory or coordination state is introduced for this bug.

## Deferred To Later Issues Or PRs

- Broader operator-action deduplication for commands other than `/land`
- Additional status/report presentation for PR command provenance
- Any broader authorization policy redesign for who may issue landing commands

## Decision Notes

- The intended fix belongs at the tracker boundary because the operator and orchestrator already treat normalized tracker handoff state as authoritative.
- If the qualifying-command rule needs to recognize more GitHub author shapes than the current implementation, that decision should still be encoded as tracker normalization, not as operator memory.
