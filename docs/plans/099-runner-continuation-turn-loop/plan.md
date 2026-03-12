# Issue 99 Plan: Spec-Aligned Continuation Turn Loop

## Status

- plan-ready

## Goal

Reduce cold-start review churn by reusing the same live Codex conversation across multiple continuation turns inside a single worker run, while keeping tracker state checks and continuation policy in the orchestration layer.

## Scope

- add `agent.max_turns` to workflow config and defaults
- add a continuation-prompt contract distinct from the full initial workflow prompt
- extend the runner contract to support a live multi-turn Codex session for one worker run
- implement orchestration logic that re-checks normalized tracker handoff state between turns and decides whether to continue, wait, fail, or complete
- capture the backend conversation/session identity for observability and issue artifacts
- cover continuation turns, budget exhaustion, tracker-driven stop conditions, and session reuse with unit and end-to-end tests

## Non-goals

- a provider-neutral runner abstraction redesign from `#89`
- introducing Claude Code or other backends from `#91`
- adopting the experimental `codex app-server` protocol in this PR
- redesigning tracker review/follow-up detection semantics
- changing workspace reuse, lease recovery, or watchdog policy beyond the narrow updates required to support a multi-turn runner session

## Current Gaps

- `src/runner/local.ts` executes one `codex exec` subprocess and discards all conversation context when it exits
- `src/orchestrator/service.ts` builds one full prompt per run attempt and treats review feedback as a later outer rerun rather than an immediate continuation turn
- `src/config/workflow.ts` exposes retry budgets but no per-run continuation-turn budget
- issue/session observability records the Symphony run session id, but not the backend Codex conversation identity reused across follow-up turns
- current e2e coverage proves workspace reuse across reruns, but not same-thread continuation across turns within one worker run

## Decision Notes

- This slice will use `codex exec` for turn 1 and `codex exec resume <session-id>` for turn 2+.
- The installed Codex CLI in this environment supports `codex exec resume` today, while `codex app-server` is still an experimental protocol surface and would broaden the PR into transport and backend-interface work that overlaps `#89`.
- The PR still stays spec-aligned on the user-visible behavior that matters in this issue:
  - one worker run can execute multiple back-to-back turns
  - continuation turns reuse the same Codex conversation
  - continuation prompts are lightweight and do not resend the full task prompt
- A later runner-backend slice can swap the execution transport from `exec/resume` to app-server without changing the coordination policy introduced here.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining continuation-turn behavior, continuation prompt rules, and the stopping conditions for `max_turns`
  - does not belong: Codex CLI flag parsing or subprocess details
- Configuration Layer
  - belongs: `agent.max_turns`, typed prompt-building inputs for initial vs continuation turns, and validation/defaulting
  - does not belong: tracker polling decisions or session-resume subprocess logic
- Coordination Layer
  - belongs: explicit turn-loop state, tracker re-checks between turns, and decisions to continue, wait, fail, or complete
  - does not belong: raw Codex CLI output parsing or tracker transport quirks
- Execution Layer
  - belongs: live runner session lifecycle, initial turn execution, continuation turn execution, and backend session-id capture
  - does not belong: deciding whether tracker state is actionable follow-up vs awaiting review
- Integration Layer
  - belongs: unchanged tracker normalization and reconcile calls already used to derive handoff lifecycle after each turn
  - does not belong: conversation-thread lifecycle or continuation prompt text
- Observability Layer
  - belongs: recording the reused backend session/thread id and turn-level session metadata in status/artifacts/log pointers
  - does not belong: deriving continuation policy from raw runner output

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - add `agent.maxTurns` to the typed config
- `src/config/workflow.ts`
  - parse/validate `agent.max_turns`
  - expose prompt-building support for initial and continuation turns
- `src/domain/run.ts`
  - add explicit turn/session types needed to distinguish worker-run attempt, turn number, and backend conversation id
