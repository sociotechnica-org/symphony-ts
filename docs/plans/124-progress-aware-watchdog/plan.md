# Issue 124 Plan: Progress-Aware Watchdog For Pre-Write Factory Runs

Status: plan-ready

## Goal

Prevent the watchdog from cancelling healthy factory runs before the first filesystem write when the runner is still making observable progress through commentary, reasoning, or other live execution events.

## Scope

- broaden pre-write liveness detection beyond workspace diffs and PR movement
- keep the existing detached local watchdog loop and recovery model
- use existing provider-neutral runner visibility where possible instead of introducing tracker-specific signals
- add targeted unit and orchestrator coverage for the reproduced `#81` failure mode

## Non-goals

- replacing the watchdog with a new supervision architecture
- redesigning the queue scheduler or retry policy
- changing tracker handoff policy outside watchdog-driven abort decisions
- adding new `WORKFLOW.md` settings unless the current config proves insufficient

## Current Gaps

- `src/orchestrator/stall-detector.ts` treats progress as changes in log size, workspace diff hash, or PR head SHA only
- `src/orchestrator/liveness-probe.ts` captures filesystem signals but ignores existing runner visibility timestamps already emitted by the runner/orchestrator path
- a run that reads, plans, or comments for several minutes before writing can look stalled if workspace and PR state stay unchanged and watchdog log growth is absent or too narrow
- the current tests cover generic stall detection, but not the concrete “runner still emitting live visibility while workspace is clean” regression

## Spec Alignment By Abstraction Level

### Policy Layer

- Defines the liveness policy as “pre-write progress includes runner-visible activity, not only filesystem side effects.”
- Does not add tracker-specific policy or alter plan-review / PR-review rules.

### Configuration Layer

- Reuses the existing `polling.watchdog` contract if possible.
- Does not introduce new workflow knobs unless implementation proves the current threshold/check interval contract cannot express the behavior.

### Coordination Layer

- Updates watchdog state evaluation to consider runner-visible progress while preserving the current recovery budget and abort flow.
- Keeps runtime ownership, retries, and watchdog recovery accounting in the orchestrator/runtime-state seam.
- Does not move tracker logic or runner transport details into the watchdog policy.

### Execution Layer

- Reads provider-neutral runner visibility facts already produced by the runner/orchestrator execution path.
- May extend the liveness snapshot shape to carry execution-progress timestamps or summaries.
- Does not change workspace creation/cleanup semantics or runner command launching semantics.

### Integration Layer

- Remains untouched unless a narrow adapter change is needed to normalize a provider-neutral visibility signal.
- Does not mix tracker transport, normalization, and watchdog policy.

### Observability Layer

- Keeps status/logging aligned with the new progress interpretation so operators can see why a run is considered live versus stalled.
- Does not become the source of watchdog policy truth; it reports normalized decisions.

## Architecture Boundaries

- `src/orchestrator/stall-detector.ts` owns pure stall evaluation and classification.
- `src/orchestrator/liveness-probe.ts` owns collection/assembly of normalized liveness facts.
- `src/orchestrator/service.ts` owns watchdog loop scheduling, recovery decisions, and active issue status wiring.
- `src/runner/*` remains the source of runner visibility events, not watchdog policy.
- `src/observability/*` renders the state but does not decide liveness.

What does not belong in this slice:

- tracker API changes
- workspace hook changes
- new scheduler fairness logic
- broad refactors of runner session management unrelated to watchdog progress detection

## Slice Strategy And PR Seam

This issue should fit in one PR because the seam is narrow:

- normalize one additional pre-write progress signal into the existing watchdog snapshot
- teach the pure detector how to treat that signal as activity
- cover the regression in unit/orchestrator tests

Deferred from this PR:

- richer semantic progress classification beyond “runner-visible activity”
- any redesign of watchdog thresholds into multiple budgets
- provider-specific parsing of commentary/reasoning payload content

## Runtime State Machine

This issue changes orchestration behavior, so the watchdog decision model must stay explicit.

States for one active issue:

1. `watching-unobserved`
   - No concrete liveness signal has been seen yet.
   - Transition to `watching-live` when any observable progress signal appears.
2. `watching-live`
   - At least one progress signal has been observed and the latest sample changed within threshold.
   - Remains here while log size, workspace diff, PR head, or runner-progress timestamp advances.
   - Transitions to `watching-idle-with-signal` when samples stop changing.
3. `watching-idle-with-signal`
   - Observable signals exist, but no signal changed in the latest sample.
   - Returns to `watching-live` on any later change.
   - Transitions to `stalled` once idle duration reaches `stallThresholdMs`.
