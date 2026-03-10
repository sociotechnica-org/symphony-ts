# Issue 50 Plan: Generalize Handoff Lifecycle Model Beyond GitHub PR Semantics

## Status

- plan-ready

## Goal

Introduce a tracker-neutral internal handoff lifecycle model so the orchestrator and live status surface reason about generalized handoff states rather than GitHub pull-request lifecycle names, while keeping GitHub-specific mapping policy at the tracker edge.

## Scope

- add a tracker-neutral shared handoff lifecycle contract for orchestrator-facing logic
- map GitHub bootstrap plan-review and PR-review facts into that shared contract at the tracker edge
- update orchestrator branching and follow-up handling to depend on generalized handoff states rather than GitHub-shaped lifecycle names
- update the live status/observability surface to render generalized handoff states
- preserve the current GitHub bootstrap behavior covered by `#42` and `#48`
- keep tracker mapping tests separate from orchestrator behavior tests

## Non-goals

- replacing the GitHub bootstrap tracker
- implementing the Beads or Linear adapter in this issue
- redesigning the external human review workflow or PR review workflow itself
- changing `WORKFLOW.md` prompt variables or the prompt-builder template contract unless implementation fallout makes a minimal compatibility shim necessary
- redesigning the durable issue-report artifact schema beyond any compatibility mapping required by the refactor

## Current Gaps

- the shared domain lifecycle type is still `PullRequestLifecycle` with GitHub-shaped states: `missing`, `awaiting-plan-review`, `awaiting-review`, `needs-follow-up`, `ready`
- the orchestrator branches directly on those GitHub/PR-shaped state names even though the tracker already performs the external-state inspection
- the status snapshot exposes those same state names to operators, which reinforces the GitHub bootstrap vocabulary in the control plane
- plan-review policy and PR policy both normalize correctly at the tracker edge, but they normalize into a contract whose names are still shaped around the current adapter
- tests exercise behavior correctly, but many of them still encode GitHub-shaped lifecycle names as the orchestrator-facing contract

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: naming the generalized handoff states and their meanings in repo-owned docs for future tracker work
  - does not belong: tracker-specific PR policy or GitHub comment parsing rules
- Configuration Layer
  - belongs: nothing new in this slice unless a compatibility shim is needed to keep prompt rendering stable
  - does not belong: lifecycle classification logic or tracker policy branches
- Coordination Layer
  - belongs: orchestrator decisions about wait, rerun, fail, or complete based on generalized handoff states
  - does not belong: parsing GitHub review comments, PR checks, or adapter-specific lifecycle rules
- Execution Layer
  - belongs: unchanged workspace and runner behavior that consumes the orchestrator decision
  - does not belong: lifecycle naming or tracker-state interpretation
- Integration Layer
  - belongs: mapping GitHub issue comments, PR checks, and review feedback into the generalized handoff contract
  - does not belong: orchestrator retry policy or status-surface branching
- Observability Layer
  - belongs: live factory status names and summaries derived from the generalized handoff contract
  - does not belong: reimplementing tracker mapping policy inside status rendering

## Architecture Boundaries

### Belongs in this issue

- a new or renamed shared domain contract for tracker-neutral handoff lifecycle state
- focused GitHub tracker mapping from:
  - no handoff target yet
  - plan-ready waiting
  - PR checks/review waiting
  - actionable follow-up
  - clean handoff ready
- orchestrator updates that consume only the generalized contract
- status-state and status rendering updates that consume only the generalized contract
- test helpers/builders updated so tracker mapping and orchestrator policy stay distinct
- lightweight docs updates where the runtime contract description still uses the old internal lifecycle names

### Does not belong in this issue

- changing tracker transport APIs or mixing transport, normalization, and policy into one module
- broad prompt-template redesign
- issue-report product work unrelated to the live handoff model
- a larger tracker abstraction overhaul beyond the normalized handoff lifecycle seam
- bundling the first Beads or Linear adapter slices into the same PR

## Slice Strategy And PR Seam

This should remain one reviewable PR if the slice stays limited to the shared handoff contract plus the direct consumers of that contract:

1. introduce the generalized handoff state model
2. adapt GitHub plan-review and PR policy modules to map into it
3. update orchestrator and live status handling to consume it
4. update tests and minimal docs to match

This seam is reviewable because it deliberately avoids changing:

- tracker transport
- workspace/runner behavior
- prompt-template shape
- durable report-generation semantics unless a narrow compatibility adapter is unavoidable

