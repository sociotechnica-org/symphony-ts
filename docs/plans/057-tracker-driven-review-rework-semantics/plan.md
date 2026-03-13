# Issue 57 Plan: Tracker-Driven Review And Rework Semantics

## Status

- plan-ready

## Goal

Replace the current follow-up attempt budget with tracker-driven review and rework semantics so repeated PR review cycles remain active work, while real runtime failures still use explicit retry and backoff policy.

This plan uses the local abstraction mapping from `docs/architecture.md` because `SPEC.md` is not present in this clone.

## Scope

- replace the orchestrator-facing `actionable-follow-up` budget path with an explicit tracker-neutral rework state
- distinguish tracker waiting states for human review vs automated checks instead of collapsing them into one generic review wait
- remove `max_follow_up_attempts` as the control-plane contract for ordinary PR review churn
- replace the current `follow-up-state.ts` attempt-budget bookkeeping with explicit continuation and failure-retry runtime state
- update GitHub and Linear policy mapping so tracker-specific review/rework facts stay at the edge
- update status, issue artifacts, docs, and tests to reflect the new review/rework model
- preserve existing runtime failure retries, backoff, lease handling, and landing flow

## Non-goals

- redesigning tracker transport clients or mixing transport with normalization/policy
- changing the runner continuation-turn contract from `#99`
- introducing Beads-specific workflow semantics
- changing landing authorization policy, `/land` handling, or merge execution
- broad report-schema redesign beyond the compatibility updates required by the lifecycle rename
- solving unrelated reporting work from `#32` and children in the same PR

## Current Gaps

- `src/domain/handoff.ts` still uses `actionable-follow-up`, which conflates tracker-driven rework with a near-terminal retry path
- `src/tracker/pull-request-policy.ts` collapses "waiting for human review" into `awaiting-system-checks`, so the orchestrator cannot distinguish healthy waiting from rework-ready work
- `src/orchestrator/follow-up-state.ts` overloads one module with run sequencing, review follow-up budget, and failure retry counters
- `src/orchestrator/service.ts` fails an issue when `actionable-follow-up` observations exceed `polling.retry.maxFollowUpAttempts`, even though the tracker still says the work is active
- `WORKFLOW.md`, config parsing, and tests still expose `polling.retry.max_follow_up_attempts` as if review churn were a retry budget
- status and issue artifacts still surface `actionable-follow-up` / `needs-follow-up`, reinforcing the wrong mental model

## Decision Notes

- This slice should remove `polling.retry.max_follow_up_attempts` from the active runtime contract instead of keeping it as an inert compatibility knob. Leaving the field in place would preserve the wrong policy surface.
- The normalized lifecycle model should separate "waiting for review" from "rework requested" so the orchestrator reacts to tracker state, not to implicit counters.
- Failure retry policy remains explicit and numeric. This issue changes review/rework continuation semantics, not runtime failure recovery semantics.
- The first implementation seam is the shared lifecycle contract plus the focused runtime-state refactor. Transport changes, reporting product work, and broader tracker rewrites stay out.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining review, rework, waiting, retry, and terminal semantics as repository-owned runtime policy
  - does not belong: GitHub API details, Linear GraphQL payloads, or subprocess retry timers
- Configuration Layer
  - belongs: removing the obsolete follow-up budget field, preserving failure retry/backoff config, and updating workflow validation/defaults
  - does not belong: tracker lifecycle classification or orchestrator retry decisions
- Coordination Layer
  - belongs: explicit continuation state, run sequencing, failure retry scheduling, and decisions to wait, rerun, fail, or complete
  - does not belong: tracker-specific PR or Linear workflow parsing
- Execution Layer
  - belongs: unchanged runner/workspace mechanics that execute a rerun when the coordinator asks for one
  - does not belong: interpreting review comments, check results, or tracker workflow states
- Integration Layer
  - belongs: mapping GitHub and Linear review/check/workflow facts into the normalized handoff and rework states
  - does not belong: retry backoff policy or in-memory continuation bookkeeping
- Observability Layer
  - belongs: surfacing the new normalized waiting/rework states and the remaining failure-retry state distinctly
  - does not belong: re-deriving tracker policy from raw payloads

## Architecture Boundaries

### Belongs in this issue