- `src/runner/service.ts`
  - introduce a live-session contract such as `startSession()` plus `runTurn()`/`close()`, or an equivalent narrow API that supports multiple turns on one conversation
- `src/runner/local.ts`
  - implement Codex `exec` + `exec resume` session reuse and session-id capture
- `src/orchestrator/service.ts`
  - replace the single successful-run path with an inner continuation-turn loop that consults normalized tracker lifecycle after each turn
- `src/orchestrator/` runtime state helper(s)
  - extract any turn-loop state helper needed so turn count, run sequence, retry budget, and follow-up budget remain distinct
- `src/observability/issue-artifacts.ts` and status helpers
  - persist the reused backend conversation id and turn/session timing cleanly
- focused unit/e2e test fixtures for multi-turn Codex-style behavior

### Does not belong in this issue

- provider-agnostic runner factory redesign from `#89`
- app-server transport adoption or generated protocol bindings
- tracker transport or normalization rewrites
- collapsing retry budget, follow-up budget, and continuation-turn budget into one shared counter
- broad issue-report schema redesign beyond the narrow additions needed to expose the reused backend session id

## Layering Notes

- `config/workflow`
  - owns `agent.max_turns` and prompt rendering contracts
  - does not own turn-loop control flow
- `tracker`
  - continues to own tracker-specific normalization into `HandoffLifecycle`
  - does not gain knowledge of Codex sessions or continuation prompts
- `workspace`
  - remains responsible for one prepared workspace reused across the worker run
  - does not decide whether another turn is needed
- `runner`
  - owns live Codex conversation reuse inside one worker run
  - does not poll the tracker or decide lifecycle transitions
- `orchestrator`
  - owns the continuation-turn loop and calls tracker inspection/reconciliation between turns
  - does not parse raw Codex CLI streams for backend-session facts beyond consuming the runner contract
- `observability`
  - records the backend conversation id and turn/session facts already resolved by runner/orchestrator
  - does not independently infer continuation state

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam limited to the current Codex local runner and the orchestration path that already owns retries and handoff decisions.

The PR will:

1. add a narrow multi-turn runner-session contract for the existing local Codex backend
2. add a continuation-turn loop in the orchestrator that consumes normalized tracker lifecycle after each turn
3. add `agent.max_turns` and prompt rendering for continuation guidance
4. add observability/tests for the reused backend session id

This seam deliberately avoids:

- backend-neutral runner redesign
- new tracker policy
- app-server protocol adoption
- lease/watchdog redesign unrelated to turn continuity

## Runtime State Model

This issue introduces a worker-run inner turn loop distinct from outer reruns.

### State variables

- `runSequence`
  - existing worker-run attempt number used for retries/follow-up history
- `turnNumber`
  - current turn within one worker run, starting at `1`
- `maxTurns`
  - `agent.max_turns` budget for one worker run
- `backendSessionId`
  - Codex conversation/session id reused across turns within the same worker run
- `followUpAttempt`
  - existing outer actionable-follow-up budget counter
- `failureRetryAttempt`
  - existing outer failure retry counter

### Inner turn states

- `starting-session`
  - workspace prepared, initial prompt built, live runner session not yet established
- `running-turn`
  - runner is executing one turn on the current backend conversation
- `reconciling-turn`
  - runner turn ended successfully and the orchestrator is reconciling tracker state
- `continuing`
  - tracker still reports active actionable work and another turn is allowed
- `waiting`
  - tracker reports a non-actionable active lifecycle such as awaiting human review, checks, or landing
- `completed`
  - tracker reports terminal `handoff-ready`
- `failed`
  - turn execution or post-turn reconciliation failed and outer retry/failure handling takes over
- `max-turns-exhausted`
  - issue remains actionable after `agent.max_turns`; orchestration records a follow-up wait/failure path explicitly rather than silently looping forever

### Allowed transitions

- `starting-session -> running-turn`
  - initial runner session starts successfully
- `running-turn -> failed`
  - runner exits non-zero, times out, or aborts
