# Issue 251 Plan: Claude Code Watchdog Stalls In Third-Party Factory Runs

## Status

- plan-ready

## Goal

Identify why healthy third-party `claude-code` runs can trip the watchdog as `workspace-stall`, then land the smallest spec-aligned runtime change that reduces avoidable watchdog retries without hiding genuine hangs.

## Scope

- reproduce the observed third-party Claude stall shape with a focused automated harness
- document the root-cause seam between local runner supervision and watchdog liveness inputs
- add a provider-neutral execution-to-watchdog activity contract for long-running local-process turns
- keep the watchdog decision logic narrow and explicit for Claude-like long turns that may write early and then remain otherwise quiet
- add unit, orchestrator, and end-to-end coverage for the reproduced failure mode
- update third-party workflow docs only where the new behavior or remaining operator expectations need to be explicit

## Non-goals

- redesigning the overall watchdog or supervision architecture
- changing tracker transport, tracker normalization, or tracker lifecycle policy
- adding Claude-specific tracker rules or issue-label heuristics
- introducing remote execution, durable leases, or cross-restart watchdog persistence
- broad status-surface redesign beyond the minimum observability needed to explain the new liveness source
- speculative threshold tuning without reproduction evidence

## Current Gaps

- issue `#251` reports a real third-party Claude run that stalled as `workspace-stall` after about five minutes, then succeeded on a retry, which means the current watchdog can treat some eventually-successful Claude turns as stalled
- `src/orchestrator/stall-detector.ts` already understands runner heartbeat/action timestamps, workspace diff movement, PR head movement, and optional watchdog log growth, so the remaining gap is not “the watchdog has no notion of runner activity”
- the local `claude-code` path currently launches through `src/runner/local-execution.ts`, which records a spawn event and final completion result but does not publish a durable watchdog session log and does not emit intermediate runner visibility updates for ordinary local-process stdout/stderr traffic
- `src/orchestrator/liveness-probe.ts` documents an optional `.symphony/<run-session-id>.log` contract, but no local-process runner currently writes that log, so one of the watchdog’s intended progress signals is effectively absent on the Claude path
- for long Claude turns that write files or update the workspace early and then spend several minutes reasoning without further normalized activity, the watchdog can only see a stale workspace diff hash and may classify the run as `workspace-stall` even if the process is still doing useful work
- today the runtime has weak evidence when a local runner is alive-but-quiet:
  - no persisted per-run stream-activity log for the watchdog
  - no provider-neutral “stdio activity observed” visibility event from local execution
  - no regression fixture that proves a long Claude-style turn stays live without depending on Codex-specific update events

## Decision Notes

- Treat this as a runner/execution liveness contract issue first, not a tracker or retry-policy issue. The observed false positive happens before tracker policy should matter.
- Prefer a provider-neutral local-process activity signal over a Claude-only special case. The same gap can affect other local subprocess runners that do not emit structured mid-turn updates.
- Do not paper over the gap solely by raising watchdog thresholds globally. Threshold changes may still be justified later, but only after the runtime exposes better evidence about live local-process activity.
- Keep the fix reviewable by limiting it to:
  - local runner execution activity publication
  - watchdog consumption/classification of that activity
  - focused docs/tests
- If reproduction proves that healthy Claude runs can remain entirely silent for longer than the watchdog threshold even after the new activity contract is added, capture any threshold or phase-budget follow-up explicitly instead of broadening this PR silently.

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs here:
  - the repo-owned decision that avoidable watchdog retries on healthy third-party Claude runs are a bug
  - the policy that local-process liveness should be inferred from normalized activity signals, not tracker-specific heuristics
- does not belong here:
  - subprocess stream plumbing
  - file append mechanics
  - tracker API behavior

### Configuration Layer

- belongs here:
  - reusing the existing `polling.watchdog` contract
  - documenting any operator-visible expectations if the new activity contract changes how third-party Claude runs are observed
- does not belong here:
  - ad hoc Claude-only threshold branching hidden in config parsing
  - local subprocess I/O handling