- `src/domain/handoff.ts`
  - replace `actionable-follow-up` with explicit rework-oriented lifecycle state(s)
- `src/tracker/pull-request-policy.ts`
  - map PR checks, actionable review feedback, and waiting-for-human-review into the normalized lifecycle states
- `src/tracker/linear-policy.ts`
  - map `Human Review`, `Rework`, and terminal/landing states into the same normalized lifecycle contract
- `src/orchestrator/follow-up-state.ts` or successor module(s)
  - separate run sequencing, tracker-driven continuation state, and failure retry counters into explicit transitions
- `src/orchestrator/service.ts`
  - consume the normalized lifecycle states and stop failing active rework loops due to a follow-up budget
- `src/config/workflow.ts`, `src/domain/workflow.ts`, and `WORKFLOW.md`
  - remove the obsolete config field and keep failure retry config explicit
- `src/orchestrator/status-state.ts`, `src/observability/status.ts`, and issue-artifact helpers
  - surface the new lifecycle names and outcomes cleanly
- unit, integration, and e2e tests that prove multi-round review loops stay active without spurious terminal failure

### Does not belong in this issue

- tracker transport rewrites or a combined GitHub/Linear adapter abstraction
- runner subprocess/session changes unrelated to review/rework semantics
- lease/watchdog redesign unless a narrow helper extraction is required by the runtime-state refactor
- archive/report feature work that is not required to keep artifacts/status coherent after the lifecycle rename
- Beads workflow modeling

## Layering Notes

- `config/workflow`
  - owns the typed runtime contract for failure retries
  - does not own tracker-driven rework semantics beyond exposing the absence of the old follow-up budget
- `tracker`
  - owns tracker-specific mapping into normalized lifecycle states such as `awaiting-human-review` and `rework-required`
  - does not own retry budgeting or orchestrator sequencing
- `workspace`
  - remains responsible for deterministic workspace reuse
  - does not infer whether a rerun is rework vs retry
- `runner`
  - remains responsible for executing the next turn/run
  - does not decide whether tracker facts represent rework or failure
- `orchestrator`
  - owns the state machine for continuation, waiting, failure retry, and completion
  - does not parse GitHub/Linear-specific review payloads
- `observability`
  - records normalized state transitions and retry/rework facts already decided by tracker/orchestrator layers
  - does not introduce a second policy layer

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the seam limited to:

1. the shared lifecycle vocabulary
2. the tracker-edge mapping into that vocabulary
3. the focused orchestrator runtime-state refactor that removes the review follow-up budget
4. the minimum config/docs/observability/test updates required by that contract change

This stays reviewable because it deliberately does not combine:

- transport changes
- runner redesign
- landing workflow changes
- reporting feature work

If implementation shows that artifact schema churn would become broad, keep artifact changes as explicit compatibility mapping in this PR and defer schema redesign.

## Runtime State Model

### Normalized tracker / handoff states

The orchestrator-facing lifecycle should distinguish these active states:

- `missing-target`
  - no plan-review or PR handoff target exists yet after a run
- `awaiting-human-handoff`
  - plan is posted and waiting at the explicit human review station
- `awaiting-human-review`
  - PR/work item is waiting for human review with no actionable rework signal yet
- `awaiting-system-checks`
  - PR/work item is waiting on CI or other automated checks
- `rework-required`
  - tracker says the issue remains active and another worker run is needed
- `awaiting-landing-command`
  - work is clean and waiting for an explicit human landing signal
- `awaiting-landing`
  - landing was requested and merge observation is pending
- `handoff-ready`
  - tracker reports terminal success / completion readiness

### Runtime continuation state

Replace the current follow-up budget state with explicit coordination facts:

- `nextRunSequenceByIssueNumber`
  - next worker-run sequence number for the issue
- `activeContinuationByIssueNumber`
  - last normalized continuation reason observed for the issue:
    - `implementation`
    - `rework`
    - `waiting-human-review`
    - `waiting-system-checks`
    - `waiting-plan-review`
    - `landing`
- `nextFailureRetryAttemptByIssueNumber`
  - numeric retry attempt only for abnormal failures

No numeric budget should be maintained for ordinary `rework-required` loops.

### Allowed transitions

- initial claimed issue -> worker run attempt `1`
- successful run -> `missing-target`
  - no valid plan-review or PR handoff exists yet; orchestrator uses existing failure handling