If the implementation shows that artifact/report vocabulary must change to keep the system coherent, keep that work limited to compatibility mapping inside this PR and defer any schema redesign to a follow-up issue.

## Runtime State Model

The orchestrator-facing handoff states for this issue are:

- `missing-target`
  - no handoff artifact or target exists yet for the current issue branch
- `awaiting-human-handoff`
  - the tracker has recorded a valid human handoff wait state, such as `Plan status: plan-ready`
- `awaiting-system-checks`
  - a handoff target exists, but automated checks or human review completion are still in flight
- `actionable-follow-up`
  - the tracker has enough evidence that another worker run is needed
- `handoff-ready`
  - the current handoff target is clean and ready for completion

### Allowed transitions

- initial claimed issue -> `missing-target`
- `missing-target` -> `awaiting-human-handoff`
  - latest relevant tracker fact is a valid plan-ready handoff with no PR yet
- `missing-target` -> `awaiting-system-checks`
  - a PR exists and checks/review are still settling
- `awaiting-human-handoff` -> `missing-target`
  - review decision is `approved`, `waived`, or `changes-requested`, so the next action is a rerun rather than continued waiting
- `awaiting-system-checks` -> `actionable-follow-up`
  - tracker shows actionable bot feedback or failing checks with no remaining pending checks
- `awaiting-system-checks` -> `handoff-ready`
  - tracker shows no actionable feedback and no blocking checks
- `actionable-follow-up` -> `awaiting-system-checks`
  - a follow-up run pushes new work and the tracker returns to waiting on checks/review
- `actionable-follow-up` -> `handoff-ready`
  - a follow-up run resolves the remaining blockers
- `handoff-ready` -> terminal completion
  - orchestrator completes the issue and cleans up local state

### Runtime decision rules

- wait on `awaiting-human-handoff`
- wait on `awaiting-system-checks`
- rerun on `actionable-follow-up`
- fail on `missing-target` only after a successful run still leaves no valid handoff target
- complete on `handoff-ready`

## Failure-Class Matrix

| Observed condition                                        | Local facts available                  | Normalized tracker facts available                     | Expected decision                                                       |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Claimed issue has no PR and no valid plan-review handoff  | successful run finished, branch exists | `missing-target`                                       | treat as missing handoff target and keep current failure/retry behavior |
| Claimed issue stops after plan-ready comment              | successful run finished, no PR yet     | `awaiting-human-handoff`                               | wait without retry/fail                                                 |
| Human review comment says approved or waived, still no PR | next poll on running issue             | `missing-target` after tracker acknowledgement/mapping | rerun issue from the same branch                                        |
| Human review comment says changes-requested, still no PR  | next poll on running issue             | `missing-target` after tracker acknowledgement/mapping | rerun issue to revise the plan                                          |
| PR exists with pending checks                             | no local runner active                 | `awaiting-system-checks`                               | wait                                                                    |
| PR has failing checks but some checks are still pending   | no local runner active                 | `awaiting-system-checks`                               | wait and do not rerun yet                                               |
| PR has failing checks and no pending checks remain        | no local runner active                 | `actionable-follow-up`                                 | rerun with follow-up budget                                             |
| PR has unresolved actionable bot feedback                 | no local runner active                 | `actionable-follow-up`                                 | rerun with follow-up budget                                             |
| PR is clean and merge-ready                               | no local runner active                 | `handoff-ready`                                        | complete issue                                                          |

## Storage / Persistence Contract

- the live factory status snapshot should store the generalized handoff status names
- orchestrator in-memory follow-up and retry state should continue to key off the normalized lifecycle contract, not raw tracker payloads
- if issue-artifact persistence still needs the old outcome names for schema compatibility, keep that translation explicit and localized rather than letting the old names leak back into orchestrator branching

## Observability Requirements

- `src/observability/status.ts` should expose generalized handoff status names in the machine-readable snapshot and rendered terminal output
- `src/orchestrator/status-state.ts` should translate normalized handoff states into status entries without GitHub-specific branches
- log messages and status actions should describe generalized handoff state while preserving specific summaries from the tracker edge
- if compatibility mapping is needed for issue artifacts, document that mapping in code comments or the plan revision log so the remaining PR-specific vocabulary is explicit rather than accidental

## Implementation Steps

