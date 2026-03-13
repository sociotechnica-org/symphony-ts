# Issue 131 Plan: Guarded Landing Merged Lifecycle Semantics

## Status

- plan-ready

## Goal

Correct guarded-landing reporting for the race where a PR is already merged by the time guarded landing runs. The factory should keep converging as it does today, but durable artifacts, summaries, and report inference must record semantics that match the observed merged state instead of persisting `awaiting-landing`.

## Scope

- add a distinct guarded-landing lifecycle/outcome semantic for "already merged"
- update the guarded-landing result contract and GitHub bootstrap landing path to emit that semantic
- update issue artifact typing, report inference, and any related observability rendering that consumes landing-blocked lifecycle details
- add regression coverage for the policy result, artifact emission, report inference, and the integration race where a PR merges between inspection and landing

## Non-goals

- redesigning the full handoff lifecycle domain beyond the minimal shared type needed here
- changing guarded-landing behavior for non-merged block reasons
- changing merge authorization rules, `/land` policy, or merge execution transport
- redesigning retry budgeting, continuation flow, or tracker reconciliation
- broad tracker refactors outside the guarded-landing and artifact/report seam

## Current Gaps

- `src/tracker/guarded-landing.ts` maps `landingState === "merged"` to `lifecycleKind: "awaiting-landing"` even though the summary says the PR is already merged
- `src/tracker/service.ts` only allows blocked landing lifecycle kinds that represent non-merged waiting or rework states
- `src/orchestrator/service.ts` persists landing-blocked artifacts directly from `result.lifecycleKind`, so the incorrect guarded-landing value becomes a durable artifact event
- `src/observability/issue-artifacts.ts` and `src/observability/issue-report.ts` do not currently have a distinct outcome/inference path for the already-merged landing race
- regression coverage currently codifies the wrong lifecycle kind in unit tests and does not pin report inference for this path

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining that "already merged" is semantically distinct from "still awaiting landing" when guarded landing evaluates a PR snapshot
  - does not belong: GitHub transport details or report file parsing
- Configuration Layer
  - belongs: no workflow/config changes in this slice
  - does not belong: lifecycle semantics, landing result typing, or observability classification
- Coordination Layer
  - belongs: orchestrator persistence of the normalized guarded-landing result into issue artifacts without rewriting tracker semantics
  - does not belong: GitHub-specific detection of merged PR state
- Execution Layer
  - belongs: unchanged workspace and runner behavior
  - does not belong: landing policy or artifact interpretation
- Integration Layer
  - belongs: tracker-owned guarded-landing policy result and GitHub bootstrap detection of the merged-at-landing race
  - does not belong: report inference heuristics or status rendering logic
