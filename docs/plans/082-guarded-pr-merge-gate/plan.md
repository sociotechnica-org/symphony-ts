# Issue 82 Plan: Guarded PR Merge Gate

## Status

- plan-ready

## Goal

Harden the centralized landing path so Symphony refuses to merge a pull request unless merge preconditions are explicitly verified at merge time. A clean review lifecycle is not enough on its own; merge must become a guarded capability with fail-closed behavior and inspectable reasons.

## Scope

- add a dedicated guarded landing helper/service for GitHub bootstrap merge execution
- make the factory-owned landing path call that guarded helper instead of issuing a raw merge request
- require the guarded path to verify, at minimum:
  - the PR is mergeable
  - required checks are terminal green
  - unresolved non-outdated review thread count is `0`
  - blocked-check policy is satisfied
- return a structured failure reason when the gate is closed and keep the issue non-terminal
- extend unit, integration, and e2e coverage for the unresolved-thread regression represented by PR `#80`

## Non-goals

- redesigning the broader landing/merge lifecycle introduced in `#100`
- replacing the existing `/land` approval protocol
- introducing remote merge services or non-GitHub landing adapters
- redesigning tracker lifecycle semantics beyond the narrow landing gate seam
- shipping a broad operator control CLI in this issue if no in-tree command surface already exists

## Current Gaps

- `src/tracker/github-bootstrap.ts` currently routes `executeLanding()` straight to `GitHubClient.mergePullRequest()`
- the current landing path trusts the previously observed lifecycle instead of re-checking merge-time facts
- review-thread information is normalized for follow-up and auto-resolution, but unresolved human threads do not block merge execution
- GitHub transport does not currently expose mergeability / merge-state facts as a dedicated normalized merge-gate snapshot
- no structured merge-gate failure classification exists for operator-facing logs, artifacts, or status output

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: define merge as a guarded action with explicit preconditions and fail-closed outcomes
  - belongs: define that unresolved non-outdated threads and non-terminal checks block landing
  - does not belong: raw GitHub API fields or HTTP error parsing
- Configuration Layer
  - belongs: no new workflow settings in this slice unless GitHub proves a minimal blocked-check configuration hook is already required by existing policy
  - does not belong: per-PR mergeability parsing or landing gate decisions
- Coordination Layer
  - belongs: decide whether the orchestrator waits, retries later, requests follow-up, or records a blocked landing outcome after a guarded merge attempt
  - does not belong: direct GitHub transport calls or GraphQL field mapping
- Execution Layer
  - belongs: the dedicated guarded landing executor/helper invoked by the centralized landing path
  - does not belong: tracker-specific normalization rules leaking into runner or workspace code
- Integration Layer
  - belongs: fetch GitHub mergeability, check-state, and review-thread facts; normalize them into a merge-gate snapshot; execute merge only after policy approval
  - does not belong: orchestrator retry counters or status-surface wording
- Observability Layer
  - belongs: explicit logs, issue-artifact events, and status summaries for guarded landing pass/fail results
  - does not belong: recomputing merge-gate policy from raw GitHub payloads

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/github-client.ts`
  - add the narrow GitHub reads needed to inspect merge-time gate facts
- `src/tracker/`
  - add a focused normalization/policy seam for guarded landing evaluation instead of burying checks inside `github-bootstrap.ts`
- `src/tracker/service.ts`
  - widen the landing contract only as much as needed to return structured gate failures instead of a bare throw/no-throw merge call
- `src/orchestrator/`
  - consume the guarded landing result and keep the issue in a non-terminal waiting/blocked state when the gate is closed
- tests
  - unit policy coverage, tracker integration coverage, and e2e regression coverage
- docs
  - update operator-facing docs so the landing path is described as guarded rather than implicit

### Does not belong in this issue

- a generic tracker-agnostic merge orchestration framework
- large CLI/control-surface work unrelated to the existing landing path
- Linear landing implementation beyond keeping shared tracker contracts compiling
- runner, workspace, or prompt changes unrelated to guarded merge semantics

## Layering Notes

- `config/workflow`
  - stays unchanged unless existing blocked-check policy already needs a typed config seam
- `tracker`
  - owns GitHub merge-gate transport, normalization, and merge policy
  - must keep transport, normalization, and policy in separate focused modules
- `workspace`
  - remains untouched
- `runner`
  - remains untouched
- `orchestrator`
  - owns the decision to attempt landing and how to record a guarded refusal
  - must not inspect raw GitHub mergeability or thread payloads itself
- `observability`
  - renders normalized gate outcomes
  - must not infer unresolved-thread or mergeability state from GitHub fields

## Slice Strategy And PR Seam

This issue should stay one reviewable PR by limiting the seam to guarded execution on the already-centralized landing path from `#100`.

