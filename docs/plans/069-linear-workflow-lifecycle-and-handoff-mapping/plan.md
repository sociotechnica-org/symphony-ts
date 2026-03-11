# Issue 69 Plan: Linear Workflow Lifecycle And Handoff Mapping

## Status

- plan-ready

## Goal

Map Linear workflow states and ticket-driven handoff facts into Symphony's tracker-neutral `HandoffLifecycle` contract so the orchestrator can recover and continue from normalized handoff outcomes without branching on Linear state names.

## Scope

- add a focused Linear lifecycle policy seam that classifies:
  - configured active states
  - configured terminal states
  - Elixir-aligned Linear workflow states such as `Human Review`, `Rework`, `Merging`, and `Done`
- map Linear workflow state plus ticket facts into tracker-neutral handoff outcomes:
  - `missing-target`
  - `awaiting-human-handoff`
  - `awaiting-system-checks`
  - `actionable-follow-up`
  - `handoff-ready`
- keep Linear-specific lifecycle naming and recovery heuristics inside the tracker policy layer
- preserve repo-owned plan review and follow-up concepts by reusing the checked-in review-marker protocol on the Linear ticket conversation
- define how the Symphony-owned Linear workpad participates in recovery without becoming the only source of truth for human handoff decisions
- add unit and integration coverage for `Human Review`, `Rework`, `Merging`, active, and terminal cases
- update the Linear end-to-end harness only as needed to keep the lifecycle mapping exercised through a real mocked factory loop

## Non-goals

- changing the shared `HandoffLifecycle` domain contract introduced by the generalized handoff work
- moving Linear GraphQL transport or read normalization into the orchestrator
- redesigning the generic `Tracker` interface beyond the adapter-owned lifecycle mapping needed here
- inventing a Linear-specific approval protocol that diverges from the checked-in repo review markers
- adding webhooks, merge automation, or a broader Linear product workflow beyond the tracker policy slice required for `#69`
- broad changes to workspace, runner, or status rendering unless a minimal compatibility update is required by the new mapping

## Current Gaps

- `src/tracker/linear-policy.ts` currently reduces Linear handoff inspection to only:
  - `handoff-ready` when the issue is terminal or the workpad says `handoff-ready`
  - `missing-target` for everything else
- the current Linear lifecycle logic does not distinguish:
  - waiting for human review in a `Human Review` workflow state
  - explicit rework handoff in a `Rework` workflow state
  - system-owned merge / landing wait in a `Merging` workflow state
  - still-active implementation states that should not be interpreted as a finished handoff target
- workpad status is currently enough to record Symphony-owned progress, but not enough to recover the full handoff meaning required by this issue without consulting Linear state and ticket comments together
- Linear comments are already normalized, but the adapter does not yet reuse the checked-in plan review marker protocol on the Linear ticket conversation
- current tests cover claim, completion, and coarse handoff readiness, but not the lifecycle distinctions named in the issue

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the checked-in meaning of `Human Review`, `Rework`, `Merging`, active, and terminal states when mapped into tracker-neutral handoff outcomes
  - does not belong: raw GraphQL envelopes or orchestrator branches on Linear state names
- Configuration Layer
  - belongs: reusing `tracker.active_states` and `tracker.terminal_states` as the configured boundary inputs for Linear lifecycle policy
  - does not belong: interpreting Linear comments or deciding runtime handoff outcomes inside `src/config/`
- Coordination Layer
  - belongs: continuing to consume only normalized `HandoffLifecycle` results
  - does not belong: knowing about `Human Review`, `Rework`, `Merging`, or any other Linear workflow state names
- Execution Layer
  - belongs: no new workspace or runner behavior beyond using the existing branch/workpad facts already produced by a run
  - does not belong: ticket lifecycle interpretation
- Integration Layer
  - belongs: Linear state-name mapping, comment/workpad recovery facts, and adapter-owned lifecycle classification
  - does not belong: follow-up budgeting, retry budgeting, or generic orchestrator decisions
