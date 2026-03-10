# Issue 68 Plan: Linear Comments And State Transitions

## Status

- approved

## Goal

Backfill the Linear write seam requested by issue `#68` so comment creation, workpad description updates, workflow-state resolution, and issue-state mutations live behind a focused adapter boundary with explicit failure handling, while keeping GraphQL transport details and Linear-specific state names out of the orchestrator.

## Scope

- keep Linear write behavior at the tracker edge and separate it from read normalization
- add a focused write seam for:
  - create comment on a Linear issue
  - resolve a project workflow state by configured state name
  - update a Linear issue description and/or state
- keep workpad rendering in `linear-workpad`, but route the resulting description writes through the focused write seam
- preserve the repository-owned plan review / acknowledgement comment body protocol by ensuring Linear comment writes can carry the same checked-in message bodies without GraphQL details leaking upward
- add focused tests for:
  - successful comment creation
  - successful state resolution and issue state updates
  - missing configured workflow states
  - failed write mutations

## Non-goals

- changing Linear read transport pagination or read normalization contracts
- adding full Linear comment-read support for plan review inspection in `inspectIssueHandoff`
- adding GitHub-style PR, review-thread, or rework lifecycle policy to the Linear tracker
- redesigning the generic `Tracker` interface beyond the write seam needed here
- broad orchestrator, runner, workspace, or status-surface changes

## Current Gaps

- the repository already contains a broader Linear tracker slice from issue `#70`, but the issue-`#68` write seam is still implicit inside [`src/tracker/linear.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/src/tracker/linear.ts)
- comment creation, workpad description writes, and state mutations are currently orchestrated inline in tracker lifecycle methods instead of a dedicated write-focused module
- state resolution by configured name exists in [`src/tracker/linear-policy.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/src/tracker/linear-policy.ts), but issue `#68` does not yet have direct plan-traceable coverage for missing-state failures
- current Linear tests prove broad happy-path tracker behavior, but issue-specific failure coverage for missing states and failed mutations is not isolated as its own reviewable surface
- because the write seam is implicit, future Linear comment-backed protocol work would otherwise keep patching `linear.ts` directly

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: checked-in comment body contracts, configured Linear state names, and the rule that tracker-specific workflow-state policy stays at the edge
  - does not belong: hard-coded Linear state enums inside orchestrator control flow
- Configuration Layer
  - belongs: reusing the existing `tracker.active_states` and `tracker.terminal_states` workflow inputs
  - does not belong: GraphQL mutation construction or project-state lookup logic
- Coordination Layer
  - belongs: no new orchestrator behavior in this slice
  - does not belong: GraphQL mutation variables, state-id lookup, or comment body formatting
- Execution Layer
  - belongs: no new workspace or runner behavior
  - does not belong: tracker writes or Linear workflow-state handling
- Integration Layer
  - belongs: comment-create mutations, issue-update mutations, project-state lookup by configured name, and composition of workpad writes at the tracker edge
  - does not belong: leaking raw GraphQL envelopes or operation names into the orchestrator
- Observability Layer
  - belongs: deterministic `TrackerError` failures for missing states and failed writes, plus tests that prove those messages stay actionable
  - does not belong: a new Linear-only operator dashboard or status model

## Architecture Boundaries

### Belongs in this issue

- [`src/tracker/linear.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/src/tracker/linear.ts)
  - narrow call-site changes so the tracker composes a dedicated write seam instead of inlining comment/state mutation steps
- a new focused Linear write module, for example `src/tracker/linear-write.ts`
  - state resolution by configured name against a normalized project snapshot
  - comment-create calls
  - description/state mutation calls
  - failure handling that stays tracker-owned rather than orchestrator-owned
- [`src/tracker/linear-policy.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/src/tracker/linear-policy.ts)
  - only the minimal changes needed if state-selection helpers should return configured state names while the write seam owns id resolution
- [`tests/integration/linear-client.test.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/tests/integration/linear-client.test.ts) and/or [`tests/integration/linear.test.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/tests/integration/linear.test.ts)
  - focused coverage for comment creation, state updates, and write failures against the mock Linear surface