4. `stalled`
   - Detector classifies the reason and hands control back to orchestrator recovery policy.
   - Transitions to `recovering` when recovery budget remains.
   - Transitions to `terminal-abort` when recovery budget is exhausted.
5. `recovering`
   - Orchestrator records recovery count and aborts the runner so normal retry handling can take over.
6. `terminal-abort`
   - Orchestrator aborts the runner and lets normal failure handling exhaust the issue attempt.

Allowed signal set for `watching-live` in this slice:

- watchdog log growth
- workspace diff hash movement
- PR head movement
- runner visibility heartbeat/action progress while a turn is still active

## Failure-Class Matrix

| Observed condition                                                                             | Local facts available                                        | Normalized tracker facts available   | Expected decision                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Clean workspace, no PR, runner visibility heartbeat/action timestamp advances                  | Active issue has running/session-start visibility updates    | none required                        | Treat as live pre-write progress; do not abort                                           |
| Clean workspace, no PR, no visibility/log/diff movement within threshold                       | Active issue still owned locally                             | none required                        | Classify as `log-stall` or pre-write stall fallback; recover/abort using existing budget |
| Dirty workspace diff unchanged, no visibility movement within threshold                        | Active issue still running                                   | none required                        | Classify as `workspace-stall`; recover/abort using existing budget                       |
| Actionable review feedback present, PR head unchanged, no visibility movement within threshold | Active issue has review metadata and PR head                 | actionable review count, PR head SHA | Classify as `pr-stall`; recover/abort using existing budget                              |
| Visibility stops because runner already exited/failed before watchdog tick                     | Run controller/runner result path updates active issue state | none required                        | Watchdog stops with run completion/error path; no extra recovery                         |

## Observability Requirements

- preserve the existing last-action watchdog entries (`watchdog-recovery`, `watchdog-recovery-exhausted`)
- ensure status snapshots continue to expose runner heartbeat/action timestamps that explain why a pre-write run stayed live
- add or update focused logging only if needed to make watchdog decisions inspectable during regressions

## Implementation Steps

1. Extend the watchdog liveness snapshot to include normalized runner progress timestamps sourced from active issue runner visibility.
2. Update the filesystem liveness probe interface and capture path so the probe can combine filesystem facts with runner visibility facts without depending on provider-specific payloads.
3. Adjust `checkStall` and stall classification logic so advancing runner progress counts as change, especially before the first workspace write.
4. Keep stall-reason precedence explicit so PR and workspace stalls still win when their conditions apply after progress stops.
5. Add pure unit coverage for first-observed runner progress, repeated heartbeat/action advancement, and post-progress idle timeout.
6. Add orchestrator coverage for a `#81`-style run that emits visibility progress while the workspace stays clean, proving the watchdog does not abort early.
7. Update the plan status and issue thread if implementation uncovers a broader scope change.

## Tests

Unit:

- `tests/unit/stall-detector.test.ts`
  - first runner-progress signal counts as progress
  - advancing runner heartbeat/action timestamps resets idle time
  - runner-progress-only runs still stall after threshold once timestamps stop changing
- `tests/unit/liveness-probe.test.ts`
  - probe snapshots carry runner visibility progress fields through unchanged

Orchestrator:

- `tests/unit/orchestrator.test.ts`
  - watchdog does not abort a run whose workspace diff stays clean while runner visibility keeps advancing
  - existing stalled-run recovery behavior still aborts when all signals stop

Acceptance scenarios:

1. A planning-heavy first turn with no file writes for more than one check interval stays live while runner visibility keeps updating.
2. A genuinely hung pre-write run with no diff, no PR movement, and no runner visibility updates still triggers watchdog recovery.
3. Existing post-write and PR-feedback stall detection continues to classify unchanged diff/PR states correctly.

## Exit Criteria

- plan is reviewed and explicitly marked `approved` or `waived`
- watchdog no longer treats healthy pre-write progress as stalled solely because the workspace is clean
- reproduced regression is covered by tests
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- separate thresholds for pre-write versus post-write stall classes
- richer progress semantics from runner output content
- status UI changes beyond the minimal visibility needed to explain watchdog decisions

## Decision Notes

- Prefer existing provider-neutral runner visibility timestamps over parsing provider-specific commentary logs. This keeps the fix inside the orchestrator/runner contract instead of baking Codex-specific session semantics into watchdog policy.
- Keep the watchdog as a single detector with broader progress inputs. Splitting it into separate pre-write and post-write watchdog subsystems would enlarge the review surface without being required for the reproduced failure.
