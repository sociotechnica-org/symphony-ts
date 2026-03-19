# Issue 194 Plan: Queue Ordering And Observability Projection For Tracker-Native Priority

## Status

- plan-ready

## Goal

Make the orchestrator prefer normalized tracker-native `issue.queuePriority` when ordering ready work for dispatch, while preserving existing precedence for running issues and due retries, and expose enough tracker-neutral ordering detail in the status snapshot for operators and tests to see why one ready issue won.

## Scope

- update ready-issue ordering in the orchestrator to use the shared queue-priority comparator before falling back to deterministic issue-number ordering
- preserve existing queue precedence for running issues, due retries, and dispatch-pressure pauses
- add a tracker-neutral observability projection that shows the ready queue ordering facts relevant to dispatch decisions
- cover the new ordering and status projection with focused unit tests and any small integration assertions needed to keep the operator contract stable
- document the operator-visible ordering behavior briefly where the status surface contract is already described

## Non-goals

- GitHub or Linear transport changes for queue priority
- changes to the normalized `QueuePriority` contract from `#192`
- tracker-specific schema details in status output or orchestrator policy
- retry-budget, continuation-turn, reconciliation, lease, or landing-flow redesign
- broad TUI or report redesign beyond the minimal tracker-neutral projection required for this slice
- adding a new dispatch heuristic that combines queue priority with host preference, review state, or other policy outside the existing precedence model

## Current Gaps

- `src/orchestrator/service.ts` still sorts merged queue entries by source and then issue number, so ready issues ignore normalized `issue.queuePriority`
- the ready/running merge logic preserves the right high-level precedence today, but the ready-work subsection is still incidental rather than explicitly priority-aware
- `src/orchestrator/status-state.ts` and `src/observability/status.ts` expose active issues and retries, but they do not project any tracker-neutral explanation of ready-work queue ordering
- operators therefore cannot inspect from the status snapshot which ready issue would dispatch next or whether tracker-native priority influenced that decision
- current queue-priority tests prove the comparator contract in isolation, but they do not prove the live orchestrator actually uses it

## Decision Notes

- Keep the policy seam narrow: this issue should only change how already-ready issues are ordered relative to each other.
- Preserve the current top-level precedence contract: running follow-up work and due retries stay ahead of fresh ready issues, and dispatch-pressure pauses still block new ready dispatch.
- Keep observability tracker-neutral by projecting normalized queue-priority rank/label and a dispatch-order explanation, not GitHub Projects or Linear-native fields.
- Prefer a small explicit status projection for queued ready candidates over overloading active-issue snapshots, because ready candidates are not yet active runs.
- Keep the ordering logic in a small pure helper or narrowly-scoped orchestrator seam so tests can prove the policy without depending on tracker adapters.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining that normalized queue priority orders already-ready work before issue-number fallback
  - belongs: documenting that running/retry precedence remains unchanged
  - does not belong: tracker-native field parsing or provider-specific priority semantics
- Configuration Layer
  - belongs: no new config in this slice; existing queue-priority config remains the policy input at the tracker boundary
  - does not belong: a second repo-owned switch for orchestrator ordering or observability
- Coordination Layer
  - belongs: merged queue ordering that prefers normalized queue priority among ready issues only
  - belongs: explicit precedence between running work, due retries, and ready work
  - does not belong: raw tracker payload parsing or tracker-specific queue semantics
- Execution Layer
  - belongs: no changes
  - does not belong: dispatch ordering policy or ready-queue observability
- Integration Layer
  - belongs: continuing to provide normalized `issue.queuePriority` facts through `RuntimeIssue`
  - does not belong: new GitHub or Linear transport/normalization work in this issue
- Observability Layer
  - belongs: status snapshot and rendering updates that project normalized ready-queue ordering facts for operators
  - does not belong: a broader status/TUI/report redesign or tracker-specific schema output

## Architecture Boundaries

### Belongs in this issue

- `src/orchestrator/service.ts`
  - apply queue-priority ordering to ready candidates before or within queue merge
  - keep running / retry precedence unchanged and explicit
- a small pure ordering helper if the existing comparator alone is not enough
  - centralize ready-candidate ordering semantics so tests do not rely on incidental sort branches
