# Issue 356 Plan: Draft PR Landability Reconciliation

## Status

plan-ready

## Goal

Ensure restart recovery and operator-facing status surfaces never treat a draft or otherwise non-landable GitHub pull request as `awaiting-landing-command`.

## Scope

- Carry GitHub draft status into the normalized pull-request snapshot used by handoff policy.
- Tighten GitHub pull-request lifecycle policy so `awaiting-landing-command` only appears for PRs that are currently landable under repo policy.
- Preserve the existing restart-recovery coordination seam, but prove it reconciles against the corrected normalized lifecycle before surfacing an inherited running issue as the active blocker.
- Add regression coverage for operator control/status artifacts so blocked-policy draft PRs stop surfacing as pending `/land` work.

## Non-goals

- No new handoff lifecycle kind in this slice.
- No redesign of guarded landing itself beyond keeping its policy consistent with handoff policy.
- No operator loop state-machine rewrite or renaming of the top-level `acting` state.
- No tracker transport refactor beyond the narrow snapshot fact needed for lifecycle policy.
- No broader repository-specific eval-gate modeling in the orchestrator.

## Current Gaps

1. `createPullRequestSnapshot()` already detects mergeability facts but does not preserve `draft`, so `evaluatePullRequestLifecycle()` cannot distinguish draft PRs from genuinely landable PRs.
2. `inspectIssueHandoff()` therefore can emit `awaiting-landing-command` for a draft PR, even though the documented GitHub landing contract requires a non-draft PR.
3. Restart recovery treats any non-`missing-target` lifecycle as a suppress-rerun handoff checkpoint, so a misclassified draft PR is preserved as an active landing blocker after restart.
4. Operator control/action surfaces derive pending `/land` work from active issues in `awaiting-landing-command`, so the same bad lifecycle propagates into operator wake-up status and makes blocked-policy rechecks look like pending landing work.

## Spec Alignment By Abstraction Level

- Policy Layer
  - Belongs here: the rule that `/land` solicitation only applies to PRs that satisfy the repository-owned GitHub landing contract, including non-draft state.
  - Does not belong here: tracker transport parsing details or operator loop status mechanics.
- Configuration Layer
  - Belongs here: nothing in this slice.
  - Does not belong here: introducing a new workflow flag for draft handling.
- Coordination Layer
  - Belongs here: restart recovery continuing to consume normalized handoff lifecycles without GitHub-specific draft checks in orchestrator code.
  - Does not belong here: compensating for missing tracker normalization by adding draft-specific restart-recovery branches.
- Execution Layer
  - Belongs here: nothing in this slice.
  - Does not belong here: runner or workspace changes.
- Integration Layer
  - Belongs here: normalizing GitHub PR `draft` into the internal snapshot and applying it in GitHub pull-request lifecycle policy.
  - Does not belong here: operator status interpretation or restart-recovery persistence logic.
- Observability Layer
  - Belongs here: status and control surfaces reflecting the corrected lifecycle without inventing separate draft-only artifacts.
  - Does not belong here: re-implementing GitHub landability policy in renderers.

## Architecture Boundaries

- Keep the GitHub-specific fact and lifecycle decision at the tracker edge:
  - `src/tracker/pull-request-snapshot.ts`
  - `src/tracker/pull-request-policy.ts`
  - `src/tracker/github.ts` only as needed to keep guarded landing and handoff snapshot facts aligned
- Keep restart recovery generic:
  - `src/orchestrator/restart-recovery.ts`
  - `src/orchestrator/restart-recovery-coordinator.ts`
  - no draft-specific logic should be added here unless tests prove the normalized lifecycle seam is insufficient
- Keep operator behavior derived from status/control state:
  - `src/observability/operator-control-state.ts`
  - avoid baking GitHub draft checks directly into operator control candidate selection

## Slice Strategy And PR Seam

This issue should land as one reviewable PR focused on the GitHub handoff-policy seam plus regression coverage in the consuming coordination/observability surfaces.

What lands in this PR:

1. GitHub PR snapshot and lifecycle policy gain the missing `draft` fact and stop advertising `awaiting-landing-command` for draft PRs.
2. Restart-recovery tests prove inherited running issues reconcile to the corrected lifecycle and no longer surface the landing-command lane for draft PRs.
3. Operator control/status tests prove draft-blocked PRs stop producing pending `/land` work.

What is deferred:

- any dedicated lifecycle such as `awaiting-pr-undraft` or `landing-policy-blocked`
- any broader operator headline-state redesign beyond the corrected action/control posture
- any repo-specific non-draft landability gates beyond the existing normalized GitHub facts already available in tracker policy

Why this seam is reviewable:

- one tracker-policy correction
- one coordination consumer proof
- one observability consumer proof

This avoids mixing tracker transport refactors, orchestrator state-machine redesign, and operator runtime-state redesign in the same patch.

## Runtime State Model

This issue changes stateful orchestration behavior only through the normalized handoff lifecycle consumed by restart recovery and operator control.

Relevant normalized lifecycle states for this slice:

1. `missing-target`
2. `awaiting-system-checks`
3. `awaiting-human-review`
4. `degraded-review-infrastructure`
5. `rework-required`
6. `awaiting-landing-command`
7. `awaiting-landing`
8. `handoff-ready`

Required invariants:

1. `awaiting-landing-command` is only legal when the PR is open, non-draft, mergeable, in a passing merge state, free of actionable review blockers, and satisfies required reviewer coverage.
2. Draft PRs must map to a non-landing lifecycle before restart recovery or operator control consumes the handoff result.
3. Restart recovery continues to suppress reruns for handoff lifecycles, but the preserved lifecycle must be the latest normalized tracker result rather than a stale locally remembered landing posture.