- expected change:
  - none unless the investigation proves a narrow documented threshold adjustment is still required after the runtime fix

### Coordination Layer

- belongs here:
  - watchdog snapshot shape and stall evaluation
  - the decision about which normalized local-process activity sources reset the stall timer
  - preserving explicit stalled-vs-live reasoning in watchdog state and summaries
- does not belong here:
  - direct subprocess stream handling
  - provider-specific Claude parsing

### Execution Layer

- belongs here:
  - local-process runner activity publication during an active turn
  - writing any watchdog-readable per-run activity log under the documented `.symphony/` contract
  - emitting provider-neutral visibility updates when local execution observes meaningful stdio activity
- does not belong here:
  - retry budgets
  - tracker mutations
  - watchdog recovery policy

### Integration Layer

- untouched in this slice
- tracker transport, normalization, and lifecycle policy remain unchanged
- nothing in this issue should mix GitHub-specific handoff facts into watchdog liveness policy

### Observability Layer

- belongs here:
  - preserving enough runner visibility and session/log-pointer facts for operators to see why a long Claude turn stayed live or stalled
  - making the new local-process activity source inspectable in status/artifacts if needed
- does not belong here:
  - becoming the source of truth for stall decisions
  - parsing raw Claude output semantically in reporting/status code

## Architecture Boundaries

### Belongs in this issue

- `src/runner/local-execution.ts`
  - publish provider-neutral local-process activity during active turns
  - write the documented per-run watchdog activity log if that is the chosen execution-level signal
- `src/orchestrator/liveness-probe.ts`
  - keep the watchdog log contract explicit and aligned with the execution-layer writer
- `src/orchestrator/stall-detector.ts`
  - consume the normalized activity source explicitly and keep stall classification precedence clear
- `src/orchestrator/service.ts`
  - wire local runner activity into current issue visibility without introducing provider branching
- runner session description helpers if needed
  - expose any new log pointer or activity surface through the existing provider-neutral session shape
- tests
  - unit coverage for detector/probe changes
  - orchestrator coverage for the reproduced long-Claude-turn failure mode
  - one e2e-style third-party Claude regression fixture
- docs
  - README or workflow docs only if the new behavior or any remaining operator caveat needs to be documented

### Does not belong in this issue

- tracker API changes
- PR review-loop changes
- queue scheduling changes
- workspace lifecycle redesign
- remote task/session transports
- broad TUI redesign
- a new multi-phase watchdog budget model unless the narrow activity fix proves insufficient

## Layering Notes

- config/workflow
  - may document the behavior
  - must not own Claude-specific liveness policy branches
- tracker
  - remains isolated from watchdog liveness
  - must not compensate for local runner silence
- workspace
  - may host the `.symphony/` activity file location
  - must not decide whether activity means “healthy”
- runner
  - owns local-process activity publication and any per-run activity-log append behavior
  - must not decide recovery vs retry vs terminal failure
- orchestrator
  - owns stall detection and watchdog recovery decisions
  - must not parse Claude-specific output semantics to infer progress
- observability
  - renders the normalized facts
  - must not become a second watchdog policy engine

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by keeping the seam limited to the local runner/watchdog contract:

1. reproduce the third-party Claude stall shape in a controlled test
2. add the missing provider-neutral local-process activity signal
3. teach the watchdog to consume that signal explicitly
4. prove the reproduced long-turn case stays live while genuine silence still stalls
5. document the behavior only where operators need to know it

Why this remains reviewable:

- it does not combine tracker-policy changes with runner execution changes
- it does not redesign retry budgeting or lease recovery
- it does not require a broad observability/TUI rewrite
- it keeps the runtime change centered on one missing execution-to-coordination contract

Deferred from this PR:

- distinct watchdog thresholds for startup, active-turn, and post-write phases
- Claude-specific semantic parsing of commentary/reasoning output
- durable cross-restart watchdog forensics
- broader supervision refactors for local or remote execution