- `src/orchestrator/status-state.ts`
  - build a tracker-neutral snapshot of ready-queue ordering facts
- `src/observability/status.ts`
  - extend the persisted snapshot contract and textual rendering for the new ready-queue projection
- orchestrator and observability tests
  - prove both dispatch behavior and operator-visible projection
- concise doc updates in `README.md` and/or observability docs where snapshot fields are described

### Does not belong in this issue

- tracker adapter transport, normalization, or config refactors
- queue-priority contract changes in `src/domain/issue.ts`
- host dispatch policy changes beyond preserving the current precedence rules
- broad active-issue lifecycle refactors
- report-generation changes unless a status-contract assertion requires a tiny shared type adjustment

## Layering Notes

- `config/workflow`
  - untouched
  - should not gain orchestration-order switches for this slice
- `tracker`
  - continues to supply normalized `queuePriority`
  - should not gain dispatch-order policy or status-specific formatting
- `workspace`
  - untouched
  - should not carry ready-queue policy
- `runner`
  - untouched
  - should not know why a ready issue won the queue
- `orchestrator`
  - owns the ready-queue ordering decision and the high-level precedence model
  - should consume only normalized `RuntimeIssue` facts
- `observability`
  - owns the snapshot/rendered explanation of the ordering
  - should not become the source of truth for the dispatch policy

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by limiting the change to a single coordination/observability seam:

1. switch ready-work ordering to normalized queue priority plus deterministic fallback
2. preserve existing running and retry precedence
3. project the ready ordering through the status snapshot
4. add tests and a concise doc note

This stays reviewable because it does not combine:

- tracker transport or normalization work from `#191` / `#193`
- retry/reconciliation state-machine changes
- host-routing refactors
- broader TUI or report redesign

## Runtime State Model

This slice does not add new runtime states, but it does change the dispatch selection rule within the existing queue merge. The relevant decision model should be explicit in code and tests:

1. `running candidate`
   - issue is already in `runningCandidates`
   - remains ahead of fresh ready work
2. `due retry candidate`
   - issue has a queued retry that is due now
   - preserves existing attempt accounting and queue precedence
3. `ready candidate`
   - issue is eligible from `fetchReadyIssues()`
   - ordered by normalized queue priority, then issue number
4. `dispatch paused`
   - active dispatch pressure suppresses fresh ready dispatch
   - running inspection and due-retry listing behavior remains unchanged

Allowed ordering transitions in the merged queue:

- running vs ready: running remains first
- retry-backed running/ready candidate vs non-retry ready candidate: existing retry precedence remains first
- ready vs ready: compare `issue.queuePriority`, then issue number
- paused dispatch vs ready queue: ready queue is projected for observability if useful, but not consumed for new dispatch while paused

## Failure-Class Matrix

| Observed condition                                          | Local facts available                 | Normalized tracker facts available          | Expected behavior                                                                                        |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Two ready issues both have populated normalized priority    | ready candidate list                  | both `queuePriority` values populated       | lower rank sorts first; issue-number fallback used only on ties                                          |
| One ready issue has priority and another does not           | ready candidate list                  | one populated `queuePriority`, one `null`   | prioritized issue sorts first; unprioritized issue remains eligible                                      |
| All ready issues have `queuePriority: null`                 | ready candidate list                  | all priorities absent                       | preserve deterministic issue-number ordering                                                             |
| Running candidate and ready candidate are both present      | merged queue inputs                   | ready issue may have high priority          | running candidate remains ahead; queue priority only reorders ready-vs-ready                             |
| Due retry exists while ready issues are available           | retry queue plus ready candidate list | ready issues may have priority              | existing due-retry precedence remains unchanged                                                          |
| Dispatch pressure is active                                 | dispatch-pressure state               | ready issues may carry normalized priority  | do not dispatch fresh ready work; status stays explicit about pause posture and queue facts if projected |
| Status snapshot written during a poll with ready candidates | runtime status state                  | normalized queue priorities on ready issues | snapshot projects ready order deterministically without tracker-specific fields                          |
| Status snapshot is read from disk after the poll            | persisted JSON snapshot               | projected ready-order facts only            | operators can see which ready issue would win and why without reconstructing tracker order manually      |

