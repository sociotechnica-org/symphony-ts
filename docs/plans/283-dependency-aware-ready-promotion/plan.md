# Issue 283 Plan: Dependency-Aware Ready Promotion For Release DAG Execution

## Status

- plan-ready

## Goal

Add a minimal, dependency-aware ready promoter so GitHub label-driven execution cannot advance a planned release DAG out of order. The first slice should compute ready eligibility from canonical release dependency metadata plus normalized issue outcomes, then synchronize the GitHub `symphony:ready` label only for tickets that are currently eligible to run.

The intended outcome of this slice is:

1. release dependency metadata has one canonical machine-readable source for this workflow
2. ready eligibility is computed from normalized prerequisite outcome facts instead of ad hoc label state
3. GitHub ready labels are added only to eligible downstream leaves and removed from ineligible tickets
4. prerequisite failure prevents downstream ready promotion
5. the promoter is inspectable through tests and operator-facing status, not only prompt text

## Scope

This slice covers:

1. extending the existing operator-owned release dependency seam from `#281` into a concrete ready-promotion mechanism
2. a normalized dependency eligibility policy that reads canonical prerequisite/downstream mappings and current issue outcome facts
3. GitHub tracker operations needed to read the current open issue label surface and synchronize `symphony:ready` for a bounded set of release-managed tickets
4. a one-shot promoter entry point that the operator workflow can run before ordinary queue advancement
5. focused unit, integration, and end-to-end coverage for prerequisite success/failure and label synchronization

## Non-Goals

This slice does not include:

1. replacing the orchestrator ready queue with a DAG-aware scheduler
2. new `WORKFLOW.md` syntax for release graphs
3. broad GitHub issue-body parsing as the canonical dependency source
4. Linear or Beads write-path implementation beyond defining a tracker-neutral eligibility seam
5. release planning UX for authoring dependency metadata
6. automatic recovery or rerun of failed prerequisite work

## Current Gaps

Today the repo has only the first half of the release-dependency protection:

1. `src/observability/operator-release-state.ts` stores canonical prerequisite/downstream metadata and can block downstream advancement after a prerequisite failure, but it does not compute which open tickets should actually carry `symphony:ready`
2. the factory still dispatches purely from tracker labels, so a downstream issue that already has `symphony:ready` can run even when the release DAG says it should be blocked
3. `RuntimeIssue` does not yet carry a normalized dependency contract, so GitHub and future trackers do not share a clear eligibility-policy input
4. the operator workflow warns “do not promote downstream tickets,” but there is no repo-owned promoter that performs the add/remove label synchronization

## Decision Notes

1. Keep the first usable slice operator-owned. The regression is about label-driven GitHub execution violating release sequencing; a promoter that keeps labels correct is the smallest fix that protects the existing orchestrator without reopening core dispatch logic.
2. Reuse `.ralph/instances/<instance-key>/release-state.json` as the canonical dependency source for this slice. That state already exists, is typed, and is inspectable; the promoter should consume it instead of inventing a second release graph source.
3. Introduce a tracker-neutral eligibility policy module even though GitHub is the only write target in this PR. The eligibility contract should accept normalized dependency relationships and issue outcomes so Beads can reuse the policy later.
4. Keep GitHub transport, dependency normalization, and promotion policy separated. The GitHub client should do label reads/writes only; a dedicated policy module should decide eligibility and desired label mutations.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that a ticket is ready only when every configured prerequisite has terminal-success outcome
2. the rule that prerequisite failure removes downstream ready eligibility
3. the rule that only eligible leaves in the configured release graph should carry `symphony:ready`

Does not belong here:

1. GitHub REST request details
2. shell-only promotion heuristics
3. hidden notebook conventions that tests cannot inspect

### Configuration Layer

Belongs here:

1. typed loading of the selected instance paths so the promoter can find canonical `release-state.json`
2. any narrow workflow/operator wiring needed to invoke the promoter for the selected instance

Does not belong here:

1. new workflow-frontmatter release-DAG authoring semantics in this slice
2. storing dependency truth only in prompt text or local shell variables

### Coordination Layer

Belongs here:

1. no orchestrator dispatch/retry/reconciliation changes in this slice
2. a narrow operator-owned promotion state model that is explicit about when label sync may run or must fail closed

Does not belong here:

1. pushing release dependency policy into orchestrator retry or lease state
2. silently teaching the ready queue to infer missing dependency state

### Execution Layer

Belongs here:

1. a one-shot promoter command or helper invoked by the operator workflow
2. bounded label synchronization execution against the selected GitHub tracker