## Runtime State Machine

This issue changes long-running orchestration behavior for active runs, so the state model must stay explicit.

States for one active issue:

1. `watching-startup`
   - the run exists and the local runner may be spawning, but only start/spawn activity has been observed
2. `watching-live-process-activity`
   - the run has observed normalized local-process activity after startup
   - activity may come from runner visibility timestamps or documented watchdog activity-log growth
3. `watching-idle-with-known-activity`
   - at least one observable signal exists, but no signal has advanced on the latest sample
4. `stalled-recoverable`
   - elapsed time since the authoritative last observable activity exceeds the threshold and watchdog recovery budget remains
5. `stalled-terminal`
   - elapsed time since the authoritative last observable activity exceeds the threshold and recovery budget is exhausted
6. `aborting`
   - the orchestrator aborts the run because of a confirmed watchdog decision
7. `runner-finished`
   - the run exits through normal success/failure/cancellation handling and watchdog state is cleaned up

Allowed transitions:

- `watching-startup -> watching-live-process-activity`
- `watching-startup -> watching-idle-with-known-activity`
- `watching-live-process-activity -> watching-idle-with-known-activity`
- `watching-idle-with-known-activity -> watching-live-process-activity`
- `watching-idle-with-known-activity -> stalled-recoverable`
- `watching-idle-with-known-activity -> stalled-terminal`
- `stalled-recoverable -> aborting -> runner-finished`
- `stalled-terminal -> aborting -> runner-finished`
- `watching-startup -> runner-finished`
- `watching-live-process-activity -> runner-finished`

Authoritative activity sources in this slice:

- run start
- runner spawned/startup visibility
- runner heartbeat/action timestamps
- documented watchdog activity-log growth from local execution
- workspace diff movement
- PR head movement

What is intentionally not an activity source:

- “process still exists” by itself
- tracker comments or label churn
- provider-specific semantic guesses from raw Claude text

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Claude local-process turn is still producing normalized activity while workspace diff and PR head remain unchanged | spawn metadata, runner visibility timestamps and/or watchdog activity-log growth | none required | treat as live; do not watchdog-abort |
| Claude turn wrote early workspace changes, then remained silent with no further activity-log growth or visibility updates past threshold | stale diff hash, no new local-process activity, active watchdog entry | none required | classify stalled using existing watchdog path; recover or abort based on budget |
| Local-process runner emits stdout/stderr traffic but no structured `RunUpdateEvent` payloads | raw stream activity, no provider-specific parsed update | none required | still credit provider-neutral local-process activity; do not require Codex-style structured events |
| Local-process runner is alive but completely silent after spawn and before any write/activity past threshold | spawn time only, no diff/log/visibility changes | none required | treat as a genuine startup or execution stall; recover/abort through existing watchdog policy |
| Workspace diff and PR head are unchanged, but the run is already finished | runner result settled, watchdog stop signal fired | tracker reconciliation may still be pending | stop watchdog cleanly; no extra recovery |
| Recovery budget is exhausted after repeated confirmed stalls | last observable activity facts plus issue-scoped recovery count | normalized issue snapshot | persist terminal watchdog reason, abort the runner, and do not fabricate more recovery credit |

## Storage / Persistence Contract

- watchdog runtime state remains process-local under the existing watchdog state modules
- no new tracker-side durable state is introduced
- if the execution layer writes a watchdog-readable activity log, it must live under the existing workspace-local `.symphony/` contract and remain per-run-session when a session id is available
- any new runner session log pointer should flow through the existing provider-neutral `RunnerSessionDescription.logPointers` shape instead of a Claude-only artifact schema

## Observability Requirements

- operators must be able to see that a long local-process Claude turn stayed live because of normalized process activity, not because the watchdog silently stopped checking
- if a per-run watchdog activity log is introduced, its location should be discoverable through existing session/log-pointer surfaces where practical
- preserve explicit watchdog summaries (`watchdog-recovery`, `watchdog-recovery-exhausted`) and the last observable activity source/time
- keep status/reporting code provider-neutral; it should report normalized local-process activity facts rather than parse Claude output semantics