- successful run -> `awaiting-human-handoff`
  - wait for explicit plan review response
- successful run or refresh -> `awaiting-human-review`
  - wait while review is pending and no actionable rework exists
- successful run or refresh -> `awaiting-system-checks`
  - wait while automated checks are pending or still settling
- successful run or refresh -> `rework-required`
  - rerun on the same issue branch without incrementing a review budget
- successful run or refresh -> `awaiting-landing-command`
  - wait for human landing authorization
- `awaiting-landing-command` -> `awaiting-landing`
  - landing command observed and landing execution requested
- successful refresh -> `handoff-ready`
  - complete issue and clear runtime state
- runner/process failure from any active state -> failure retry scheduling or terminal failure based on `maxAttempts`

### Runtime decision rules

- wait on `awaiting-human-handoff`
- wait on `awaiting-human-review`
- wait on `awaiting-system-checks`
- rerun on `rework-required`
- fail or retry on `missing-target` using the existing failure path
- complete on `handoff-ready`
- only abnormal runner/orchestrator failures consume `polling.retry.max_attempts`
- repeated `rework-required` observations are normal active work and must not consume a terminal budget

## Failure-Class Matrix

| Observed condition                                                                               | Local facts available                  | Normalized tracker facts available                         | Expected decision                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Successful run exits with no PR and no valid plan-review handoff                                 | workspace exists, runner succeeded     | `missing-target`                                           | use existing failure retry / terminal failure policy                                                                  |
| Plan posted and waiting for a human reply                                                        | runner succeeded, no PR yet            | `awaiting-human-handoff`                                   | keep issue running and wait                                                                                           |
| PR exists with pending checks and no rework signal                                               | no active runner needed                | `awaiting-system-checks`                                   | keep issue running and wait                                                                                           |
| PR exists with no pending checks and no feedback yet; human review is still open                 | no active runner needed                | `awaiting-human-review`                                    | keep issue running and wait                                                                                           |
| PR review or tracker workflow requests rework                                                    | no active runner needed                | `rework-required`                                          | rerun on the same branch with no review budget exhaustion                                                             |
| Rework loop repeats several times but each run exits normally                                    | prior run sequences recorded           | repeated `rework-required` observations                    | continue active work indefinitely until tracker leaves the active rework state or a separate failure condition occurs |
| Runner exits non-zero during implementation or rework                                            | runner failure details, attempt number | lifecycle may still be active                              | schedule retry/backoff; escalate only when `maxAttempts` is exhausted                                                 |
| Tracker moved issue/PR into terminal success state                                               | latest refresh available               | `handoff-ready`                                            | complete issue and clear runtime state                                                                                |
| Tracker moved issue into deliberate terminal failure or blocked state in a future adapter policy | latest refresh available               | normalized terminal failure classification once introduced | fail explicitly; do not treat as review churn                                                                         |

## Storage / Persistence Contract

- status snapshots should record the normalized lifecycle name and distinguish review wait from rework wait
- issue artifacts should preserve run sequence numbers while no longer implying a numeric follow-up budget
- in-memory orchestrator state should persist only:
  - next run sequence
  - active continuation reason
  - next abnormal-failure retry attempt
- if artifact outcome names such as `needs-follow-up` remain temporarily for compatibility, keep the translation explicit and local

## Observability Requirements

- status output must show `awaiting-human-review`, `awaiting-system-checks`, and `rework-required` as distinct conditions
- issue artifacts must distinguish normal waiting from rework-triggered reruns
- logs should record when a rerun is tracker-driven rework versus abnormal failure retry
- failure messages should no longer mention exhausted follow-up budgets for ordinary review churn

## Implementation Steps

1. Replace the shared lifecycle vocabulary in `src/domain/handoff.ts` and the direct consumers so review waiting and rework are distinct normalized states.
2. Update `src/tracker/pull-request-policy.ts` to map:
   - pending checks to `awaiting-system-checks`
   - waiting-for-human-review to `awaiting-human-review`
   - actionable review feedback or equivalent review workflow signals to `rework-required`
