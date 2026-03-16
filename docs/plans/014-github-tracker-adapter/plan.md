# Issue 14 Plan: GitHub Tracker Adapter

## Status

`plan-ready`

## Goal

Land the first maintained GitHub tracker slice by introducing an explicit `tracker.kind: github` backend contract that is distinct from `github-bootstrap`, while preserving the current orchestration behavior through a narrow, reviewable adapter seam.

This issue should establish the maintained GitHub boundary without trying to replace every bootstrap-era assumption in one PR.

## Scope

- add a first-class `tracker.kind: github` workflow/config contract
- define the initial maintained GitHub workflow semantics for this slice:
  - ready/running/failed issue ownership is label-based
  - plan review, PR review, checks, landing, and completion continue to flow through normalized handoff lifecycle state
- split the maintained GitHub adapter from the bootstrap-named entrypoint so later GitHub work can evolve without growing `github-bootstrap.ts`
- reuse the existing GitHub transport and policy helpers through explicit shared seams instead of duplicating or moving logic into the orchestrator
- document the maintained GitHub contract and its initial limitations
- add tests that prove `tracker.kind: github` exercises the same end-to-end mock-GitHub flow as the current bootstrap path

## Non-Goals

- supporting every GitHub project board or issue-state variant
- redesigning the orchestrator runtime state machine
- changing runner, workspace, or status-surface behavior beyond consuming the new tracker kind
- replacing the existing `github-bootstrap` path in this PR
- broad transport rewrites or a new GitHub API client
- making GitHub the primary long-term tracker over Beads

## Current Gaps

- workflow/config only recognizes `github-bootstrap` and `linear`
- tracker construction only exposes `GitHubBootstrapTracker`, which keeps the maintained GitHub seam hidden behind bootstrap naming
- README, `WORKFLOW.md`, and tests document the bootstrap-only GitHub contract
- the existing GitHub implementation already contains maintained-grade behavior for plan review, PR lifecycle inspection, guarded landing, and reconciliation, but that behavior is not surfaced as a supported `tracker.kind: github` backend
- the repo still risks treating bootstrap naming as architecture, which is exactly what this phase is meant to prevent

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs:
  - the repository-owned decision that the first maintained GitHub slice uses label-based ready/running/failed ownership plus normalized PR/review/check/landing handoff state
  - the rule that the orchestrator consumes normalized lifecycle results, not GitHub payloads
- does not belong:
  - REST/GraphQL parsing
  - retry budgeting
  - TUI-specific rendering logic

### Configuration Layer

- belongs:
  - an explicit `tracker.kind: github` config shape
  - maintained GitHub defaults and validation for repo/api/labels/review bots/success comment
  - compatibility rules for the existing `github-bootstrap` config during the transition
- does not belong:
  - live claim state
  - issue/PR normalization

### Coordination Layer

- belongs:
  - no behavioral change in this slice beyond constructing the new tracker kind and continuing to consume the existing normalized tracker contract
- does not belong:
  - GitHub label, comment, or review parsing

### Execution Layer

- belongs:
  - no new responsibilities in this slice
- does not belong:
  - GitHub workflow semantics

### Integration Layer

- belongs:
  - the new maintained GitHub tracker entrypoint
  - explicit separation between shared GitHub transport/policy helpers and the tracker class names exposed at the factory boundary
  - compatibility adapters or shared internals that let `github` and `github-bootstrap` coexist without duplicating behavior
- does not belong:
  - orchestration state transitions
  - workflow prompt policy

### Observability Layer

- belongs:
  - updating user-facing docs/examples/tests so the maintained GitHub kind is visible and inspectable
- does not belong:
  - tracker-specific branching in the live status surface

## Architecture Boundaries

### Config / Workflow

- add a maintained GitHub tracker config type alongside the existing bootstrap config
- preserve backward compatibility for `github-bootstrap`
- keep repo-owned defaults in the config layer instead of scattering them across tracker construction

