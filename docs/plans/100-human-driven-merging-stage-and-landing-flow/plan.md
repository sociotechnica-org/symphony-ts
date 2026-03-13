# Issue 100 Plan: Human-Driven Merging Stage And Landing Flow

## Status

- plan-ready

## Goal

Add a first-class human-controlled landing handoff to the factory lifecycle so a clean PR does not move straight from review wait to passive merge observation. The factory should wait for an explicit human landing signal, execute landing through one dedicated path, and complete the issue only after merge is observed.

## Scope

- add an explicit pre-landing lifecycle stage for "PR is clean but the factory is still waiting for a human landing signal"
- normalize an explicit human landing signal in the GitHub bootstrap tracker instead of treating an open clean PR as implicitly ready to merge
- add one dedicated landing execution path owned by the factory rather than relying on manual operator `gh pr merge`
- keep the issue active while landing is in progress and until merge is observed
- update status, issue artifacts, and e2e coverage so operators can distinguish:
  - waiting for landing approval
  - landing in progress / merge pending
  - merged and terminally complete
- keep `#82` as the follow-on issue for stricter merge guards and fail-closed policy

## Non-goals

- hardening merge preconditions or adding strict guarded merge policy from `#82`
- redesigning the broader tracker abstraction beyond the seam needed for GitHub landing control
- adding remote merge-service support or non-GitHub landing automation
- redesigning the review loop, runner continuation loop, or workspace lifecycle outside the landing seam
- changing Linear workflow ownership beyond narrow shared-lifecycle compatibility if required to keep the build green

## Current Gaps

- `src/tracker/pull-request-policy.ts` can already normalize an open clean PR to `awaiting-landing`, but that state means "waiting for merge to happen elsewhere", not "waiting for explicit human approval to start landing"
- `src/orchestrator/service.ts` treats `awaiting-landing` only as a passive blocked state and has no landing execution branch
- the tracker contract has no way to distinguish:
  - clean PR but no human landing approval yet
  - human-approved landing handoff
  - landing attempt in progress but merge not yet observed
- GitHub bootstrap has no first-class landing signal protocol comparable to Linear's `Merging` workflow state
- the self-hosting docs still describe human merge as a separate action outside the factory loop

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define that clean PRs require an explicit human landing signal before factory-owned merge execution begins
  - belongs: define that issue completion still requires observed merge, not merely a successful landing request
  - does not belong: raw GitHub API parsing, subprocess details, or orchestrator bookkeeping branches
- Configuration Layer
  - belongs: no new required user-facing workflow config in this first slice unless implementation proves a minimal landing-command knob is unavoidable
  - does not belong: tracker-specific landing comment parsing or merge-state normalization
- Coordination Layer
  - belongs: explicit landing runtime states, allowed transitions, and decisions to wait, execute landing, retry, fail, or complete
  - does not belong: GitHub comment parsing or GitHub merge API details
- Execution Layer
  - belongs: a focused landing executor contract and one concrete execution path for factory-owned landing attempts
  - does not belong: deciding whether a human signal is valid or whether the PR is terminally merged
- Integration Layer
  - belongs: GitHub-specific normalization of landing signals, PR review/check state, merge observation, and any GitHub-side merge call
  - does not belong: orchestrator retry budgeting or status-surface derivation
- Observability Layer
  - belongs: operator-visible status names, artifact events, and summaries for waiting-on-landing-command, landing-in-progress, and merged completion
  - does not belong: re-deriving landing approval or merge state from raw tracker payloads

## Architecture Boundaries

### Belongs in this issue

- `src/domain/handoff.ts`
  - add lifecycle values that separate "awaiting landing approval" from "landing in progress / awaiting merge observation"
- `src/tracker/service.ts`
  - extend the tracker-facing handoff/landing contract only as needed for the orchestrator to request landing through a narrow interface
- GitHub tracker modules under `src/tracker/`
  - keep transport, normalization, and policy separate:
    - transport: fetch/create the minimal GitHub facts for landing signals and merge execution
    - normalization: project PR/comment state into tracker-owned landing snapshots
    - policy: map normalized facts into tracker-neutral lifecycle states
- `src/orchestrator/`
  - add a named landing runtime-state module if the current loose status/follow-up maps are not sufficient to keep transitions explicit
  - execute the dedicated landing path only from the explicit human-approved state
- observability/status and issue-artifact modules
  - surface the new states and landing-attempt events
- tests
  - unit, integration, and e2e coverage for the landing control loop
- docs
  - update the self-hosting loop and any README wording that still says merge is an out-of-band human action

### Does not belong in this issue

- merge gate hardening from `#82`
- broad tracker API redesign that mixes transport, normalization, and policy into one file
- runner/workspace refactors unrelated to landing execution
- a generic merge orchestration framework for all trackers
- remote merge-service adapters or external deployment concerns

## Layering Notes

- `config/workflow`
  - remains unchanged unless a narrow landing command setting is required during implementation