3. Update `src/tracker/linear-policy.ts` to map `Human Review` to `awaiting-human-review` and `Rework` or equivalent changes-requested signals to `rework-required`.
4. Refactor `src/orchestrator/follow-up-state.ts` into an explicit continuation/runtime-state helper that separates run sequencing from abnormal failure retry state and removes the review follow-up budget counter.
5. Update `src/orchestrator/service.ts` to consume the new lifecycle states, rerun on `rework-required`, and reserve terminal failure for actual failure conditions rather than review-loop depth.
6. Remove `polling.retry.max_follow_up_attempts` from the typed workflow contract, defaults, docs, and validation.
7. Update observability/status/artifact helpers to reflect the normalized states without leaking the old `actionable-follow-up` vocabulary.
8. Update test builders/helpers where repeated review-loop fixtures currently hard-code the old lifecycle names or config field.
9. Run format, lint, typecheck, unit/integration/e2e tests, plus a local self-review pass if a reliable review tool is available.

## Tests And Acceptance Scenarios

### Unit

- GitHub PR policy maps:
  - pending checks -> `awaiting-system-checks`
  - no pending checks plus no actionable feedback while review is open -> `awaiting-human-review`
  - actionable feedback / settled rework signal -> `rework-required`
  - merged / clean landing-ready state -> existing landing-ready or `handoff-ready` paths
- Linear policy maps:
  - `Human Review` -> `awaiting-human-review`
  - `Rework` -> `rework-required`
  - approval/waiver and landing states remain unchanged
- orchestrator runtime-state helpers:
  - keep run sequencing across repeated rework loops
  - increment only abnormal failure retry attempts
  - clear state on completion/failure
- workflow config tests reject or remove the obsolete `max_follow_up_attempts` field according to the final compatibility decision

### Integration

- tracker integration reports distinct lifecycle states for:
  - plan review wait
  - PR human review wait
  - system-check wait
  - rework-required
  - handoff-ready
- orchestrator integration tests prove that repeated `rework-required` refreshes do not mark the issue failed merely due to loop count
- failure retry tests still back off and eventually fail when the runner keeps erroring

### End-to-end

- GitHub bootstrap review loop:
  - implementation run opens a PR
  - review feedback appears
  - Symphony reruns
  - more review feedback appears
  - Symphony reruns again
  - issue never enters `symphony:failed` solely because of review-loop depth
- GitHub bootstrap waiting loop:
  - PR is waiting on human review or pending checks
  - Symphony keeps the issue active without rerunning or failing
- failure path:
  - runner repeatedly fails during implementation or rework
  - Symphony still uses retry/backoff and escalates only when failure retries are exhausted

### Repo gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- formatter command/check used by the repo
- local self-review if a reliable tool is available

## Acceptance Scenarios

1. A PR goes through multiple rounds of requested changes, and Symphony keeps the issue active through each rework cycle without exhausting a review budget.
2. A PR is simply waiting on human review, and Symphony records a waiting state rather than scheduling reruns or failure.
3. A PR is waiting on CI, and Symphony records a system-check waiting state rather than rerunning early.
4. A run fails because the runner or orchestrator genuinely errors, and Symphony still uses retry/backoff plus terminal escalation when the failure budget is exhausted.
5. Linear and GitHub tracker policies both map into the same normalized waiting/rework model, keeping tracker-specific workflow policy at the edge.

## Exit Criteria

- repeated review/rework loops no longer fail an issue because `max_follow_up_attempts` was exhausted
- the orchestrator-facing lifecycle distinguishes at least:
  - waiting for human handoff
  - waiting for human review
  - waiting for system checks
  - tracker-driven rework
  - landing wait
  - terminal handoff-ready
- abnormal failure retries remain numeric and backoff-driven
- the obsolete follow-up budget field is removed from the active workflow/config contract
- unit, integration, and e2e coverage demonstrate multi-round review loops without spurious `symphony:failed`
- the PR remains one reviewable slice focused on lifecycle normalization plus runtime-state refactor

## Deferred To Later Issues Or PRs

- tracker-neutral modeling of explicit blocked/escalated terminal states beyond the states needed for this issue
- report schema redesign once the new lifecycle vocabulary has settled
- Beads-specific review/rework mapping
- broader reconciliation/lease refactors unrelated to the review/rework state seam

## Revision Log

- 2026-03-13: Initial plan created for issue `#57`.
- 2026-03-13: Promoted to `plan-ready` for issue-thread review handoff.