- Observability Layer
  - belongs: artifact outcome typing, event details interpretation, and report summaries that accurately describe already-merged landing events
  - does not belong: direct GitHub API interpretation or merge gating policy

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/guarded-landing.ts`
  - emit a distinct lifecycle kind for `landingState === "merged"`
- `src/tracker/service.ts`
  - extend the shared landing result lifecycle union narrowly for the new merged semantic
- `src/tracker/github-bootstrap.ts`
  - pass through the corrected guarded-landing result without changing merge execution behavior for other cases
- `src/observability/issue-artifacts.ts`
  - add the new durable artifact outcome if artifacts need to persist it directly
- `src/observability/issue-report.ts`
  - recognize the new lifecycle kind from event details and keep historical inference coherent
- orchestrator artifact-writing paths that persist landing-blocked lifecycle kinds
- focused tests across unit, integration, and observability layers

### Does not belong in this issue

- refactoring the full `HandoffLifecycleKind` model or renaming unrelated lifecycle states
- changing `executeLanding()` control flow for non-merged failures
- mixing tracker transport, normalization, and policy into one module
- status-surface redesign unrelated to the new durable outcome
- non-GitHub tracker policy changes beyond narrow shared-type compatibility if required to keep the build green

## Layering Notes

- `config/workflow`
  - unchanged in this slice
- `tracker`
  - owns detecting and classifying the merged-at-landing race
  - does not let observability or orchestrator code infer merged semantics from raw GitHub fields
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - records the tracker-normalized lifecycle kind into artifacts
  - does not reinterpret "already merged" as another waiting state
- `observability`
  - renders and infers the persisted lifecycle kind correctly
  - does not reach back into tracker transport to recover semantics after the fact

## Slice Strategy And PR Seam

Keep this as one reviewable PR centered on the guarded-landing result shape and its observability consumers:

1. add one lifecycle/outcome value for the already-merged guarded-landing case
2. thread that value through the landing-blocked artifact path
3. update report inference and summaries to understand the new value
4. add regression coverage for the exact race and historical artifact interpretation

This seam is reviewable because it avoids:

- merge transport changes
- broad lifecycle-domain redesign
- retry/reconciliation state changes
- unrelated status-surface or tracker-adapter work

## Runtime State Model

This issue changes semantics for one existing landing race but still touches orchestrator handoff states and durable event interpretation, so the allowed states should stay explicit:

- `awaiting-landing-command`
  - PR is clean but no landing approval exists yet
- `awaiting-landing`
  - landing approval exists and the PR is still open while landing is pending or blocked for non-terminal reasons
- `merged`
  - the PR is already merged when guarded landing evaluates it; this is semantically post-terminal for reporting even if the current run still needs to refresh lifecycle before final success
- `awaiting-human-review`
  - unresolved human review threads block landing
- `awaiting-system-checks`
  - checks are pending or otherwise not terminal green
- `rework-required`
  - actionable bot feedback or failed terminal checks require another coding run
- `succeeded`
  - merge observation has been refreshed and the issue completes through the normal success path

### Allowed transitions relevant to this issue

- `awaiting-landing-command` -> `awaiting-landing`
  - explicit landing approval is observed
- `awaiting-landing` -> `merged`
  - guarded landing runs after an external merge already happened
- `awaiting-landing` -> `awaiting-human-review`
  - unresolved review threads block landing
- `awaiting-landing` -> `awaiting-system-checks`
  - checks are not terminal green
- `awaiting-landing` -> `rework-required`
  - bot feedback or failing terminal checks require follow-up
- `merged` -> `succeeded`
  - lifecycle refresh observes merged PR and the orchestrator completes the issue through the existing terminal path

### Coordination decision rules

- wait on `awaiting-landing-command`
- wait on `awaiting-landing`
- wait or rerun according to the existing `awaiting-human-review`, `awaiting-system-checks`, and `rework-required` behavior
- never persist `awaiting-landing` for a snapshot that is already known to be merged
- keep runtime convergence unchanged: the already-merged guarded-landing case remains non-successful in `executeLanding()`, then the normal refresh path observes terminal merge

## Failure-Class Matrix

| Observed condition                                                   | Local facts available                               | Normalized tracker facts available                                                 | Expected decision                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PR is still open and clean when guarded landing runs                 | landing command present                             | guarded landing returns `requested`                                                | execute merge request and continue existing flow                                             |
| PR merges externally before guarded landing runs                     | landing command present, no local merge request yet | guarded landing returns blocked with `merged` lifecycle/outcome                    | persist semantically correct artifact, then refresh lifecycle and complete on observed merge |
| PR is open but mergeability is unknown                               | landing command present                             | guarded landing returns blocked with `awaiting-landing`                            | persist waiting state and keep existing convergence behavior                                 |
| PR is open with pending or failing checks                            | landing command present                             | guarded landing returns blocked with `awaiting-system-checks` or `rework-required` | persist existing blocking state; no semantic change in this issue                            |
| PR is open with unresolved human review threads                      | landing command present                             | guarded landing returns blocked with `awaiting-human-review`                       | persist existing blocking state; no semantic change in this issue                            |
| Historical artifact lacks `lifecycleKind` on a landing-blocked event | only artifact JSON available                        | no explicit merged marker in details                                               | preserve existing fallback inference so older artifacts do not break                         |

## Storage / Persistence Contract

- no new durable store is introduced
- the issue artifact event schema version remains unchanged unless implementation proves a version bump is required for compatibility
- `landing-blocked` events continue to store `details.lifecycleKind`, but the value set for already-merged guarded-landing observations changes from `awaiting-landing` to the new merged semantic
- report inference must remain backward compatible with existing artifact history that still contains `awaiting-landing` for older runs

## Observability Requirements

- `landing-blocked` artifact details must distinguish "already merged" from "still awaiting landing"
- issue report inference must return the new outcome when the latest relevant event is an already-merged landing block
- report/timeline summaries must stay human-readable and semantically correct for that case
- any aggregate outcome/status typing that consumes artifact outcomes must accept the new merged semantic without collapsing it back to `awaiting-landing`

## Decision Notes

- Prefer a narrow new lifecycle/outcome value such as `merged` rather than overloading `handoff-ready`. This issue is about guarded-landing artifact semantics, not general PR lifecycle normalization, and the existing `landing-blocked` event kind should continue to describe the control-path fact that guarded landing did not execute a merge request because merge had already happened.
- Keep the orchestrator control path unchanged for this slice. The bug is durable observability truth, not runtime convergence.
- Keep backward compatibility explicit in report inference instead of trying to rewrite old artifact history.

## Implementation Steps

1. Add the new merged lifecycle/outcome value to the narrow shared unions used by guarded landing and issue artifacts.
2. Update `evaluateGuardedLanding()` so `landingState === "merged"` returns the new lifecycle kind.
3. Thread the new lifecycle kind through GitHub bootstrap and orchestrator landing-blocked artifact emission.
4. Update issue report lifecycle parsing and outcome inference so the new value is recognized and rendered coherently while older artifacts still infer correctly.
5. Update any summary or status helpers that require the expanded outcome union.
6. Add regression coverage for:
   - guarded-landing unit behavior
   - GitHub bootstrap merged-at-landing integration behavior
   - artifact/report inference for `landing-blocked` events with the new lifecycle kind
   - the exact race where inspection saw a clean PR but guarded landing later sees the PR as merged
7. Run local self-review and repo gates before opening the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- `evaluateGuardedLanding()` returns blocked `merged` semantics when `landingState === "merged"`
- issue report helpers parse the new lifecycle kind from artifact details
- issue report inference returns the new outcome for a latest `landing-blocked` event with merged semantics

### Integration

- GitHub bootstrap returns a blocked landing result with the new merged lifecycle kind when the PR merges before guarded landing executes
- orchestrator artifact emission persists the new lifecycle kind for that blocked landing event
- the next lifecycle refresh still converges to terminal merged success without additional policy changes

### End-to-end

- a realistic mocked landing race where the PR is clean at inspection time, then externally merged before guarded landing executes, produces:
  - a semantically correct `landing-blocked` artifact
  - continued runtime convergence to success after refresh

### Acceptance Scenarios

1. A human approves landing, but another actor merges the PR before Symphony sends its merge request. The landing-blocked artifact records `merged`, not `awaiting-landing`.
2. The issue report shows the run as merged/already landed rather than still waiting for landing.
3. Historical artifacts without the new lifecycle kind continue to infer outcomes without crashing or misparsing.
4. The runtime still completes the issue after refreshed lifecycle confirms the PR is merged.

## Exit Criteria

- already-merged guarded-landing artifacts no longer persist `awaiting-landing`
- report inference and summaries stay semantically correct for the new merged lifecycle/outcome
- regression coverage exists for the exact merged-before-landing race
- the change remains one narrow reviewable PR focused on guarded-landing policy plus observability consumers

## Deferred To Later Issues Or PRs

- any larger handoff lifecycle-domain cleanup or renaming
- changing event kinds or introducing a dedicated "already-merged" landing event
- broader status/TUI changes unless a narrow shared-type update is required
- merge control-path redesign, retry-state redesign, or non-GitHub landing policy work