- Observability Layer
  - belongs: preserving actionable lifecycle summaries that describe the normalized handoff wait or follow-up state
  - does not belong: re-implementing Linear policy inside status rendering

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/linear-policy.ts` or a new focused companion module
  - Linear workflow-state mapping
  - Linear ticket-comment / workpad handoff evaluation
  - normalized `HandoffLifecycle` creation
- `src/tracker/linear.ts`
  - narrow call-site changes to use the richer lifecycle policy when inspecting or reconciling handoff state
- shared comment-protocol helpers only if extracting tracker-neutral parsing reduces duplication cleanly
- tests for the Linear lifecycle mapping seam:
  - unit tests for pure policy decisions
  - mock-backed integration tests for tracker behavior
  - e2e updates only if the existing Linear factory harness must exercise the new handoff states to stay realistic
- plan and docs notes that explain the recoverable source of truth across Linear state, conversation, and workpad

### Does not belong in this issue

- changing the orchestrator to branch on Linear state names
- mixing GraphQL query construction and lifecycle policy in one file
- adding a new durable artifact schema or changing issue-report storage contracts
- broad refactors to Linear read transport, normalization, or write transport that are unrelated to lifecycle mapping
- coupling repository plan approval semantics to a hidden local-only flag instead of the Linear ticket conversation

## Layering Notes

- `config/workflow`
  - owns the configured active and terminal state-name inputs
  - does not own lifecycle mapping logic
- `tracker`
  - owns Linear-specific lifecycle semantics, ticket-comment parsing, and workpad-aware handoff recovery
  - does not leak Linear names or raw GraphQL payloads upward
- `workspace`
  - remains responsible only for branch/workspace preparation
- `runner`
  - remains responsible only for agent execution
- `orchestrator`
  - continues to consume tracker-neutral lifecycle kinds and summaries
  - does not compensate for Linear workflow naming
- `observability`
  - surfaces the normalized lifecycle summary already produced by the tracker
  - does not reinterpret raw Linear state names

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by limiting the work to the Linear adapter lifecycle policy seam:

1. enrich the Linear handoff policy so it can classify workflow and ticket facts into `HandoffLifecycle`
2. keep workpad and conversation recovery logic inside the tracker edge
3. add focused tests for the named lifecycle cases
4. leave the orchestrator, workspace, and runner contracts intact

This seam is reviewable on its own because it deliberately defers:

- any tracker-contract redesign
- any Linear transport expansion beyond fields already normalized
- any status-surface redesign
- any broader workflow automation around merge execution or external release systems

## Runtime State Model

The relevant Linear-side runtime facts for this issue are:

- workflow state name
- whether the state is inside `tracker.active_states`
- whether the state is inside `tracker.terminal_states`
- latest recognized repo-owned review marker in ticket comments
- Symphony-owned workpad status and branch name

The adapter-owned handoff evaluation states are:

- `active-implementation`
  - issue is still in configured active work states such as `Todo` or `In Progress`
  - maps to `missing-target`
- `human-review`
  - issue is in `Human Review`, or equivalent configured review wait, and no explicit rework/system-ready signal has superseded it
  - maps to `awaiting-human-handoff`
- `rework`
  - issue is in `Rework`, or the latest explicit review decision requires another run
  - maps to `actionable-follow-up`
- `merging`
  - issue is in `Merging`, meaning the human handoff passed and the system is waiting for merge / landing completion
  - maps to `awaiting-system-checks`
- `terminal`
  - issue is in a configured terminal state such as `Done`
  - maps to `handoff-ready`

### Allowed transitions

- configured active state -> `human-review`
  - run completes and the ticket enters `Human Review`
- `human-review` -> `rework`
  - ticket moves to `Rework` or the latest accepted review marker is `changes-requested`
- `human-review` -> `merging`
  - ticket moves to `Merging` or an approved/waived handoff is reflected in the Linear workflow
- `rework` -> configured active state
  - a fresh run starts another implementation pass
- `rework` -> `human-review`
  - the follow-up run is posted and the issue returns to review
- `merging` -> `terminal`
  - landing completes and the issue reaches `Done` or another configured terminal state
- any non-terminal state with missing or stale workpad branch facts
  - remains recoverable from Linear state plus ticket conversation; workpad refines branch association but should not block lifecycle inference

### Runtime decision rules

- return `missing-target` for configured active states and other pre-handoff conditions
- return `awaiting-human-handoff` when Linear is explicitly waiting for human review
- return `actionable-follow-up` when Linear has entered explicit rework
- return `awaiting-system-checks` when Linear is explicitly waiting on merge / landing
- return `handoff-ready` when the issue reaches a configured terminal state

## Failure-Class Matrix

| Observed condition                                                                                                      | Local facts available                                 | Normalized tracker facts available                            | Expected decision                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Issue is `Todo` or `In Progress` with no workpad                                                                        | branch name only                                      | active state, no review marker                                | `missing-target`; issue is still active work, not a finished handoff                                                       |
| Issue is `Human Review` and latest ticket signal is still pending review                                                | workpad may show `handoff-ready` from the last run    | state name, latest `plan-ready` or equivalent handoff comment | `awaiting-human-handoff`; human decision is still pending                                                                  |
| Issue is `Human Review` but the latest accepted review marker is `changes-requested`                                    | workpad branch from prior run                         | state name plus review decision comment                       | `actionable-follow-up`; rework has been requested even if the workpad still shows the previous run summary                 |
| Issue is `Rework` with no fresh worker run yet                                                                          | previous branch/workpad facts                         | rework state                                                  | `actionable-follow-up`                                                                                                     |
| Issue is `Merging` after approval/waiver                                                                                | previous branch/workpad facts                         | merging state                                                 | `awaiting-system-checks`; wait for landing rather than rerunning                                                           |
| Issue is already terminal (`Done`, configured terminal state)                                                           | workpad may still show `handoff-ready` or `completed` | terminal state                                                | `handoff-ready`; a fresh factory can infer successful handoff from Linear alone                                            |
| Workpad is missing or branch name cannot be matched, but the ticket is `Human Review`, `Rework`, `Merging`, or terminal | none or stale local branch facts                      | state name plus ticket conversation                           | infer lifecycle from Linear state/comments; do not fail only because the workpad is incomplete                             |
| Ticket comments contain no recognized review marker                                                                     | workpad branch and status only                        | workflow state only                                           | use workflow state as the primary lifecycle signal; comments refine review decisions but are not mandatory for every state |

## Storage / Persistence Contract

- no new durable local storage is introduced in this slice
- Linear remains the remote system of record for:
  - workflow state
  - ticket conversation
  - Symphony-owned workpad description block
- recovery should be possible from a fresh factory process by reading:
  - the current Linear issue state
  - the current Linear issue description workpad
  - the normalized Linear issue comments
- workpad data remains advisory tracker-owned metadata for branch and summary continuity; it does not replace explicit human review comments

## Observability Requirements

- `inspectIssueHandoff` summaries should explain why the issue is waiting, ready, or needs follow-up in tracker-neutral terms
- tests should pin summaries closely enough that operators can distinguish:
  - human review wait
  - rework requested
  - merging / landing wait
  - terminal completion
- no new status model is required if the tracker continues to emit the existing `HandoffLifecycle` kinds cleanly

## Implementation Steps

1. Add `docs/plans/069-linear-workflow-lifecycle-and-handoff-mapping/plan.md` and drive the issue through the required plan-review handoff.
2. Refactor the Linear lifecycle policy into a focused seam that can evaluate:
   - active vs terminal config state membership
   - Elixir-aligned workflow names such as `Human Review`, `Rework`, and `Merging`
   - relevant ticket-comment review markers
   - workpad branch/status hints
3. Keep `LinearTracker.inspectIssueHandoff()` as a thin adapter call site that fetches the normalized issue snapshot and delegates lifecycle evaluation to the policy seam.
4. Reuse the checked-in review-marker protocol on Linear comments where that improves recoverability, without making the orchestrator aware of comment parsing.
5. Add unit tests for pure lifecycle mapping:
   - `Human Review` -> `awaiting-human-handoff`
   - `Rework` -> `actionable-follow-up`
   - `Merging` -> `awaiting-system-checks`
   - configured active state -> `missing-target`
   - configured terminal state -> `handoff-ready`
6. Add integration coverage showing that `LinearTracker.inspectIssueHandoff()` returns the expected normalized lifecycle from the mock Linear server for those cases.
7. Update the mocked Linear e2e flow only if the existing test must reflect the new workflow progression explicitly to remain realistic.
8. Run repo gates and self-review before opening the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main`

