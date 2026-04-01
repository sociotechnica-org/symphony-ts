# Issue 303 Plan: Fix self-hosted operator ready promotion without shell-level `SYMPHONY_REPO`

## Status

- plan-ready

## Goal

Make the checked-in self-hosting workflow fully deterministic for the operator ready-promotion path so `pnpm operator ... --workflow WORKFLOW.md` does not depend on `SYMPHONY_REPO` being exported in the shell.

The intended outcome of this slice is:

1. the repo-owned self-hosting `WORKFLOW.md` explicitly identifies `sociotechnica-org/symphony-ts` as its GitHub tracker target
2. operator ready promotion can load the checked-in workflow without ambient shell state
3. generic GitHub workflow validation remains strict for third-party or hand-written workflows that omit `tracker.repo`
4. repo-owned tests fail if the checked-in self-hosting workflow drifts back to an implicit repo contract

## Scope

This slice covers:

1. restoring an explicit `tracker.repo` value in the checked-in root `WORKFLOW.md`
2. aligning self-hosting docs with that explicit checked-in contract
3. adding focused regression coverage at the repo-owned contract boundary so the self-hosted ready-promotion path no longer relies on `SYMPHONY_REPO`

## Non-Goals

This slice does not include:

1. adding a new generic fallback that infers `tracker.repo` from local git remotes
2. weakening workflow validation for third-party instances or hand-written GitHub workflows
3. changing ready-promotion policy, release-state evaluation, or GitHub label synchronization behavior
4. redesigning `WORKFLOW.md` templating or third-party onboarding
5. changing orchestrator dispatch, retries, leases, or handoff-state semantics

## Current Gaps

Today the repo-owned self-hosting contract is inconsistent:

1. the checked-in root `WORKFLOW.md` leaves `tracker.repo` blank even though the self-hosting docs say it should target `sociotechnica-org/symphony-ts`
2. `bin/promote-operator-ready-issues.ts` loads the full workflow because it needs the GitHub tracker config, so the ready-promotion path fails before it can evaluate release state when `SYMPHONY_REPO` is unset
3. existing ready-promotion tests use temp workflows that already contain `tracker.repo`, so they do not guard the checked-in self-hosting contract itself

## Decision Notes

1. Fix the repo-owned self-hosting contract instead of adding a self-hosted-only code fallback. The root `WORKFLOW.md` is the canonical runtime contract for this repository, so the smallest durable repair is to make it explicit again.
2. Keep `loadWorkflow` strict for GitHub-backed workflows. Third-party instances should still have to declare `tracker.repo` in `WORKFLOW.md` or intentionally provide `SYMPHONY_REPO`.
3. Cover the regression at the checked-in contract boundary. A repo-owned contract test is the right seam to catch this drift because the failure came from the repository's own `WORKFLOW.md`, not from the generic parser behavior.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the checked-in self-hosting workflow contract should explicitly name the tracker repo it owns
2. the repo's self-hosting docs should describe the same explicit contract

Does not belong here:

1. hidden shell assumptions about `SYMPHONY_REPO`
2. a second out-of-band source of truth for the self-hosted tracker target

### Configuration Layer

Belongs here:

1. preserving the existing rule that GitHub-backed workflows require `tracker.repo` unless an explicit env override is provided
2. validating that the checked-in self-hosting workflow satisfies that rule without ambient env state

Does not belong here:

1. a new generic repo-autodetection heuristic
2. special parser branches that only mask one checked-in workflow mistake

### Coordination Layer

Belongs here:

1. no coordination changes in this slice

Does not belong here:

1. any retry, reconciliation, or runtime-state changes to work around missing config

### Execution Layer

Belongs here:

1. validating the operator ready-promotion command against the explicit self-hosting contract

Does not belong here:

1. runner changes
2. workspace changes
3. operator-loop sequencing changes

### Integration Layer

Belongs here:

1. reusing the existing GitHub tracker config/load path without modification once the self-hosting workflow is explicit

Does not belong here:

1. tracker transport changes
2. label-sync policy changes
3. fallback tracker-repo inference from git metadata

### Observability Layer

Belongs here:

1. regression coverage that proves the ready-promotion surface no longer depends on shell-only state
2. docs/tests that keep the self-hosted operator contract inspectable

Does not belong here:

1. runtime status-surface changes
2. new operator-local state artifacts

## Architecture Boundaries

### `WORKFLOW.md`

Owns:

1. the repository-owned self-hosting tracker target
2. the worker/runtime contract for this repo's local instance

Does not own:

1. third-party workflow defaults
2. fallback inference rules

### `README.md` and `docs/guides/self-hosting-loop.md`

Owns:

1. operator-facing explanation of the checked-in self-hosting contract
2. explicit wording that the root workflow already names the tracker repo

Does not own:

1. the only enforcement of runtime correctness
2. parser behavior changes

### contract / regression tests

Owns:

1. proving the checked-in self-hosting workflow names `sociotechnica-org/symphony-ts`
2. proving the repo-owned ready-promotion path can be exercised without `SYMPHONY_REPO`

Does not own:

1. broad end-to-end release-policy coverage that already belongs to existing ready-promotion tests
2. live-network self-hosting validation against GitHub

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one narrow seam:

1. restore the explicit tracker repo in the checked-in self-hosting workflow
2. align the self-hosting docs with that contract
3. add contract/regression tests that lock the self-hosted ready-promotion path to the explicit workflow instead of shell env

Deferred from this PR:

1. any generic auto-detection of tracker repo from git config or remotes
2. any broader cleanup of workflow validation rules
3. any ready-promotion policy or operator-loop behavior changes beyond the config-contract fix

Why this seam is reviewable:

1. it closes the observed regression without changing generic workflow parsing rules
2. it keeps policy/config contract work separate from tracker transport or operator state logic
3. it uses repo-owned tests to prevent recurrence at the exact boundary that drifted

## Runtime State Model

No orchestrator or operator runtime state machine changes are planned in this slice.

Existing ready-promotion states (`unconfigured`, `blocked-review-needed`, `labels-synchronized`, `sync-failed`) remain unchanged. The fix is to ensure the repo-owned self-hosting workflow reaches that existing path without a preflight config error caused by an implicit tracker target.

## Failure-Class Matrix

| Observed condition                                                              | Local facts available            | Normalized tracker/config facts available                          | Expected decision                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Checked-in self-hosting `WORKFLOW.md`, `SYMPHONY_REPO` unset                    | repo-owned root workflow content | explicit `tracker.repo: sociotechnica-org/symphony-ts` in workflow | ready-promotion config load succeeds and continues into the existing promotion flow |
| Third-party or temp GitHub workflow omits `tracker.repo`, `SYMPHONY_REPO` unset | workflow content only            | no tracker repo                                                    | keep current `ConfigError`; do not weaken generic validation                        |
| `SYMPHONY_REPO` is intentionally set for a GitHub workflow                      | workflow plus env                | explicit env override                                              | preserve current override behavior                                                  |
| Checked-in self-hosting workflow drifts back to an empty `tracker.repo`         | repo-owned workflow file         | missing tracker repo in the checked-in contract                    | repo-owned regression test fails before the drift reaches operator runtime          |

## Observability Requirements

1. the checked-in contract should be inspectable directly in `WORKFLOW.md`
2. a repo-owned test should make the self-hosting tracker target explicit and non-accidental
3. the ready-promotion regression should be covered without requiring a developer to remember a shell export

## Implementation Steps

1. Update the checked-in root `WORKFLOW.md` so `tracker.repo` explicitly points to `sociotechnica-org/symphony-ts`.
2. Align `README.md` and `docs/guides/self-hosting-loop.md` with that explicit self-hosting contract and keep third-party guidance unchanged.
3. Add a repo-owned contract/regression test that reads the checked-in `WORKFLOW.md` with `SYMPHONY_REPO` unset and proves the self-hosting contract names the tracker repo explicitly.
4. Add any focused ready-promotion/operator-path regression coverage needed to demonstrate the command can load the self-hosting workflow without a shell export.
5. Run the relevant local checks, open/update the PR, and complete the review/CI loop.

## Tests And Acceptance Scenarios

### Unit / Contract Tests

1. a repo-owned contract test asserts the checked-in `WORKFLOW.md` contains `tracker.repo: sociotechnica-org/symphony-ts`
2. a workflow-loading regression test with `SYMPHONY_REPO` unset confirms the checked-in self-hosting workflow resolves a GitHub tracker repo successfully
3. existing workflow tests still prove that generic GitHub workflows without `tracker.repo` continue to fail clearly

### Integration Tests

1. a focused ready-promotion/operator-path regression test proves the command path no longer needs `SYMPHONY_REPO` when the workflow itself is explicit

### Acceptance Scenarios

1. Given the checked-in self-hosting `WORKFLOW.md`, when an operator runs `pnpm operator -- --workflow WORKFLOW.md ...` without exporting `SYMPHONY_REPO`, then the ready-promotion preflight no longer fails on `tracker.repo`.
2. Given a third-party GitHub workflow that still omits `tracker.repo`, when `SYMPHONY_REPO` is unset, then Symphony still raises the existing configuration error instead of guessing.

## Exit Criteria

1. the checked-in self-hosting workflow explicitly names `sociotechnica-org/symphony-ts`
2. the self-hosted operator ready-promotion path no longer requires shell-level `SYMPHONY_REPO`
3. repo-owned tests guard the explicit self-hosting contract
4. generic GitHub workflow validation remains strict

## Deferred To Later Issues Or PRs

1. generic tracker-repo inference for hand-written workflows
2. any broader self-hosting workflow-template redesign
3. any operator-loop or ready-promotion policy changes unrelated to the missing checked-in tracker repo