- `running-turn -> reconciling-turn`
  - runner exits successfully
- `reconciling-turn -> completed`
  - tracker returns `handoff-ready`
- `reconciling-turn -> waiting`
  - tracker returns `awaiting-human-handoff`, `awaiting-system-checks`, or `awaiting-landing`
- `reconciling-turn -> continuing`
  - tracker returns `missing-target` or `actionable-follow-up` and another turn is allowed under the current policy
- `continuing -> running-turn`
  - continuation prompt is built and sent on the same backend session
- `continuing -> max-turns-exhausted`
  - tracker still needs action but `turnNumber === maxTurns`
- `max-turns-exhausted -> waiting` or `failed`
  - exact outcome depends on the normalized lifecycle and existing outer-budget rules chosen during implementation; this must be explicit in code/tests

### Runtime decision rules

- turn 1 always uses the full rendered workflow prompt
- turn 2+ always use continuation guidance only
- continuation turns reuse the same workspace and the same backend Codex session id
- tracker reconciliation happens after every successful turn
- outer retry/follow-up budgets remain separate from `agent.max_turns`
- exhausting `agent.max_turns` does not mutate tracker transport state implicitly; the orchestrator must record an explicit outcome and leave the issue in an inspectable state

## Failure-Class Matrix

| Observed condition                                                                           | Local facts available                             | Normalized tracker facts available     | Expected decision                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Initial turn fails to start                                                                  | no backend session id yet                         | unchanged                              | existing failure retry path                                                                                                |
| Initial turn succeeds and tracker says `handoff-ready`                                       | workspace exists, session may have backend id     | terminal handoff                       | complete issue and close runner session                                                                                    |
| Initial turn succeeds and tracker says `awaiting-system-checks`                              | backend session id captured                       | non-actionable waiting state           | stop inner loop, persist session metadata, leave issue running                                                             |
| Initial turn succeeds and tracker says `awaiting-human-handoff`                              | backend session id captured                       | non-actionable waiting state           | stop inner loop, persist session metadata, wait for human feedback                                                         |
| Initial turn succeeds and tracker says `actionable-follow-up`, turns remain                  | backend session id captured                       | actionable follow-up                   | send continuation prompt on same backend session                                                                           |
| Continuation turn succeeds and tracker still says `actionable-follow-up`, turns remain       | same backend session id                           | actionable follow-up                   | continue same live session                                                                                                 |
| Continuation turn succeeds and tracker still says actionable work, but `max_turns` exhausted | same backend session id, `turnNumber == maxTurns` | actionable follow-up or missing-target | record explicit exhaustion outcome and hand off to existing outer retry/follow-up policy without cold-looping indefinitely |
| Continuation turn fails after prior successful turns                                         | backend session id captured                       | unchanged                              | existing failure retry path; next outer rerun may start a fresh worker run                                                 |
| Runner cannot recover backend session id from successful first turn                          | stdout/stderr/JSONL available                     | actionable follow-up after turn 1      | treat as runner failure rather than silently cold-starting continuation                                                    |

## Storage / Persistence Contract

- the existing Symphony `RunSession.id` remains the worker-run session identifier used by leases/watchdog/status
- add a distinct backend conversation/session id field for the Codex session reused across turns
- issue artifacts should record:
  - Symphony run session id
  - backend session id
  - attempt/run sequence
  - turn count or latest turn number reached
- status snapshots should surface the current turn number and backend session id only if that can be done without broad schema churn; otherwise the issue-artifact/session surface is the required minimum for this PR

## Observability Requirements

- log when a live runner session starts, when continuation turns resume, and when `agent.max_turns` is exhausted
- issue artifacts must show that multiple turns shared one backend session id
- runner session descriptions/log pointers should remain usable by report enrichment after the contract change
- failure messages for continuation exhaustion should distinguish inner turn-budget exhaustion from outer retry exhaustion

## Implementation Steps

