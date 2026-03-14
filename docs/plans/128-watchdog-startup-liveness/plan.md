# Issue 128 Plan: Watchdog Startup Liveness Revalidation And Narrow Fix

Status: plan-ready

## Goal

Revalidate the March 13 `#81` false-positive shutdown shape on current `main` and, if it still reproduces, close the remaining watchdog gap with one explicit control-plane concept of `last observable activity` that keeps live startup and low-output runs from being aborted as `Runner cancelled by shutdown`.

## Scope

- reproduce or disprove the archived `#81` overnight failure shape against current `main`
- keep the PR seam limited to watchdog stall classification, runner startup activity plumbing, and the minimum observability needed to explain the decision
- cover the reproduced startup / pre-turn / low-output path in unit, orchestrator, and bootstrap-factory regression tests
- preserve existing genuine stalled-run recovery behavior

## Non-goals

- redesigning the detached factory control surface
- changing retry budgeting outside watchdog stall handling
- changing tracker transport, tracker normalization, or tracker lifecycle policy
- broad status-surface redesign beyond exposing the normalized last-activity facts needed for diagnosis
- remote execution or multi-host supervision work

## Current Gaps

- the archived `#81` artifacts show repeated six-minute aborts with `Runner cancelled by shutdown`, no recorded `latestTurnNumber`, no `backendSessionId`, and no session log pointers, which indicates the run died in a startup or pre-turn phase before the usual turn-level observability became durable
- current watchdog policy still compares multiple raw probe fields (`logSizeBytes`, workspace diff hash, PR head SHA, runner heartbeat, runner action) instead of using one named authoritative last-activity concept the way the spec and Elixir reference do
- current `main` already includes more startup visibility than the March 13 runtime, but the issue comment requires fresh validation before assuming the failure is gone
- if the runtime still reproduces, the remaining bug is likely a missing or misclassified startup activity source rather than another tracker or retry-policy problem

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs here: define the intended liveness rule as "a run is live when any normalized observable activity source advances, including startup-phase runner activity"
- does not belong here: provider-specific parsing, tracker quirks, or ad hoc timeout exceptions

### Configuration Layer

- belongs here: reuse the existing watchdog timing contract
- does not belong here: new issue-specific stall knobs unless fresh validation proves the current threshold model cannot express the fix
- expected change: none unless validation proves a real config gap

### Coordination Layer

- belongs here: watchdog state, last-activity derivation, stall classification, and the distinction between recoverable stall versus terminal stall
- does not belong here: runner protocol parsing details or tracker lifecycle writes
- this is the primary implementation layer for the issue

### Execution Layer

- belongs here: emitting provider-neutral startup activity facts from the local runner path before a turn has produced durable output or writes
- does not belong here: retry transitions or watchdog policy branching
- this layer is touched only to expose the missing startup signal cleanly

### Integration Layer

- untouched by this slice
- tracker transport, normalization, and lifecycle policy stay unchanged
- nothing in this issue should mix tracker facts with watchdog control logic beyond the already-normalized PR head / actionable-review snapshot

### Observability Layer

- belongs here: status and artifact fields that explain the latest observable activity source and why a run stayed live or was classified stalled
- does not belong here: becoming the source of truth for stall policy
- only the minimum needed operator-facing explanation should land in this PR

## Architecture Boundaries

- `src/orchestrator/stall-detector.ts` should own pure last-activity derivation and stall classification
- `src/orchestrator/watchdog-state.ts` should continue to own watchdog runtime bookkeeping, not tracker or runner semantics
- `src/orchestrator/service.ts` should own watchdog scheduling, recovery decisions, and the handoff from runner/status events into the normalized liveness snapshot
- `src/runner/*` should emit provider-neutral startup activity facts but should not decide when a run is stalled
- `src/observability/*` should render the normalized facts but should not infer stall policy

What does not belong in this slice:

- tracker API changes
- detached-factory control refactors
- queue fairness or retry scheduler redesign
- provider-specific watchdog parsing of Codex payload content beyond normalized visibility/spawn facts

## Slice Strategy And PR Seam

This should stay one reviewable PR because the seam is narrow:

- first, revalidate whether the archived `#81` shape still reproduces on current `main`
- if it does, normalize startup-phase activity into one authoritative last-activity timestamp/source and keep the rest of the watchdog machinery intact
- if it does not, limit the output of this issue to the validation evidence and close or narrow the issue instead of forcing speculative runtime edits

What lands in the PR if reproduction still exists:

- a named last-activity concept in watchdog coordination code
- the minimum runner/startup plumbing needed so startup activity feeds that concept
- regression coverage for the `#81` shape and a negative genuine-stall case
- minimal status/artifact clarification for operators

What is deferred:

- separate thresholds per stall class
- richer semantic parsing of runner output
- broad status UI redesign
- durable stall telemetry beyond the current per-issue artifacts

## Runtime State Machine

This issue changes long-running orchestration behavior, so the runtime states must stay explicit.

1. `starting-without-observed-activity`
   - the run has been claimed and the runner may be spawning, but no normalized activity has been observed yet
   - stall timing uses `startedAt` as the fallback baseline, matching the spec
2. `running-with-activity`
   - at least one normalized activity source has advanced
   - the authoritative `lastObservableActivityAt` is updated from the newest allowed source
3. `idle-with-known-activity`
   - the run has observable history, but no source has advanced on the latest sample
   - the watchdog compares `capturedAt - lastObservableActivityAt`
4. `stalled-recoverable`
   - elapsed time exceeds the watchdog threshold and recovery budget remains
