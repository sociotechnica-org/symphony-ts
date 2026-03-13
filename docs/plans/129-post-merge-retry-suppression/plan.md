# Issue 129 Plan: Post-Merge Retry Suppression And Terminal Reconciliation

## Status

- plan-ready

## Goal

Make merged tracker state authoritative when it races with local failure handling, so the factory stops scheduling retries, stops publishing stale failure outcomes, and converges quickly to one landed terminal story after the active PR has merged.

## Scope

- define explicit terminal precedence for merged PR state over local retry/failure transitions
- add a coordination-layer reconciliation path that refreshes handoff state before retry enqueue or terminal failure publication when a run ends unsuccessfully
- cancel or suppress stale retry queue entries once the tracker reports the active PR has merged
- keep issue artifacts and status snapshots coherent when merge is observed during or immediately after a failed attempt
- add unit, integration, observability, and end-to-end regression coverage for the reproduced race windows

## Non-Goals

- redesigning guarded landing policy, `/land` authorization, or merge execution semantics
- changing runner continuation policy outside the narrow merge-dominates-failure rule
- redesigning tracker transport or broad GitHub lifecycle normalization
- introducing new tracker backends or changing Linear-specific lifecycle policy
- reworking watchdog/lease recovery beyond any minimal compatibility adjustments required by the new terminal reconciliation helper

## Current Gaps

- `src/orchestrator/service.ts` schedules retries in `#scheduleRetryOrFail()` directly from local failure state without first checking whether the tracker has already crossed into terminal merged state.
- `#handleFailure()` records `attempt-failed` immediately, then `#scheduleRetryOrFail()` may persist `retry-scheduled` or `failed` even if a PR merged between the last lifecycle refresh and local run completion.
- `#collectDueRetries()` and `#mergeQueue()` treat queued retry entries as locally authoritative until the next running-issue refresh path happens to observe merge.
- `#pruneStaleActiveIssues()` retains retry-backed active issues, so stale retry state can continue to surface after the tracker has already converged elsewhere.
- Existing tests cover merged completion after a clean handoff path and already-merged landing races, but they do not pin the failure-time race where merge happens while a run is still active or while retry bookkeeping is being decided.
- Issue comment context on March 13, 2026 explicitly asked for revalidation on current `main`; the current code still appears vulnerable because the failure branch has no tracker refresh before retry/fail decisions.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the rule that merged terminal tracker state dominates stale local failure and retry signals
  - does not belong: GitHub API field inspection or artifact file parsing details
- Configuration Layer
  - belongs: no workflow/config changes in this slice
  - does not belong: new retry knobs or tracker-specific policy flags
- Coordination Layer
  - belongs: explicit runtime-state transitions for failed attempts, retry scheduling, retry suppression, and merged terminal reconciliation
  - does not belong: raw tracker transport logic or GitHub-specific PR field branching
- Execution Layer
  - belongs: cancellation/stop behavior only insofar as an in-flight run result must be ignored once merged terminal state is observed
  - does not belong: runner prompt construction, workspace preparation, or merge policy
- Integration Layer
  - belongs: exposing the normalized merged handoff state needed by coordination before retry/fail transitions
  - does not belong: coordination-owned retry suppression or artifact precedence rules
- Observability Layer
  - belongs: status snapshot and artifact/report ordering that preserve the landed terminal story once merge wins
  - does not belong: deciding whether retries are allowed

## Architecture Boundaries

### Belongs in this issue

- `src/orchestrator/service.ts`
  - add a narrow helper that refreshes current handoff lifecycle before retry/fail transitions
  - suppress retry enqueue and failed-terminal publication when refreshed lifecycle is `handoff-ready`
  - clear stale retry and active issue state when merge wins
- `src/orchestrator/`
  - extract any small runtime-state helper needed to make retry suppression and merged-terminal cleanup explicit instead of scattering counter/map edits
- `src/tracker/service.ts`
  - keep the existing normalized `reconcileSuccessfulRun()` / `inspectIssueHandoff()` contract usage clear; only widen the contract if implementation proves a narrow helper is needed
- `src/observability/issue-artifacts.ts`, `src/observability/issue-report.ts`, or related helpers
  - only the minimum changes needed so post-merge stale failure/retry observations cannot remain the latest story
- focused test builders/helpers if repeated merged-race fixture setup appears in multiple tests

### Does not belong in this issue

- GitHub transport refactors that mix API calls, normalization, and policy into one file
- guarded-landing artifact taxonomy redesign beyond narrow compatibility updates
- watchdog retry-budget redesign
- broad status-TUI redesign
- any change that makes the orchestrator infer merge from raw GitHub fields instead of normalized tracker lifecycle

## Layering Notes

- `config/workflow`
  - unchanged in this slice