Allowed state transitions for the narrow regression:

- `awaiting-landing-command` -> `rework-required` when GitHub now reports `draft: true`
- `awaiting-landing-command` -> `awaiting-system-checks` when mergeability or required-review facts are no longer settled
- restart recovery `suppressed-terminal` remains valid, but the associated lifecycle kind must match the refreshed tracker lifecycle
- operator control action candidates disappear when the active issue lifecycle leaves `awaiting-landing-command`

## Failure-Class Matrix

| Observed condition                                             | Local facts available                     | Normalized tracker facts available                                         | Expected decision                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory restarts with stale lease and draft PR on issue branch | stale or missing local owner facts        | PR is open, `draft: true`, other review/check facts may be green           | restart recovery suppresses rerun against refreshed lifecycle, but active issue/status surface as non-landing lifecycle rather than `awaiting-landing-command` |
| Operator wake-up inspects active issue whose PR is draft       | active issue status snapshot from factory | control-state refresh sees no `awaiting-landing-command` issue for that PR | no pending `/land` action candidate; operator control posture reflects the actual checkpoint instead of landing work                                           |
| PR becomes draft after previously being landable               | no special local facts required           | refreshed handoff snapshot flips from non-draft to draft                   | tracker lifecycle leaves `awaiting-landing-command` immediately on next refresh                                                                                |
| PR is non-draft but mergeability still unknown                 | no special local facts required           | `mergeable: null`                                                          | keep `awaiting-system-checks`; do not advertise `/land`                                                                                                        |
| PR is non-draft but blocked by failing review/check policy     | no special local facts required           | failing checks, actionable feedback, or missing required reviewer state    | preserve existing non-landing lifecycle (`rework-required`, `awaiting-human-review`, `degraded-review-infrastructure`, or `awaiting-system-checks`)            |

## Storage / Persistence Contract

- No schema change is required for issue artifacts or restart-recovery snapshots.
- Existing persisted `issue.json` / status snapshots can continue storing lifecycle outcomes by string.
- The correctness change is that newly refreshed lifecycles and newly written snapshots must no longer emit `awaiting-landing-command` for draft PRs.

## Observability Requirements

- Factory status active-issue snapshots must show the corrected non-landing lifecycle after restart recovery.
- Restart-recovery issue summaries should continue to describe `suppressed-terminal`, but with the corrected lifecycle kind.
- Operator control/action derivation must stop surfacing `/land` work for draft PRs once the factory status no longer reports `awaiting-landing-command`.
- User-facing summaries should explain the blocker in terms of draft or non-landable PR state rather than ambiguous landing readiness.

## Implementation Steps

1. Extend `PullRequestSnapshot` to carry `draft`.
2. Update `createPullRequestSnapshot()` to normalize GitHub `draft` consistently for handoff policy callers.
3. Update `evaluatePullRequestLifecycle()` so draft PRs cannot return `awaiting-landing-command`; prefer an existing blocked lifecycle and summary that matches repo policy.
4. Keep `evaluateGuardedLanding()` and handoff policy aligned so landing preflight and handoff classification do not disagree about draft PRs.
5. Add unit coverage for the new lifecycle decision.
6. Add GitHub integration coverage for `inspectIssueHandoff()` on a draft PR that would otherwise look landable.
7. Add restart-recovery coverage showing an inherited running issue with a draft PR is preserved under the corrected non-landing lifecycle.
8. Add operator control/status coverage showing the corrected lifecycle no longer generates a pending `/land` action candidate.

## Tests

- `tests/unit/pull-request-policy.test.ts`
- `tests/integration/github-bootstrap.test.ts`
- `tests/unit/restart-recovery.test.ts` and/or `tests/unit/restart-recovery-coordinator.test.ts`
- `tests/e2e/bootstrap-factory.test.ts` if the restart-recovery status proof is clearer end-to-end
- `tests/unit/operator-control-state.test.ts` or `tests/integration/operator-loop.test.ts`, depending on the narrowest existing seam for action-candidate regression
- repo validation:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Acceptance Scenarios

1. A draft GitHub PR with green checks and otherwise satisfied review state does not surface `awaiting-landing-command`.
2. Restart recovery for an inherited `symphony:running` issue with a draft PR preserves the refreshed non-landing lifecycle instead of the landing-command lane.
3. Factory status no longer shows the draft PR as the active landing blocker after restart recovery.
4. Operator control/status no longer surfaces pending `/land` work for that issue.
5. Non-draft clean PRs still reach `awaiting-landing-command` unchanged.

## Exit Criteria

- GitHub handoff policy and guarded landing agree that draft PRs are not landable.
- Restart recovery consumes the corrected lifecycle without new draft-specific orchestration branches.
- Operator control/action surfaces stop treating draft PRs as pending landing work.
- Regression tests cover tracker policy, restart recovery, and operator-facing status/control evidence for the draft-PR scenario.

## Deferred To Later Issues Or PRs

- A more specific lifecycle for intentionally blocked-but-open PRs if operators need a clearer lane than `rework-required` or another existing status.
- Any general operator-loop headline-state redesign that distinguishes “evaluating blocked policy” from “acting”.
- Any repository-specific modeling of eval rerun requirements beyond the normalized GitHub facts currently available.

## Decision Notes

1. Prefer fixing the tracker normalization/policy seam over adding draft-specific restart-recovery or operator exceptions. That keeps GitHub policy at the integration edge and avoids duplicating landability rules downstream.
2. Reuse an existing non-landing lifecycle in this slice unless implementation shows the current set cannot express the blocked draft state clearly enough. A new lifecycle kind would widen the review surface across status renderers, artifacts, and downstream consumers.