Current PR:

1. add a dedicated merge-gate snapshot + policy for GitHub bootstrap
2. route factory landing through that guard
3. expose structured gate-failure outcomes to orchestration and observability
4. cover the PR `#80` unresolved-thread regression end-to-end

Deferred:

- any standalone operator control CLI surface from `#81`
- broader tracker abstractions for non-GitHub landing
- richer approval / review-bot policy beyond the minimum guarded checks above

This seam is reviewable because it strengthens one existing path without reopening the full lifecycle redesign from `#100`.

## Runtime State Model

This issue does not introduce a new top-level handoff state. It tightens transitions inside the existing `awaiting-landing` path.

### Landing execution sub-states

- `awaiting-landing`
  - PR has human `/land` approval and is eligible for a guarded landing attempt
- `landing-gate-open`
  - merge-time facts pass the guarded landing policy for the current PR head
- `landing-gate-closed`
  - merge-time facts fail policy; merge is not attempted and the refusal reason is recorded
- `handoff-ready`
  - merge is observed after a successful guarded landing request

### Allowed transitions

- `awaiting-landing` -> `landing-gate-open`
  - GitHub merge-gate snapshot satisfies guarded merge policy
- `awaiting-landing` -> `landing-gate-closed`
  - mergeable/check/thread/blocked-check policy fails
- `landing-gate-open` -> `handoff-ready`
  - guarded merge request succeeds and merge is observed
- `landing-gate-open` -> `awaiting-landing`
  - merge request is accepted but merge is not yet observed
- `landing-gate-closed` -> `awaiting-system-checks`
  - failing or pending checks are the reason the gate closed
- `landing-gate-closed` -> `awaiting-human-review`
  - unresolved non-outdated human review threads are the reason the gate closed
- `landing-gate-closed` -> `awaiting-landing`
  - the PR is otherwise still awaiting human-approved landing but a transient mergeability / blocked-check condition cleared later

### Coordination Decision Rules

- keep `/land` as the handoff into the landing path
- before any merge request, fetch a fresh merge-gate snapshot for the current PR head
- execute merge only when the gate is open
- when the gate is closed, record the refusal reason and re-inspect the normalized PR lifecycle instead of forcing completion or blind retry
- preserve fail-closed behavior when GitHub returns incomplete or unknown mergeability facts

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| PR head changed after `/land` approval | current head SHA from lifecycle | guarded snapshot no longer matches approved head | reject landing, re-enter normal lifecycle inspection |
| Required checks pending | no landing attempt active | merge gate shows pending or non-terminal checks | do not merge; remain `awaiting-system-checks` |
| Required checks failed | no landing attempt active | merge gate shows failing terminal checks | do not merge; lifecycle returns to follow-up path |
| Unresolved non-outdated human review threads remain | no landing attempt active | merge gate unresolved thread count > 0 | do not merge; remain blocked on human review |
| Only outdated or resolved threads remain | no landing attempt active | merge gate unresolved thread count = 0 | gate may open if other requirements pass |
| GitHub reports PR not mergeable / merge blocked | no landing attempt active | mergeability fact is negative or unknown | do not merge; fail closed with explicit reason |
| Merge request succeeds but PR remains open | landing request recorded | lifecycle still `awaiting-landing` | keep waiting; do not complete |
| GitHub merge request returns conflict / branch protection / refusal | landing request attempted | merge gate or merge API returns refusal reason | record blocked landing result and stay non-terminal |

## Storage / Persistence Contract