- `tracker`
  - remains the source of truth for whether the current PR has actually merged
  - does not own retry suppression decisions
- `workspace`
  - unchanged except existing cleanup-on-success behavior should still run when failure-time refresh discovers terminal merge
- `runner`
  - unchanged except its late failed result may be downgraded to stale once merged terminal state is observed
- `orchestrator`
  - owns retry suppression, stale-local-failure cancellation, and runtime-state cleanup
  - does not branch on GitHub-specific `merged_at` or PR REST payloads
- `observability`
  - reflects the winning merged terminal outcome
  - does not invent terminal precedence rules on its own

## Slice Strategy And PR Seam

Keep this as one reviewable PR centered on coordination-layer terminal reconciliation:

1. add a narrow failure-time tracker refresh/reconciliation helper
2. make merged state clear retry queue and suppress late failure publication
3. update observability consumers only where they currently preserve the stale failure story
4. add regression coverage for the exact race windows

This seam is reviewable because it avoids:

- guarded landing redesign
- tracker transport changes
- runner contract changes
- watchdog and lease refactors unrelated to merged-terminal precedence

## Runtime State Model

This issue changes stateful orchestration behavior, so the retry/reconciliation transitions must stay explicit.

### States relevant to this issue

- `running`
  - an attempt is active locally
- `attempt-failed-pending-reconcile`
  - the local attempt ended unsuccessfully, but terminal tracker refresh has not yet decided whether the failure is stale
- `retry-scheduled`
  - the issue remains active and a later retry attempt is queued
- `failed`
  - retry budget is exhausted and no terminal merged state was observed
- `awaiting-landing` / `awaiting-system-checks` / `awaiting-human-review` / `rework-required`
  - normalized non-terminal tracker states that may still justify keeping the issue active or rerunning
- `merged-terminal`
  - the tracker reports `handoff-ready` because the active PR has merged; this wins over local failure and retry signals
- `succeeded`
  - the orchestrator has persisted terminal success, completed the issue, and cleaned local retry/runtime state

### Allowed transitions relevant to this issue

- `running` -> `attempt-failed-pending-reconcile`
  - local runner turn or attempt ends unsuccessfully
- `attempt-failed-pending-reconcile` -> `retry-scheduled`
  - refreshed lifecycle remains non-terminal and retry budget remains available
- `attempt-failed-pending-reconcile` -> `failed`
  - refreshed lifecycle remains non-terminal and retry budget is exhausted
- `attempt-failed-pending-reconcile` -> `merged-terminal`
  - refreshed lifecycle reports merged PR / terminal handoff-ready
- `retry-scheduled` -> `merged-terminal`
  - next poll refresh observes merged PR before the queued retry starts
- `merged-terminal` -> `succeeded`
  - orchestrator completes the issue, clears retry/runtime state, and persists terminal success artifacts/status

### Coordination decision rules

- never schedule a new retry once merged terminal state has been observed for the current issue/branch
- never publish a new terminal `failed` issue outcome after merged terminal state has been observed
- if a local failure arrives after merge, preserve attempt-level evidence only if needed for forensics, but the issue-level current outcome must converge to landed success
- clear queued retry state and blocked/running status entries when merge wins
- keep tracker-normalized merged state authoritative across restart/reconciliation, not only inside a single live run

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Runner fails before any PR exists | failed local attempt, no retry yet | `missing-target` or other non-terminal lifecycle | follow existing retry/fail behavior |
| Runner fails after PR exists but before merge | failed local attempt | non-terminal lifecycle such as `awaiting-system-checks`, `rework-required`, or `awaiting-landing` | follow existing retry/fail behavior |
| PR merges while runner is still active, then runner exits non-zero | failed local attempt, session artifacts available | refreshed lifecycle is terminal `handoff-ready` | suppress retry/fail, complete issue, landed outcome wins |
| Runner fails, then PR merges before retry enqueue | failed local attempt, retry budget available | refreshed lifecycle is terminal `handoff-ready` | do not call `recordRetry()`, do not persist `retry-scheduled`, complete issue |
| Retry already queued locally, PR merges before next attempt starts | retry entry exists, no active run | next poll sees terminal merged running/ready state or terminal refresh of retry target | clear retry entry, complete issue, do not start another attempt |
| Retry budget exhausted locally, but merge is observed before `markIssueFailed()` | exhausted retry budget | refreshed lifecycle is terminal `handoff-ready` | do not mark failed; complete issue instead |
| Factory restarts with stale retry entry after merge | retry queue/state recovered locally | tracker reports terminal merged state for issue branch | drop retry state during reconciliation and preserve landed terminal outcome |

## Storage / Persistence Contract