Does not belong here:

1. runner changes
2. workspace changes
3. long-running promotion daemons or background schedulers

### Integration Layer

Belongs here:

1. normalized dependency/eligibility inputs derived from canonical release-state metadata and normalized issue outcome facts
2. GitHub tracker operations that read current open issue labels and apply ready-label mutations
3. tracker-neutral policy boundaries so future adapters can reuse the same eligibility logic

Does not belong here:

1. mixing GitHub transport logic into operator shell scripts
2. coupling future tracker support to GitHub-specific label semantics
3. parsing raw tracker payloads directly inside promotion policy

### Observability Layer

Belongs here:

1. inspectable promotion results and summaries tied to the canonical release-state seam
2. status output that shows whether promotion ran, was blocked, or changed ready labels
3. tests that make the ready-promotion decision surface explicit

Does not belong here:

1. mutating tracker state while rendering status
2. a second release graph source separate from `release-state.json`

## Architecture Boundaries

### `src/observability/operator-release-state.ts`

Owns:

1. the canonical release dependency configuration and evaluated blocked/clear posture
2. any small extension needed to expose promotion-related facts in typed state

Does not own:

1. GitHub label API calls
2. raw tracker reads
3. orchestration scheduling logic

### new release readiness policy module

Owns:

1. normalized dependency graph evaluation for ready eligibility
2. determination of eligible issue numbers and desired add/remove ready-label mutations
3. fail-closed behavior when dependency metadata or prerequisite facts are incomplete

Does not own:

1. tracker transport
2. operator prompt wording
3. shell command orchestration

### GitHub tracker client/service seam

Owns:

1. reading current issue label state for relevant open issues
2. applying label mutations determined by the policy layer
3. preserving the existing ready/running/failed transport contract

Does not own:

1. dependency graph evaluation
2. release-state persistence
3. operator sequencing rules

### operator command / workflow wiring

Owns:

1. invoking promotion at the correct checkpoint before ordinary queue advancement
2. surfacing whether the promoter ran successfully or failed closed

Does not own:

1. the only definition of eligibility policy
2. ad hoc JSON parsing or label diff logic in shell
3. GitHub-specific business rules beyond calling the typed promoter entry point

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one narrow seam:

1. promote GitHub ready labels from the existing operator-owned release graph instead of rewriting orchestrator dispatch
2. add a tracker-neutral dependency eligibility policy module plus the minimum GitHub read/write support it needs
3. wire that promoter into the operator checkpoint that already inspects release-state before queue advancement
4. add focused tests for prerequisite failure, prerequisite success, and label removal/addition

Deferred from this PR:

1. orchestrator-native DAG dispatch or claim gating
2. new repository authoring UX for release dependencies
3. generalized non-GitHub write support
4. broader release-portfolio management beyond one selected instance/release graph

Why this seam is reviewable:

1. it closes the real regression without broad scheduler churn
2. it reuses the already-landed release-state source of truth
3. it keeps transport, policy, and operator workflow changes separated and inspectable

## Ready Promotion State Model

This slice does not alter the orchestrator runtime state machine, but it does add stateful operator-side promotion behavior. The promoter therefore needs an explicit state model.

### State Subject

One promoter evaluation is keyed by selected instance and current release-state configuration. It combines:

1. canonical dependency metadata from `release-state.json`
2. normalized issue outcome facts from stored issue artifacts
3. current GitHub open-issue label state for release-managed tickets
4. the computed ready-label mutation set

### States

1. `unconfigured`
   - no release dependency metadata exists; no label sync is attempted
2. `blocked-review-needed`
   - dependency metadata or required issue facts are incomplete; promotion fails closed and applies no mutations
3. `eligible-set-computed`
   - dependency metadata is complete and the promoter has computed the exact eligible/ineligible issue sets
4. `labels-synchronized`
   - computed label mutations were applied successfully and the ready surface now matches eligibility
5. `sync-failed`
   - eligibility was computed, but at least one tracker mutation failed; the promoter reports failure and does not claim success silently

### Allowed Transitions

1. `unconfigured -> blocked-review-needed`
2. `unconfigured -> eligible-set-computed`
3. `blocked-review-needed -> eligible-set-computed`
4. `eligible-set-computed -> labels-synchronized`
5. `eligible-set-computed -> sync-failed`
6. `sync-failed -> eligible-set-computed`
7. `labels-synchronized -> eligible-set-computed`

### Contract Rules