### Tracker

- introduce a maintained GitHub tracker class or shared internal implementation under a maintained name such as `GitHubTracker`
- keep raw API access in `github-client.ts`
- keep handoff/landing/plan-review interpretation in focused policy helpers
- do not move GitHub-specific logic into orchestrator code

### Orchestrator

- continue depending only on the `Tracker` interface
- do not add special cases for `tracker.kind: github`

### Docs / Workflow Contract

- document that `github` is the maintained backend name
- document that `github-bootstrap` remains as the self-hosting compatibility path for now
- call out the exact semantics supported by the maintained slice and what is deferred

## Slice Strategy And PR Seam

This issue should land as one narrow PR that establishes the maintained GitHub contract without broad policy churn.

What lands in this PR:

- `tracker.kind: github` config support
- tracker factory/runtime support for constructing the maintained GitHub adapter
- shared-internal extraction or renaming needed so maintained GitHub does not live behind bootstrap naming
- docs and tests proving the maintained kind works against the existing mock GitHub harness

What is deliberately deferred:

- alternate GitHub workflow models beyond label-based ownership
- GitHub Projects-based normalization
- deeper transport/normalization decomposition if it is not needed to expose the maintained kind cleanly
- any orchestrator/runtime changes driven by new GitHub semantics

Why this seam is reviewable:

- it changes the repository-owned contract and factory boundary without changing the runtime control plane
- it makes the maintained GitHub path explicit while keeping existing behavior stable
- it leaves later GitHub normalization/write-path expansions to focused follow-up issues

## Runtime State Model

This slice does not introduce new orchestrator states. It preserves the current normalized handoff contract and makes the maintained GitHub backend explicitly responsible for producing it.

The maintained GitHub tracker in this slice continues to map external GitHub facts into these normalized stages:

1. `ready`
   - open issue with the configured ready label and without running ownership
2. `running`
   - claimed issue with the configured running label
3. `awaiting-human-handoff`
   - no active PR yet, but plan-review protocol shows the worker is waiting for human review
4. `missing-target`
   - no usable PR or approved plan-review wait state is present
5. `awaiting-human-review` / `rework-required` / `awaiting-system-checks` / `awaiting-landing-command` / `awaiting-landing`
   - PR exists and tracker policy maps review/check/landing facts into the normalized lifecycle
6. `handoff-ready`
   - PR is merged or otherwise satisfies completion handoff
7. `completed` / `failed`
   - tracker mutation closes the issue or marks failure through the existing tracker contract

Allowed transitions in this slice stay the same as the current GitHub implementation; the change here is that `tracker.kind: github` owns them explicitly instead of inheriting them from bootstrap naming.

## Failure-Class Matrix

| Observed condition                                                                       | Local facts available                      | Normalized tracker facts available | Expected decision                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `tracker.kind: github` workflow loads with full GitHub fields                            | front matter plus env                      | n/a                                | resolve the maintained GitHub config and construct the maintained tracker |
| legacy `tracker.kind: github-bootstrap` workflow loads                                   | front matter plus env                      | n/a                                | preserve current behavior through the compatibility path                  |
| maintained GitHub issue is ready and claimable                                           | issue labels from tracker read             | ready issue snapshot               | claim through tracker write path and return normalized running issue      |
| branch has no PR, but plan-review comment is `plan-ready` with no accepted review marker | issue comments and issue timestamp         | `awaiting-human-handoff` lifecycle | orchestrator waits; no retry/failure branch is added                      |
| branch has no PR and no waiting handoff signal                                           | issue comments/PR lookup                   | `missing-target` lifecycle         | preserve existing missing-target behavior                                 |
| PR exists with pending checks or unresolved human review feedback                        | checks/reviews/comments from tracker reads | normalized waiting lifecycle       | orchestrator waits on normalized lifecycle, not GitHub-specific branches  |
| workflow selects unsupported GitHub variant beyond this slice                            | config only                                | n/a                                | fail fast in config/docs rather than silently inventing semantics         |