1. Introduce a tracker-neutral handoff lifecycle domain contract and migrate the tracker service interface to use it.
2. Update `src/tracker/plan-review-policy.ts` to emit generalized handoff states for plan-review waiting or rerun-required conditions.
3. Update `src/tracker/pull-request-policy.ts` and related snapshot helpers to emit generalized handoff states while preserving the existing GitHub behavior.
4. Update `src/tracker/github-bootstrap.ts` so plan-review and PR policy remain at the tracker edge and cache normalized handoff observations against the new contract.
5. Update `src/orchestrator/service.ts` and `src/orchestrator/follow-up-state.ts` to branch on generalized handoff states only.
6. Update `src/orchestrator/status-state.ts` and `src/observability/status.ts` to surface the generalized statuses.
7. Apply minimal compatibility updates where prompt building, issue artifacts, or tests currently depend on the old lifecycle type name.
8. Update README or architecture notes where the runtime still documents the old internal lifecycle vocabulary.

## Tests And Acceptance Scenarios

### Unit

- plan-review policy maps `Plan status: plan-ready` to `awaiting-human-handoff`
- plan-review policy keeps `approved`, `waived`, and `changes-requested` as rerun-required rather than a waiting state
- PR policy maps:
  - pending checks -> `awaiting-system-checks`
  - failing checks with no pending -> `actionable-follow-up`
  - actionable review feedback -> `actionable-follow-up`
  - clean PR -> `handoff-ready`
- follow-up/orchestrator helper tests use the generalized lifecycle states rather than GitHub names
- status snapshot parsing/rendering accepts the generalized status names

### Integration

- GitHub bootstrap tracker reports:
  - `missing-target` when no PR or plan-ready handoff exists
  - `awaiting-human-handoff` when latest issue handoff is plan-ready
  - `awaiting-system-checks` while checks are pending or review is still in flight
  - `actionable-follow-up` when bot feedback or settled failures require another run
  - `handoff-ready` when the PR is clean
- tracker acknowledgement behavior from `#48` still works with the generalized contract

### End-to-end

- the bootstrap factory waits at plan review without failing the run
- the bootstrap factory waits on pending checks without rerunning the agent
- the bootstrap factory reruns when actionable feedback appears
- the bootstrap factory completes only when the handoff becomes ready

### Repo gate

- `pnpm format`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. A worker posts `Plan status: plan-ready`, no PR exists yet, and the orchestrator reports the issue as `awaiting-human-handoff` without retrying or failing.
2. A PR exists with pending CI and no actionable bot feedback, and the orchestrator reports `awaiting-system-checks` while leaving the runner idle.
3. A PR has actionable bot feedback or settled failing checks, and the orchestrator treats it as `actionable-follow-up` and schedules a rerun within the existing follow-up budget.
4. A PR is clean, and the orchestrator treats it as `handoff-ready` and completes the issue.
5. Tracker-mapping tests prove that the GitHub adapter is responsible for translating GitHub-specific facts into the generalized states, while orchestrator tests assert behavior only against the generalized states.

## Exit Criteria

- the orchestrator no longer branches on `missing`, `awaiting-plan-review`, `awaiting-review`, `needs-follow-up`, or `ready`
- the shared internal handoff contract uses generalized state names
- the GitHub tracker remains responsible for mapping plan-review and PR-review facts into the generalized handoff model
- the live status snapshot and rendered status output use the generalized handoff model
- existing plan-review and PR lifecycle behavior from `#42` and `#48` still passes through tests
- the work remains one reviewable PR without mixing new tracker adapters or prompt-contract redesign

## Deferred To Later Issues Or PRs

- renaming prompt-template variables such as `pull_request` to a broader handoff-target vocabulary
- redesigning issue-artifact/report schemas around the generalized handoff model if that proves worthwhile after this refactor lands
- adding new tracker adapters on top of the new seam
- broad tracker-neutral modeling of non-PR handoff target metadata beyond the lifecycle states needed in this issue

## Decision Notes

- This slice intentionally prioritizes generalized lifecycle states over a full rename of every `pullRequest`-shaped payload field. The control-plane state names are the architectural blocker for future trackers; broader payload renaming can follow in a smaller dedicated slice once the behavior seam is stable.
- Tracker transport, normalization, and policy stay separate. This issue should not move GitHub API parsing into orchestrator code or collapse plan-review and PR policy into the transport client.
- If a compatibility bridge is required for issue artifacts or prompt rendering, keep it explicit and local so the old GitHub vocabulary does not silently remain the orchestrator contract.

## Revision Log

- 2026-03-10: Initial draft plan created for issue #50.
- 2026-03-10: Promoted to `plan-ready` and prepared for issue-thread review handoff.