## Implementation Steps

1. Add a focused regression fixture that reproduces the issue `#251` shape: a `claude-code` third-party run that makes an early workspace change, continues as a healthy long-running local subprocess, and would currently trip `workspace-stall`.
2. Confirm the reproduced gap from local evidence in tests and code comments:
   - no structured mid-turn updates on the local Claude path
   - no populated watchdog activity log today
3. Extend `src/runner/local-execution.ts` to publish a provider-neutral local-process activity signal during active turns.
4. If the chosen signal is file-backed, write the documented per-run `.symphony/<run-session-id>.log` activity file from local execution and keep the filename contract shared with the probe.
5. Update the watchdog liveness snapshot / detector to consume the new signal explicitly while preserving existing reason precedence:
   - PR stall still wins when actionable review + PR head apply
   - workspace stall still wins when workspace changed and later went idle
   - log/process-activity stall remains the fallback when no stronger surface applies
6. Add unit coverage for:
   - watchdog activity-log contract or equivalent local-process activity source
   - detector handling when activity continues without workspace/PR movement
   - genuine silence still stalling after threshold
7. Add orchestrator and e2e coverage proving:
   - the reproduced healthy long Claude turn no longer triggers avoidable recovery
   - a truly silent long-running local process still does trigger watchdog handling
8. Update docs only where the new liveness contract or any residual third-party Claude caveat must be operator-visible.
9. Run self-review plus repository checks before opening/updating the PR.

## Tests And Acceptance Scenarios

### Unit coverage

- `tests/unit/liveness-probe.test.ts`
  - the local-process watchdog activity file path stays aligned with the documented filename contract
- `tests/unit/stall-detector.test.ts`
  - continuing local-process activity resets the watchdog idle baseline even when workspace diff and PR head stay unchanged
  - a run still stalls after the new activity source stops advancing
- focused runner/local-execution tests
  - local execution emits the normalized activity signal without requiring structured `RunUpdateEvent` payloads

### Orchestrator coverage

- `tests/unit/orchestrator.test.ts`
  - a long Claude-style local-process turn that writes early and then keeps producing normalized activity does not trip `workspace-stall`
  - a long local-process turn that goes fully silent after early workspace writes still trips the watchdog and preserves the right reason

### End-to-end coverage

- `tests/e2e/bootstrap-factory.test.ts`
  - third-party GitHub workflow with `runnerKind: "claude-code"` reproduces the issue-251-style shape and stays healthy after the fix

### Acceptance scenarios

1. Given a third-party Claude run that makes an early workspace change and then keeps producing normalized local-process activity, when the watchdog samples for longer than five minutes, then the run stays live and does not retry.
2. Given a local-process Claude run that goes completely silent after spawn or early writes, when the watchdog threshold elapses, then the run still aborts through the existing watchdog path.
3. Given a local-process runner that emits raw stdout/stderr activity but no structured update events, when the watchdog samples liveness, then it still credits that provider-neutral activity.
4. Given an exhausted recovery budget, when a confirmed silent stall recurs, then Symphony persists the terminal watchdog reason and aborts without hiding it behind a generic shutdown summary.

## Exit Criteria

- the issue-251 stall shape is reproduced or disproved with focused automated coverage
- the root cause is documented in code/tests/plan notes
- the chosen runtime fix reduces avoidable watchdog retries for healthy third-party Claude runs
- genuine silent hangs still trigger watchdog handling
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- relevant e2e coverage for the reproduced third-party Claude path passes
- a local self-review pass is run and any findings are fixed before PR publication

## Deferred To Later Issues Or PRs

- separate watchdog thresholds for different run phases
- CPU-time or OS-level process-activity probes
- provider-specific semantic progress detection for Claude commentary/reasoning
- durable archival/report enrichment for local-process activity logs beyond the minimum runner-session pointer
- broader supervision redesign for remote or multi-host execution