## Tests And Acceptance Scenarios

### Unit

- `createLinearHandoffLifecycle()` or its replacement maps:
  - `Human Review` to `awaiting-human-handoff`
  - `Rework` to `actionable-follow-up`
  - `Merging` to `awaiting-system-checks`
  - configured active states to `missing-target`
  - configured terminal states to `handoff-ready`
- review-marker parsing on Linear comments honors:
  - `Plan review: approved`
  - `Plan review: changes-requested`
  - `Plan review: waived`
  - without requiring the orchestrator to know those markers directly
- stale or missing workpad data does not prevent lifecycle inference when Linear state already makes the handoff clear

### Integration

- the mock Linear tracker reports `awaiting-human-handoff` when an issue is in `Human Review`
- the mock Linear tracker reports `actionable-follow-up` when an issue is in `Rework`
- the mock Linear tracker reports `awaiting-system-checks` when an issue is in `Merging`
- the mock Linear tracker reports `missing-target` for configured active states
- the mock Linear tracker reports `handoff-ready` for configured terminal states
- ticket comments and the workpad participate in recovery without becoming required hidden local state

### End-to-End Regression

- the existing mocked Linear factory loop still completes successfully after the lifecycle-policy refinement
- if the e2e scenario is updated to pass through `Human Review` or `Merging`, the factory still waits or completes based on the tracker-neutral lifecycle outcome rather than Linear names in the orchestrator