- [`tests/unit/linear-policy.test.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_68/tests/unit/linear-policy.test.ts) or a new focused write-module unit test
  - direct coverage for missing configured state names and deterministic error text

### Does not belong in this issue

- moving Linear read normalization into the client or mixing it with writes
- adding comment-read pagination or plan-review comment inspection for Linear
- changing orchestrator retry, continuation, reconciliation, lease, or handoff-state logic
- reopening the full vertical slice from issue `#70`
- one hot file that mixes read transport, write transport, normalization, and lifecycle policy

## Layering Notes

- config/workflow
  - owns the configured state-name inputs
  - does not own Linear project-state lookup or mutations
- tracker
  - owns comment/state write behavior and the mapping from tracker policy decisions to write calls
  - does not push GraphQL payload parsing or mutation envelopes upward
- workspace
  - untouched
- runner
  - untouched
- orchestrator
  - remains tracker-neutral and consumes only the existing `Tracker` contract
- observability
  - keeps typed, actionable tracker failures without adding tracker-specific control flow

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by carving the existing broader Linear implementation at the write boundary instead of adding a new vertical feature:

1. extract a dedicated Linear write seam from `linear.ts`
2. keep state-name selection policy and state-id resolution separated
3. add focused tests for the issue-`#68` write and failure cases
4. avoid touching orchestrator behavior or broader Linear read paths

This seam is reviewable because it deliberately defers:

- Linear comment-read protocol handling
- PR/review lifecycle parity with GitHub
- any tracker-contract redesign
- any broader status-surface or artifact changes

## Runtime State Model

Not applicable for this slice. The work is limited to tracker-edge write seams and does not change retries, continuations, reconciliation, leases, or orchestrator handoff-state transitions.

## Failure-Class Matrix

| Observed condition                                                          | Local facts available                          | Normalized tracker facts available | Expected behavior                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| configured claim/terminal state name is not present in the project workflow | workflow-config state names                    | normalized project states          | throw `TrackerError` naming the missing configured state before sending a mutation |
| comment-create GraphQL mutation returns `errors`                            | operation name and GraphQL errors              | none                               | surface the existing operation-specific `TrackerError` from the transport boundary |
| issue-update mutation returns `success: false`                              | normalized mutation payload                    | prior normalized issue snapshot    | throw `TrackerError` naming the failed mutation                                    |
| issue-update mutation reports success but omits the issue payload           | normalized mutation payload                    | none                               | throw `TrackerError` from mutation normalization                                   |
| issue-update HTTP request fails                                             | operation name, status code or transport error | none                               | surface deterministic transport failure without fallback                           |
| description-only write succeeds but state update is not requested           | mutation input                                 | prior project snapshot             | update the workpad/comment state without requiring a state transition              |

## Storage / Persistence Contract

- no new durable storage is introduced
- remote Linear issues remain the system of record for comments, descriptions, and workflow states
- local factory status and issue artifacts remain unchanged
- the new write seam, if added, remains an in-memory composition boundary inside the tracker layer

## Observability Requirements

- missing-state errors must name the configured state and project slug
- failed write operations must preserve the existing operation-specific `TrackerError` messages
- tests should prove that callers above the tracker do not need to inspect GraphQL envelopes to diagnose failures
- no new log surface is required beyond existing tracker logging unless the extraction naturally preserves current messages

## Implementation Steps

1. Add `docs/plans/068-linear-comments-and-state-transitions/plan.md` and drive it through the required issue-comment review station.
2. Extract a focused Linear write seam from `linear.ts` that owns:
   - comment creation
   - issue description writes
   - issue state writes
   - resolution of workflow state ids from configured state names
3. Keep `linear-policy.ts` responsible for choosing which configured state name should be used for claim/completion, while the write seam resolves that name against the current project snapshot.
4. Update `LinearTracker` to compose the write seam for:
   - claim
   - retry recording
   - failure recording
   - handoff-ready workpad/comment writes
   - completion state transitions
5. Add focused tests for:
   - successful comment creation
   - successful state update using a configured state name
   - missing configured claim or terminal state
   - failed comment-create or issue-update mutations
6. Run repo gates and self-review:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main`

## Tests And Acceptance Scenarios

### Unit

- resolving a configured Linear state name returns the matching workflow state id
- resolving a missing configured state name throws a `TrackerError` that names the project and state
- choosing a claim state does not require hard-coded orchestrator enums

### Integration

- the Linear adapter can create a comment against the mock GraphQL surface and the tracker caller only receives normalized issue data
- the Linear adapter can update issue state by configured state name without exposing GraphQL details above the tracker
- a failed `CreateComment` mutation surfaces a deterministic `TrackerError`
- a failed `UpdateIssueState` or combined issue-update mutation surfaces a deterministic `TrackerError`
- claim and completion paths still move issues into the configured workflow states through the dedicated write seam

### End-to-End Regression

- the existing mocked Linear factory e2e path still completes successfully after the write-seam extraction

### Repo Gate

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. Given a mocked Linear project with configured active and terminal workflow states, Symphony can resolve the corresponding state ids and move an issue between those states.
2. Given a mocked Linear issue, Symphony can create issue comments and workpad-backed description updates without leaking GraphQL envelopes into the orchestrator.
3. Given a configured state name that is absent from the Linear project workflow, Symphony fails loudly with a tracker-owned error.
4. Given a failed comment-create or issue-update mutation, Symphony surfaces a deterministic failure and does not silently continue.
5. The existing Linear end-to-end factory loop still succeeds after the write seam is extracted.

## Exit Criteria

- Linear comment creation, workpad description writes, and state transitions are owned by a focused tracker-edge write seam
- configured workflow state names remain workflow inputs, not orchestrator enums
- missing states and failed writes are covered by focused tests
- raw GraphQL response details remain confined to the Linear transport and tracker layers
- the change lands as one reviewable PR without bundling broader Linear lifecycle work

## Deferred To Later Issues Or PRs

- reading Linear comments to evaluate plan-review handoff decisions
- full plan-review acknowledgement behavior on Linear issue comments
- richer Linear lifecycle policy beyond the current claim/retry/failure/handoff/completion paths
- tracker-contract changes for arbitrary tracker comment surfaces
- webhook, agent-session, or PR-style Linear review features

## Decision Notes

- The repository already merged a broader Linear vertical slice in PR `#73` for issue `#70`. This issue should not reopen that broad surface. It should extract and harden the write seam that `#68` originally called for so the change remains traceable and reviewable.
- State names remain a policy/config concern. State ids are transport/integration details and should be resolved at the tracker edge immediately before mutation calls.
- Preserving the plan-review comment protocol here means preserving the checked-in comment-body contract on the Linear comment surface, not implementing full Linear comment-read handoff policy in this slice.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue `#68`.
- 2026-03-10: Plan approved in the issue review station; implementation started on the extracted Linear write seam.