- `tracker`
  - owns GitHub landing signal detection, merge observation, and GitHub-side landing transport
  - must not force the orchestrator to inspect raw comments, labels, or PR fields
- `workspace`
  - remains responsible only for local repo state needed by the existing run
- `runner`
  - remains responsible only for coding-agent execution, not for merge execution
- `orchestrator`
  - owns when to wait versus when to invoke the landing path
  - must not decide GitHub-specific approval rules itself
- `observability`
  - renders already-normalized landing state and execution outcomes
  - must not infer landing approval from raw tracker comments

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam limited to one vertical landing-control slice:

1. introduce explicit lifecycle/state separation between:
   - clean PR awaiting human landing approval
   - human-approved landing handoff
   - merged terminal completion
2. add one GitHub bootstrap landing path that the orchestrator can invoke through a narrow contract
3. update status/artifact surfaces and tests around that new path

This stays reviewable because it deliberately avoids:

- strict merge policy
- broader tracker abstraction redesign
- non-GitHub landing automation
- changes to agent prompting beyond passing the new lifecycle names through existing prompt data

## Runtime State Model

The tracker-neutral handoff states after a PR exists should become:

- `awaiting-system-checks`
  - PR exists but checks or human review are still settling
- `awaiting-landing-command`
  - PR is clean enough for landing, but no explicit human landing approval has been observed yet
- `awaiting-landing`
  - a human landing approval has been observed and the factory now owns merge execution / merge observation for the current PR head
- `actionable-follow-up`
  - another coding run is required before landing can proceed
- `handoff-ready`
  - merge has been observed and the issue may complete

### Allowed transitions

- `awaiting-system-checks` -> `actionable-follow-up`
  - checks fail with no pending checks left, or actionable bot feedback appears
- `awaiting-system-checks` -> `awaiting-landing-command`
  - PR is open, checks are clean, no actionable feedback remains, and no landing approval has been observed
- `awaiting-landing-command` -> `awaiting-system-checks`
  - new checks start, new commits appear, or review state becomes non-clean again
- `awaiting-landing-command` -> `actionable-follow-up`
  - actionable bot feedback or failing checks appear before landing approval
- `awaiting-landing-command` -> `awaiting-landing`
  - explicit human landing approval is observed for the current PR / head
- `awaiting-landing` -> `awaiting-system-checks`
  - landing attempt updates the PR into a new non-clean state that still requires waiting
- `awaiting-landing` -> `actionable-follow-up`
  - landing attempt or reconciliation reveals the PR needs more code changes
- `awaiting-landing` -> `handoff-ready`
  - merge is observed
- `handoff-ready` -> terminal completion
  - orchestrator calls `completeIssue()`

### Coordination decision rules

- wait on `awaiting-human-handoff`
- wait on `awaiting-system-checks`
- wait on `awaiting-landing-command`
- when `awaiting-landing` is observed and no landing attempt is active for the current PR head, execute the dedicated landing path
- after a landing attempt, re-inspect tracker state; do not complete until `handoff-ready`
- rerun the coding agent only on `actionable-follow-up`
- fail on `missing-target` under the existing missing-target rules

## Failure-Class Matrix

| Observed condition                                                               | Local facts available                       | Normalized tracker facts available                                       | Expected decision                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| PR exists, checks pending                                                        | no landing attempt active                   | `awaiting-system-checks`                                                 | wait                                                                                                                |
| PR exists, checks clean, no human landing signal yet                             | no landing attempt active                   | `awaiting-landing-command`                                               | wait; keep issue open/running                                                                                       |
| Human posts landing signal for current clean PR                                  | no landing attempt active                   | `awaiting-landing`                                                       | execute landing path once for the current PR/head                                                                   |
| Human signal is stale because PR head changed after approval                     | previous landing approval or attempt exists | normalized approval does not match current head / current handoff window | return to `awaiting-landing-command`; require a fresh human signal                                                  |
| Landing attempt returns success but PR is still open                             | landing attempt recorded                    | `awaiting-landing`                                                       | keep waiting; do not complete until merge is observed                                                               |
| Landing attempt reports merge conflict / branch protection failure / API refusal | landing attempt recorded                    | PR still open and tracker facts remain non-terminal                      | stay non-terminal; classify into wait vs follow-up based on normalized tracker state and record the landing failure |
| PR gains new failing checks or actionable bot feedback after landing approval    | landing attempt may or may not have run     | `actionable-follow-up` or `awaiting-system-checks`                       | do not keep retrying landing blindly; return to the existing follow-up/check path                                   |
| Merge is observed after prior landing approval                                   | no runner active                            | `handoff-ready`                                                          | complete issue                                                                                                      |
| Issue reopened after merge on the same stale merged PR                           | stale merged observation exists             | existing stale-merged guard applies                                      | do not re-complete from stale history; require current non-stale terminal facts                                     |

## Storage / Persistence Contract

- no new external durable store is introduced
- tracker state remains the source of truth for:
  - current PR head
  - landing approval signal
  - merge observation