- tracker state remains the source of truth for mergeability, review-thread, and check facts
- no new durable external store is introduced
- issue artifacts should capture:
  - merge gate evaluated
  - merge gate refused with reason
  - guarded landing requested
  - merge observed
- in-process landing runtime state may continue to suppress duplicate attempts per PR head, but gate decisions should be recomputed from fresh tracker facts

## Observability Requirements

- structured logs should distinguish:
  - guarded landing evaluation started
  - guarded landing refused and why
  - guarded landing request sent
  - merge observed after guarded landing
- issue artifacts should add a merge-gate refusal event/outcome rather than overloading generic landing failure text
- status/report surfaces should show a clear blocked reason when landing is refused because threads or checks remain unresolved

## Decision Notes

- The merge gate should be evaluated on fresh GitHub data at execution time, not inferred from a stale earlier lifecycle snapshot.
- Keep unresolved review-thread counting in normalization, but move merge/no-merge decisions into a dedicated guarded landing policy module so the policy is unit-testable.
- If the current repo still lacks an operator control CLI, satisfy the "dedicated merge helper" requirement with an internal guarded landing service now and let `#81` expose it via CLI later rather than widening this PR.

## Implementation Steps

1. Add GitHub transport reads for merge-time facts that are not already present in the review/check snapshot, including explicit mergeability data if needed.
2. Introduce a normalized guarded-landing snapshot type plus a dedicated policy module that decides pass/fail and returns structured refusal reasons.
3. Extend the tracker landing contract so GitHub bootstrap can execute guarded landing and return a structured outcome instead of a bare merge call.
4. Update `GitHubBootstrapTracker.executeLanding()` to:
   - fetch fresh gate facts
   - evaluate guarded landing policy
   - fail closed with a reason when the gate is not open
   - execute the merge request only when the policy passes
5. Update orchestrator landing handling and artifacts/status output to preserve non-terminal state and show the guarded refusal reason clearly.
6. Extend the mock GitHub server with mergeability / blocked-merge fixtures needed to simulate guarded refusals.
7. Add tests for unresolved non-outdated review threads, non-terminal checks, non-mergeable PRs, and the PR `#80` regression.
8. Update README / self-hosting docs if they still imply that a `/land` comment alone is sufficient to merge.
9. Run local self-review and repo gates:
   - `pnpm format`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - local review tool if available and reliable

## Tests And Acceptance Scenarios

### Unit

- guarded landing policy rejects when unresolved non-outdated threads remain
- guarded landing policy ignores outdated or resolved threads
- guarded landing policy rejects when checks are pending or non-terminal
- guarded landing policy rejects when GitHub reports not mergeable or unknown mergeability
- guarded landing policy accepts only when all required conditions pass

### Integration

- `GitHubBootstrapTracker.executeLanding()` refuses to merge when unresolved human review threads remain
- `GitHubBootstrapTracker.executeLanding()` refuses to merge when checks are not terminal green
- `GitHubBootstrapTracker.executeLanding()` refuses to merge when GitHub mergeability is false/blocked
- `GitHubBootstrapTracker.executeLanding()` merges successfully when the guard passes

### End-to-End

- factory run reaches `awaiting-landing`, receives `/land`, but remains open because unresolved non-outdated review threads still exist
- factory run reaches `awaiting-landing`, receives `/land`, but remains open because required checks are pending/failing
- regression: the PR `#80` shape with green top-level checks plus unresolved non-outdated review threads is blocked from merge
- clean PR with `/land` and zero unresolved non-outdated threads still lands and completes normally

## Exit Criteria

1. the centralized landing path no longer issues a raw merge request without a fresh merge-gate evaluation
2. merge is rejected when unresolved non-outdated review thread count is non-zero
3. merge is rejected when required checks are not terminal green
4. merge is rejected when the PR is not mergeable or blocked by merge policy
5. guarded refusal reasons are visible in logs/artifacts/status
6. the PR `#80` regression is covered explicitly in automated tests
7. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- standalone operator control commands that expose guarded landing directly
- richer review-bot terminality policy beyond the minimum blocked-check and unresolved-thread gate
- non-GitHub tracker landing guards
- broader landing automation redesign outside the centralized path from `#100`