5. `stalled-terminal`
   - elapsed time exceeds the watchdog threshold and recovery budget is exhausted
6. `aborting`
   - the orchestrator aborts the runner because of a confirmed stall
7. `runner-finished`
   - the run exits through normal success/failure/cancellation handling and watchdog state is cleaned up

Allowed last-activity sources in this slice:

- run start time when nothing else has been observed yet
- runner spawned/startup visibility
- runner heartbeat/action timestamps
- watchdog session log growth
- workspace diff movement
- PR head movement

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Runner is still in startup, no turn number or backend session id yet, but spawned/startup activity continues advancing | run start time, spawned timestamp, startup visibility or equivalent progress fact | none required | treat as live; do not abort |
| Runner is still in startup, no filesystem writes, no PR movement, and no startup or visibility activity has advanced past threshold | run start time only, no later activity | none required | classify as genuine startup stall and recover/abort through the normal watchdog path |
| Runner heartbeat/action advances while workspace stays clean | updated runner visibility timestamps | none required | treat as live pre-write progress |
| Workspace diff or PR head moved recently even if runner visibility is quiet | diff hash or PR head changed | PR head and actionable review state when present | treat as live |
| No source has advanced past threshold after prior activity and recovery budget remains | last observable activity timestamp/source, active watchdog entry | normalized current issue snapshot | classify stalled and abort for retry |
| No source has advanced past threshold after prior activity and recovery budget is exhausted | same as above | normalized current issue snapshot | classify stalled-terminal, abort, and preserve the true watchdog reason |
| Runner exits on its own before watchdog threshold | runner result path settled | tracker lifecycle continues normally | watchdog stops; no stall recovery |

## Storage And Persistence Contract

- watchdog runtime state remains process-local under `src/orchestrator/state.ts` / `src/orchestrator/watchdog-state.ts`
- no new durable tracker writes are introduced by this issue
- per-issue artifacts and status snapshots remain the inspectable record of watchdog decisions
- if a new last-activity field is surfaced in status or artifacts, it should be derived from normalized runtime state rather than stored as a second independent source of truth

## Observability Requirements

- preserve the distinction between `watchdog-recovery`, `watchdog-recovery-exhausted`, and non-watchdog runner failures
- make the latest observable activity source/time inspectable enough that operators can tell whether a run was in startup progress, active turn progress, or a genuine stall
- keep the failure summary truthful when recovery is exhausted so `Runner cancelled by shutdown` is not the only visible explanation for a watchdog-driven abort

## Implementation Steps

1. Revalidate the archived `#81` shape on current `main` using the stored artifacts plus a focused regression harness for startup / pre-turn liveness.
2. If current `main` no longer reproduces the failure, document that evidence on the issue and narrow or close the ticket instead of landing speculative code.
3. If the failure still reproduces, extract or name the watchdog's authoritative `lastObservableActivityAt` / source concept in coordination code so stall timing follows one explicit baseline.
4. Feed startup-phase runner activity into that concept using provider-neutral spawned / startup visibility facts rather than provider-specific output parsing.
5. Keep the recovery path unchanged except for using the new authoritative last-activity classification and preserving the true stall reason in status/artifacts.
6. Add regression coverage for the `#81` startup shape, a low-output visibility-only live case, and a genuine startup stall negative case.
7. Update the issue thread if validation changes the scope materially.

## Tests And Acceptance Scenarios

Unit coverage:

- `tests/unit/stall-detector.test.ts`
  - stall timing uses run start as the fallback baseline before first observed activity
  - startup/spawned activity advances the authoritative last-activity timestamp
  - a run stalls only after the authoritative timestamp stops moving past threshold

Orchestrator / integration coverage:

- `tests/unit/orchestrator.test.ts`
  - a startup-heavy run with no writes and delayed first turn is not aborted while startup activity keeps advancing
  - a genuinely hung startup run with no advancing activity still triggers watchdog recovery
  - exhausted recovery preserves the watchdog-specific terminal reason instead of collapsing to a generic shutdown summary

Bootstrap-factory / end-to-end coverage:

- add or extend a factory regression harness that reproduces the archived `#81` shape: alive runner, low/no writes, delayed durable turn metadata
- add the negative case where startup activity stops and the watchdog must still abort

Acceptance scenarios:

1. Given a live runner that is still starting and has not yet recorded a turn number, when startup activity continues, then the watchdog keeps the run alive.
2. Given a low-output run with runner visibility but no workspace writes, when visibility timestamps advance, then the run is not aborted as `Runner cancelled by shutdown`.
3. Given a truly hung startup run, when no observable activity advances past threshold, then the watchdog aborts and retry behavior remains intact.
4. Given a terminal watchdog abort, when operators inspect status/artifacts, then they can distinguish watchdog stall exhaustion from an unrelated shutdown.

## Exit Criteria

- current `main` has been revalidated against the archived `#81` shape
- if a runtime bug still exists, it is fixed without broad watchdog redesign
- the `#81`-style regression is covered in tests
- genuine stalled-runner recovery still works
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Deferred To Later Issues Or PRs

- multi-threshold stall policies for different phases
- richer provider-neutral semantic progress events beyond timestamps/source labels
- broader factory-control or status-TUI redesign around liveness
- durable cross-restart stall forensics beyond the current local artifact set

## Decision Notes

- The spec and Elixir reference both point toward one authoritative last-activity concept. This issue should move toward that shape instead of adding more special cases to field-by-field watchdog comparisons.
- Revalidation on current `main` is part of the plan, not an optional preamble, because the issue already has a human comment warning that recent runtime changes may have resolved the original failure.