1. Add `agent.max_turns` to workflow/domain types, parsing, defaults, README/WORKFLOW docs, and config tests.
2. Extend prompt-building contracts so the orchestrator can request:
   - initial task prompt
   - continuation guidance prompt with turn number and `max_turns`
3. Introduce a narrow live runner-session interface in `src/runner/service.ts` and test doubles in unit tests.
4. Implement the local Codex runner live session using:
   - turn 1 via `codex exec`
   - turn 2+ via `codex exec resume <backend-session-id>`
   - explicit backend session-id capture and propagation
5. Refactor the orchestrator run path to:
   - prepare the workspace once
   - start one live runner session
   - execute turn 1
   - reconcile tracker lifecycle after each successful turn
   - continue or stop based on normalized lifecycle and `agent.max_turns`
6. Extract any dedicated runtime-state helper needed so turn count is not overloaded with retry/follow-up counters.
7. Update issue-artifact/status session recording to include the backend session id and continuation-turn facts.
8. Add focused fixtures and tests for:
   - successful continuation on same backend session
   - stop-on-wait-state
   - stop-on-completion
   - `max_turns` exhaustion
   - failure when backend session id is missing
9. Run repo gates and self-review before opening the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main`

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts `agent.max_turns` and rejects invalid values
- continuation prompt builder renders only continuation guidance and includes current turn number / max turns
- local runner reuses one backend session id across resumed turns
- local runner fails explicitly when a continuation is requested but no backend session id was captured
- orchestrator inner turn loop:
  - continues on actionable follow-up while turn budget remains
  - stops on waiting lifecycle without consuming outer failure retry budget
  - completes on `handoff-ready`
  - records an explicit exhaustion path when `agent.max_turns` is reached
- follow-up runtime-state tests continue to prove that run sequence, follow-up attempts, failure retries, and continuation turns are distinct concepts

### Integration

- GitHub bootstrap integration remains unchanged in how lifecycle is normalized after a turn
- issue-artifact/session outputs show one backend session id reused across multiple turns
- report/status readers continue to tolerate the extended session metadata

### End-to-end

- bootstrap factory run opens a PR, receives actionable review feedback, performs a continuation turn in the same worker run, and resolves the feedback without spawning a fresh outer worker session
- bootstrap factory stops continuation turns when the PR becomes a waiting state after a successful turn
- bootstrap factory leaves an inspectable failure state when actionable follow-up remains after `agent.max_turns`

### Acceptance Scenarios

1. Turn 1 opens or updates a PR, tracker reports actionable follow-up, and turn 2 resumes the same Codex conversation rather than re-rendering the full task prompt from scratch.
2. A continuation turn resolves the remaining feedback, tracker reports a waiting or terminal lifecycle, and the worker exits without another cold-start runner process.
3. If review churn persists past `agent.max_turns`, the run records an explicit exhaustion outcome instead of looping indefinitely or silently merging turn budget into retry budget.
4. Issue/session artifacts show one backend conversation id reused across the turns of a single worker run.

## Exit Criteria

- `agent.max_turns` is configurable and documented
- the orchestrator can drive multiple continuation turns within one worker run
- continuation turns reuse the same Codex conversation and send only continuation guidance
- tracker lifecycle is re-checked between turns and stops the loop correctly
- observability shows the reused backend session id
- unit and e2e coverage pin the multi-turn behavior and exhaustion path
- the change stays within one reviewable PR without sliding into provider-neutral or app-server refactor scope

## Deferred To Later Issues Or PRs

- replacing `codex exec/resume` with app-server-native transport
- provider-neutral live runner session interfaces and backend registration from `#89`
- remote/background worker session persistence across process restarts
- broader report/schema enrichment for turn-by-turn analytics beyond the minimal session continuity facts added here

## Revision Log

- 2026-03-12: Initial plan created. Uses `codex exec resume` as the narrow Codex-specific seam for same-thread continuation in this PR and defers app-server transport to later runner work.