1. label mutation is allowed only after a complete eligibility computation
2. prerequisite failure must exclude all downstream descendants from the eligible set
3. a ticket with any unsatisfied prerequisite must not retain `symphony:ready`
4. incomplete dependency metadata must fail closed with no speculative ready promotion

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| No dependency metadata configured | release-state absent or `dependencies: []` | open issue labels may exist | remain `unconfigured`; make no ready-label changes |
| Prerequisite issue has terminal failed outcome | configured dependency graph | prerequisite outcome is `failed` | compute downstream as ineligible; remove `symphony:ready` from any affected downstream open issue |
| Prerequisite issue is still non-terminal | configured dependency graph | prerequisite outcome is running / review / checks / unknown | downstream remains ineligible; do not add `symphony:ready` yet |
| All prerequisites for a downstream leaf have terminal success outcome | configured dependency graph | prerequisite outcomes are `succeeded` and downstream issue is open | mark the leaf eligible; add `symphony:ready` if absent |
| Metadata references an issue with no stored outcome fact | configured dependency graph | missing normalized issue fact | move to `blocked-review-needed`; apply no mutations |
| Downstream issue is already closed or terminal succeeded | configured dependency graph | issue is closed or succeeded | do not add `symphony:ready`; remove it if still present |
| GitHub label update fails after eligibility is computed | computed add/remove mutation set | current labels known, mutation request failed | report `sync-failed`; keep failure inspectable and do not claim successful promotion |

## Storage And Persistence Contract

The canonical release dependency source remains:

1. `.ralph/instances/<instance-key>/release-state.json`

This slice should extend inspectability by recording the latest promotion result in a typed form adjacent to or inside that operator-owned state, including:

1. evaluation timestamp
2. promotion state
3. eligible issue numbers
4. ready labels added
5. ready labels removed
6. any fail-closed or transport error summary

The promoter must not invent a second writable dependency source.

## Observability Requirements

1. operator-visible status output should show whether ready promotion was skipped, blocked, synchronized, or failed
2. the canonical release-state seam should expose the latest eligible set and applied add/remove mutations
3. integration and e2e tests should assert both mutation behavior and inspectable summaries, not just silent side effects

## Implementation Steps

1. Add a tracker-neutral dependency readiness policy module that accepts canonical dependency metadata plus normalized issue facts and returns:
   - eligible issue numbers
   - ineligible issue numbers
   - desired ready-label add/remove mutations
   - fail-closed status when metadata is incomplete
2. Extend the operator release-state contract with the latest promotion result so the promotion surface is inspectable after each run.
3. Add focused GitHub tracker/client support to:
   - read relevant open issue label state
   - update labels for ready promotion/removal
   - keep transport separate from eligibility policy
4. Add a one-shot promoter command/helper that:
   - loads the selected instance
   - reads canonical release-state metadata
   - reads normalized issue outcome facts
   - computes eligibility
   - applies the GitHub label diff
   - persists the promotion result
5. Update operator workflow wiring, prompt, and runbook so this promoter runs at the release-state checkpoint before ordinary queue advancement.
6. Add tests for pure eligibility policy, GitHub label sync integration, and the release-regression scenario.

## Tests And Acceptance Scenarios

### Unit Tests

1. eligibility policy returns only leaf downstream issues whose prerequisites all succeeded
2. failed prerequisite removes all downstream descendants from the eligible set
3. incomplete dependency metadata fails closed with no promotion mutations
4. already-closed or terminal-succeeded issues are excluded from ready promotion

### Integration Tests

1. operator-ready promoter updates a mock GitHub issue by adding `symphony:ready` when prerequisites succeed
2. operator-ready promoter removes `symphony:ready` from a downstream issue when a prerequisite fails
3. promotion status is written back to the canonical operator release-state seam

### End-To-End Scenario

1. Given a release graph where issue `#111` blocks issue `#112`, when `#111` fails after `#112` was previously ready, the promotion step removes `symphony:ready` from `#112` before the factory can dispatch it again.
2. Given the same graph after `#111` later reaches terminal success, the promotion step adds `symphony:ready` back only to currently eligible downstream leaves.

## Exit Criteria

1. the repository has one canonical, typed dependency source for this promoter
2. ready eligibility is computed from prerequisite terminal-success facts, not stale labels
3. GitHub ready labels are synchronized to the computed eligible set
4. prerequisite failure demonstrably prevents downstream ready promotion
5. unit, integration, and relevant end-to-end tests cover the regression and pass

## Deferred To Later Issues Or PRs

1. orchestrator-native dependency-aware dispatch
2. generalized dependency normalization for all tracker adapters
3. richer tools or UX for editing release dependency metadata
4. broader observability views for multi-release promotion planning