### Repo Gate

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. A Linear issue in `Human Review` is normalized to `awaiting-human-handoff`, and the orchestrator does not need to know the Linear state name.
2. A Linear issue in `Rework` is normalized to `actionable-follow-up`, allowing the existing follow-up path to rerun the worker.
3. A Linear issue in `Merging` is normalized to `awaiting-system-checks`, allowing the orchestrator to wait instead of rerunning or failing.
4. A Linear issue in `Todo` or `In Progress` remains `missing-target` from the handoff perspective even though it is still eligible or active in tracker workflow terms.
5. A Linear issue in `Done` or another configured terminal state is normalized to `handoff-ready`.
6. A fresh factory can infer the relevant handoff state from Linear issue state plus ticket conversation and workpad data without relying on hidden local state.

## Exit Criteria

- the Linear adapter expresses workflow lifecycle semantics through tracker-neutral `HandoffLifecycle` outcomes
- the orchestrator does not branch on Linear state names
- workpad and ticket-comment recovery rules are explicit in code/tests and documented in the plan
- unit and integration coverage prove the named `Human Review`, `Rework`, `Merging`, active, and terminal cases
- the change remains one reviewable PR limited to the Linear lifecycle policy seam

## Deferred To Later Issues Or PRs

- configurable review-state names beyond the Elixir-aligned Linear workflow vocabulary named in this issue
- merge automation or deeper integration with external landing systems
- redesigning the generic tracker contract around richer non-PR handoff metadata
- workflow-config additions for separate Linear review / rework / merging state lists if later adapter work proves the single-slice mapping is too rigid
- broader status-surface or report-schema work driven by Linear-specific lifecycle reporting

## Decision Notes

- Linear workflow names should stay in tracker policy, not in the orchestrator. This issue exists to prove that the current generalized handoff contract is sufficient for a Linear-centered workflow.
- The Linear ticket conversation should remain the source of truth for explicit human review decisions because that keeps the repo-owned plan review protocol inspectable by humans and recoverable by a fresh factory.
- The Symphony-owned workpad should carry branch association and latest run summary because those facts are useful for recovery, but the workpad should not be treated as the sole authority for whether review is approved, waived, or requesting rework.
- If implementation shows repeated GitHub/Linear comment-protocol parsing logic, a small tracker-shared helper is acceptable as long as it stays in the tracker layer and does not widen the PR into a larger tracker abstraction change.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue `#69`.