## Implementation Steps

1. Add a maintained GitHub tracker config type in `src/domain/workflow.ts` and update config parsing in `src/config/workflow.ts` to support `tracker.kind: github` with the same required fields as the current bootstrap mode for this slice.
2. Introduce the narrowest possible tracker-construction seam so `src/tracker/factory.ts` can build both:
   - a maintained GitHub tracker for `tracker.kind: github`
   - the existing bootstrap compatibility tracker for `tracker.kind: github-bootstrap`
3. Extract or rename shared GitHub tracker implementation code so maintained GitHub behavior is not defined only by `GitHubBootstrapTracker` naming.
4. Keep transport and policy helpers where they already live unless a small structural refactor is required to share them cleanly between the maintained and bootstrap entrypoints.
5. Update `WORKFLOW.md`, `README.md`, and any directly relevant docs/examples to document:
   - `tracker.kind: github`
   - compatibility status of `github-bootstrap`
   - the supported semantics and deferred GitHub variants
6. Extend unit/integration/e2e tests so the maintained GitHub kind is covered through the existing mock server and workflow-loading paths.

## Tests

### Unit

- workflow parsing accepts `tracker.kind: github`
- workflow validation rejects malformed maintained GitHub config
- tracker factory returns the maintained GitHub adapter for `tracker.kind: github`
- backward compatibility for `github-bootstrap` remains intact

### Integration

- maintained GitHub tracker claims ready issues, records retries, inspects handoff lifecycle, lands PRs, and completes issues through the mock GitHub server
- maintained GitHub tracker preserves the existing plan-review wait behavior and guarded-landing behavior

### End-to-End

- the bootstrap factory harness can run a full mock GitHub handoff loop when the workflow uses `tracker.kind: github`
- the existing bootstrap compatibility workflow continues to pass unchanged

## Acceptance Scenarios

1. A repository `WORKFLOW.md` using `tracker.kind: github` loads successfully, constructs the maintained GitHub tracker, and can claim a ready issue in the mock GitHub harness.
2. A maintained GitHub run that stops at `plan-ready` yields normalized `awaiting-human-handoff` instead of a retry/failure path.
3. A maintained GitHub run with an open PR, checks, and review feedback maps into the same normalized lifecycle states the orchestrator already understands.
4. A maintained GitHub run can execute guarded landing and only complete the issue after merge is observed.
5. An existing `github-bootstrap` workflow still loads and passes its current tests unchanged.

## Exit Criteria

- `tracker.kind: github` is a supported, documented workflow contract
- the tracker factory constructs a maintained GitHub adapter distinct from the bootstrap-named entrypoint
- the maintained GitHub path passes unit, integration, and relevant end-to-end tests without live GitHub dependencies
- the orchestrator remains backend-neutral and unchanged aside from using the new tracker kind through the existing interface

## Deferred To Later Issues Or PRs

- alternate GitHub readiness/ownership models such as Projects-driven state
- richer GitHub issue/project normalization beyond the label-based slice
- further decomposition of GitHub transport/normalization/write-path modules if later slices need a deeper split
- any GitHub-specific observability additions beyond normalized status fields
- multi-instance coordination or lease changes tied to GitHub semantics

## Decision Notes

- The first maintained GitHub slice intentionally reuses the existing label-based and PR-based behavior because it already matches the tracker contract and mock harness. The phase value here is making that behavior explicit and maintainable under `tracker.kind: github`, not inventing a broader GitHub model prematurely.
- Keeping `github-bootstrap` as a compatibility path avoids forcing self-hosting churn into the same PR that introduces the maintained backend name.
- If exposing `tracker.kind: github` cleanly requires a small internal refactor, prefer a shared internal GitHub tracker core over duplicating or rebranching logic in the orchestrator.