- local issue artifacts should record:
  - landing approval observed
  - landing execution attempted
  - landing execution result
  - merge observed / completion
- if the orchestrator needs to suppress duplicate landing attempts for the same PR head within one process lifetime, keep that state in a focused runtime-state module rather than scattering booleans across service methods

## Observability Requirements

- status snapshots must distinguish:
  - `awaiting-landing-command`
  - `awaiting-landing`
  - existing `awaiting-system-checks`
- issue artifacts should add a dedicated landing event instead of overloading `pr-opened` or `succeeded`
- logs should make it explicit when the factory:
  - observes a landing approval
  - invokes landing
  - sees landing remain pending
  - sees merge complete

## Decision Notes

- For GitHub bootstrap, the human landing signal should use a repository-owned explicit command protocol rather than implicit cleanliness. The likely first slice is a human issue-comment or PR-comment marker such as `/land`, with the exact GitHub-side surface chosen to minimize transport churn while keeping the signal explicit and reviewable.
- Keep the first slice GitHub-bootstrap-focused. If shared lifecycle typing requires narrow Linear compatibility updates, limit them to mapping existing `Merging` semantics onto the new shared lifecycle names without adding Linear landing automation.
- Prefer a dedicated landing service/contract over inlining merge calls inside `BootstrapOrchestrator`. That keeps merge execution testable and prevents GitHub policy from leaking upward.

## Implementation Steps

1. Add the new shared lifecycle/status values and any corresponding issue-artifact outcomes needed to represent pre-landing approval and landing-in-progress cleanly.
2. Introduce a focused landing signal parser / policy module in `src/tracker/` for the GitHub bootstrap path.
3. Extend GitHub transport only as needed to:
   - read the landing signal source
   - issue the dedicated landing action
   - observe merge completion for the same PR
4. Update GitHub PR lifecycle normalization so a clean open PR becomes:
   - `awaiting-landing-command` before explicit approval
   - `awaiting-landing` after explicit approval
   - `handoff-ready` only after merge is observed
5. Add a narrow landing execution contract and orchestrator branch that invokes it from the explicit landing state, then re-inspects tracker state instead of completing immediately.
6. Update status-state, status rendering, and issue-artifact/event generation for the new lifecycle and landing attempt.
7. Extend the mock GitHub server and integration harness to simulate:
   - landing approval
   - successful landing / merged result
   - landing refusal or no-op while the PR remains open
8. Update README and `docs/guides/self-hosting-loop.md` so the documented flow matches the new human-controlled landing stage.
9. Run local self-review and repo gates:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- PR lifecycle policy returns `awaiting-landing-command` for an open clean PR with no landing approval
- landing approval on the current clean PR transitions the normalized lifecycle to `awaiting-landing`
- merged PR still returns `handoff-ready`
- stale landing approval tied to an older PR head is ignored
- orchestrator tests prove:
  - `awaiting-landing-command` waits without invoking landing
  - `awaiting-landing` invokes landing once and re-inspects tracker state
  - issue completion still happens only on `handoff-ready`
- status and artifact tests show the new lifecycle/event names

### Integration

- GitHub bootstrap tracker reports `awaiting-landing-command` for a clean open PR with no approval signal
- after a human landing signal is added, the tracker reports `awaiting-landing`
- the dedicated landing path is invoked through the new contract rather than manual operator action
- after the mock server marks the PR merged, the tracker reports `handoff-ready`
- landing refusal or stale approval returns the issue to the correct non-terminal state without completing

### End-to-end

- bootstrap factory opens a PR, sees checks go green, and reports `awaiting-landing-command`
- after the mock human approval signal is added, the next poll executes landing and keeps the issue open until merge is observed
- once merge is observed, the following reconciliation completes the issue
- if landing is attempted but merge is not yet observed, the issue remains active and visible as landing-related rather than succeeded

### Acceptance Scenarios

1. A PR becomes clean and the factory exposes a first-class waiting-for-landing-approval state instead of treating the PR as implicitly ready to merge.
2. A human gives the explicit landing signal and the factory executes the dedicated landing path automatically.
3. The issue remains open and `symphony:running` until the PR is actually merged.
4. The success comment and issue closure happen only after merge observation.
5. `#82` remains the follow-on issue for stricter guarded merge policy on this centralized path.

## Exit Criteria

- there is a first-class lifecycle stage for a clean PR awaiting explicit human landing approval
- the factory owns one dedicated landing execution path after that approval
- issue completion requires observed merge, not merely clean PR state or a successful landing request
- status, artifacts, and docs reflect the new landing-control loop
- unit, integration, and e2e coverage pin the new behavior
- the change remains one reviewable PR and does not absorb `#82` hardening scope

## Deferred To Later Issues Or PRs

- strict merge guards and fail-closed landing policy from `#82`
- non-GitHub landing automation
- a generalized remote landing service
- broader workflow/config customization for landing behavior unless real implementation pressure proves it necessary