## Storage / Persistence Contract

- no new durable control-plane storage
- extend the persisted status snapshot JSON only as needed to carry the ready-queue projection
- keep the projection tracker-neutral and derived from current in-memory ready candidates
- avoid persisting raw tracker payloads or provider-specific field identifiers

## Observability Requirements

- the status snapshot should expose enough information to inspect ready-queue ordering, including issue identity and normalized queue-priority facts when present
- the rendered status output should make clear that running issues and retries are separate from the ready queue and that queue priority only influences ready-vs-ready ordering
- snapshot parsing must validate any new ready-queue fields clearly so stale/corrupt status files fail with actionable errors
- tests should lock in both the JSON contract and rendered status summary for the new projection

## Implementation Steps

1. Identify the narrowest seam for ready-candidate ordering in `src/orchestrator/service.ts`, and refactor it only if needed so the precedence rules remain explicit.
2. Apply `compareRuntimeIssuesByQueuePriority` to the ready-work subsection of the merged queue while preserving existing ordering for running candidates and due retries.
3. Add a small tracker-neutral ready-queue snapshot type to the status contract that captures issue number, identifier/title, and normalized queue-priority facts relevant to ordering.
4. Populate that projection in `src/orchestrator/status-state.ts` from the current ready candidates or merged ready subsection without leaking tracker-specific details.
5. Update `src/observability/status.ts` to serialize, parse, and render the ready-queue ordering projection clearly.
6. Add unit coverage for:
   - ready-vs-ready dispatch ordering by normalized queue priority
   - unchanged running/retry precedence
   - snapshot contract round-trip for the new ready-queue projection
   - rendered status output that explains the queue order
7. Add or update orchestrator tests that prove the live dispatcher starts the highest-priority ready issue first.
8. Update concise operator-facing docs describing that the status snapshot now exposes ready-queue ordering and that queue priority only affects ready-vs-ready dispatch.
9. Run local self-review plus repo checks before PR creation.

## Tests And Acceptance Scenarios

### Unit

- merged queue keeps running candidates ahead of ready candidates even when a ready issue has a better normalized priority
- ready candidates sort by lower normalized `queuePriority.rank` first
- ready candidates with equal or missing priority fall back to issue number ascending
- status snapshot parse/render round-trips the ready-queue projection
- status rendering includes the projected queue-priority explanation without tracker-specific fields

### Integration

- orchestrator `runOnce()` starts the highest-priority ready issue first when multiple ready issues are available and capacity is constrained
- existing due-retry and running follow-up scenarios remain unchanged after the ordering update

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- local self-review when a reliable review command is available

## Acceptance Scenarios

1. Given two ready issues with normalized priorities `rank=0` and `rank=2`, a single available slot dispatches the `rank=0` issue first.
2. Given one ready issue with normalized priority and one without, the prioritized issue dispatches first and the other remains next in deterministic order.
3. Given two ready issues with equal normalized rank, dispatch falls back to issue number ascending.
4. Given a running issue plus multiple ready issues, the running issue still takes precedence regardless of ready-work priority.
5. Given a due retry plus multiple ready issues, the due retry still keeps its existing precedence behavior.
6. Given a status snapshot published during a poll, operators can inspect the projected ready queue and see the normalized priority facts that explain the winning ready issue.
7. Given no normalized priority on any ready issue, the status snapshot still shows deterministic fallback order without implying tracker-native priority was used.

## Exit Criteria

- ready-work dispatch in the orchestrator uses normalized queue priority before issue-number fallback
- existing running/retry/dispatch-pressure precedence remains intact
- the status snapshot projects ready-queue ordering facts in a tracker-neutral contract
- tests prove both the live dispatch behavior and the operator-visible projection
- docs briefly explain the new operator-visible queue-ordering surface

## Deferred To Later Issues Or PRs

- richer TUI visualization of queue priority beyond the base status snapshot/rendering contract
- report-generation changes centered on historical queue-order analysis
- new queue heuristics that combine tracker-native priority with host preference, aging, or cost signals
- further tracker adapter work beyond consuming the normalized priority facts already produced by `#191` and `#193`

## Revision Log

- 2026-03-19: Initial draft created for issue `#194` and marked `plan-ready`.