- no new durable store is introduced
- issue artifact schema should stay backward compatible unless implementation proves a narrow additive event/detail is necessary
- issue-level `currentOutcome` and latest terminal summary must converge to success after merge even if earlier attempt-failed or retry-scheduled observations remain in history
- retry queue state remains in-memory, but runtime-state cleanup must ensure stale entries do not survive once merged terminal state is observed in the current process or after restart reconciliation

## Observability Requirements

- status snapshots must not continue to show a retrying or failed issue after merged terminal state has won
- issue artifact summaries must not leave `retry-scheduled` or `failed` as the latest issue-level outcome for a merged issue
- per-issue report inference and campaign/report aggregation must continue to resolve the final outcome as landed success when stale failure/retry events exist earlier in history
- logs/status actions should make the suppression explicit enough for operators to understand why a local failure did not trigger another retry

## Decision Notes

- Keep merge detection tracker-normalized. The orchestrator should ask the tracker for the current lifecycle, not inspect GitHub REST payloads directly.
- Prefer one narrow reconciliation helper around failure-time transitions rather than sprinkling ad hoc merged checks into multiple failure branches.
- Preserve attempt-level failure evidence if it is already recorded, but treat it as historical once a merged terminal issue-level observation is written.
- If retry suppression requires more than a couple of coordinated map updates, extract a named runtime-state helper so retry cleanup stays explicit and testable.

## Implementation Steps

1. Revalidate the reproduced race on current `main` via targeted tests or a focused mock scenario so the branch records the exact failing path being fixed.
2. Add a coordination helper that, after a failed local attempt and before retry/fail transitions, refreshes the current lifecycle for the issue branch and returns either:
   - merged terminal completion
   - continue existing retry/fail handling
3. Update `#handleFailure()` / `#scheduleRetryOrFail()` so:
   - `recordRetry()` is skipped when merged terminal state is observed
   - `markIssueFailed()` is skipped when merged terminal state is observed
   - stale retry/runtime/status state is cleared before terminal success is recorded
4. Update due-retry reconciliation so a queued retry cannot start once merged state is observed on a later poll or restart.
5. Update artifact/status publication so the issue-level latest outcome converges to success after merge and no stale retry/failure observation remains the current story.
6. Add or extract small runtime-state helpers if needed for:
   - clearing retries
   - clearing active issue state
   - preserving attempt/session metadata while promoting the issue to success
7. Add regression coverage for:
   - unit state transitions around failure-time merge detection
   - orchestrator integration with mocked tracker lifecycle flips
   - issue artifact/report inference for stale failure-before-merge histories
   - bootstrap e2e race where merge happens during a long-running attempt
8. Run local self-review and repo gates before opening/updating the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- failure handling suppresses retry when lifecycle refresh returns terminal merged state
- failure handling suppresses `markIssueFailed()` when retry budget is exhausted but merged state is observed first
- retry queue cleanup removes stale entries when merged terminal state wins
- issue-level artifact/outcome selection keeps merged success authoritative over prior attempt-failed/retry-scheduled observations

### Integration

- mocked tracker flips a PR to merged while a run is still active and the orchestrator completes the issue instead of retrying
- mocked tracker flips a PR to merged after failure detection but before retry enqueue and `recordRetry()` is never called
- mocked tracker flips a PR to merged after retry enqueue but before next attempt start and the retry is dropped during the next reconciliation/poll

### End-to-end

- bootstrap-factory mocked GitHub scenario where a PR merges during a long-running or failing attempt produces:
  - no post-merge retry noise
  - no terminal failed issue artifact
  - a final landed/succeeded issue story in status and reports

### Acceptance Scenarios

1. A PR merges while the active coding attempt is still running. The attempt later exits with failure, but the factory completes the issue and does not enqueue retry attempt `N+1`.
2. A failure is detected locally, but the tracker refresh before retry bookkeeping sees the PR already merged. The issue never records a new `retry-scheduled` or `failed` current outcome.
3. A retry was already queued before merge, but the next poll sees the PR merged and drops the retry instead of dispatching it.
4. After restart, reconciliation preserves the landed outcome and does not resurrect stale retry state.
5. Per-issue reports and aggregate reporting continue to classify the issue as merged/succeeded rather than failed.

## Exit Criteria

- merged terminal state explicitly suppresses retry scheduling and terminal failure publication
- stale queued retries are cleared once merge is observed
- issue artifacts and status snapshots converge to one coherent landed outcome after the reproduced race
- regression coverage exists for the failure-time and queued-retry race windows
- the change remains a single reviewable PR focused on coordination-layer terminal reconciliation plus minimum integration/observability support

## Deferred To Later Issues Or PRs

- broader retry-state model redesign beyond the narrow merged-terminal precedence rule
- watchdog or lease-policy redesign
- generalized artifact compaction or historical event rewriting
- non-GitHub tracker lifecycle changes unless a minimal shared helper needs narrow compatibility work
