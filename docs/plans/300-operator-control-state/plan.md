# Issue 300 Plan: Operator Control State And Prompt-Scope Reduction

## Status

- plan-ready

## Goal

Reduce the checked-in operator skill and prompt to durable policy and human
judgment rules, while moving deterministic wake-up checkpoints and operator
gates into a typed code-owned control surface.

The intended outcome of this slice is:

1. the operator loop publishes one inspectable control-state artifact for the
   current wake-up cycle instead of relying on a long prompt to restate the
   full deterministic procedure
2. mandatory checkpoint ordering and queue-gating rules live in code and tests
3. the operator prompt becomes smaller and more stable because it consumes the
   control-state artifact rather than being the only place that explains the
   wake-up algorithm
4. future operator sub-skill splits can build on that control surface instead
   of copying more prose into prompts

## Scope

This slice covers:

1. a typed operator control-state model that summarizes the current wake-up
   checkpoint results for one selected instance
2. code that evaluates the mandatory operator checkpoints in deterministic
   order from existing factory, report-review, release-state, and issue/PR
   evidence
3. operator-loop wiring that refreshes and publishes that control-state before
   the operator command runs
4. prompt and skill edits that remove duplicated deterministic procedure text
   and point the operator to the generated control-state artifact
5. operator-facing docs and tests that make the new boundary explicit

## Non-Goals

This slice does not include:

1. fully automating GitHub mutations such as posting plan-review decisions or
   `/land` from code
2. redesigning tracker transport, normalization, or lifecycle policy
3. broad operator-loop shell refactors unrelated to the control-state seam
4. a full sub-skill taxonomy for operator work before the control surface is
   stable
5. replacing the operator's need for judgment on plan quality, review quality,
   or release-risk tradeoffs

## Current Gaps

1. `skills/symphony-operator/operator-prompt.md` still carries too much
   deterministic wake-up procedure, including checkpoint order, restart rules,
   report-review sequencing, release gating, and operator-gated work checks
2. `skills/symphony-operator/SKILL.md` duplicates much of that same procedure,
   so durable policy and per-cycle control flow are mixed together
3. `skills/symphony-operator/operator-loop.sh` already enforces some control
   behavior in code, such as release-state refresh, ready promotion, wake-up
   leases, and session handling, but it does not publish one typed checkpoint
   result that the prompt can consume
4. existing tests mostly pin prompt wording and string ordering rather than a
   narrower code-owned contract for "what operator work is required now" and
   "what blocks ordinary queue advancement"
5. the current surface makes it hard to tell which operator rules are durable
   policy that belong in the skill versus deterministic checkpoint behavior
   that should be inspectable in code and tests

## Decision Notes

1. Treat this as an operator coordination and observability seam, not as a
   tracker-policy rewrite. The repo already has tracker lifecycle and landing
   contracts; the missing part is a typed operator-facing control surface.
2. Move deterministic checkpoint ordering into code first. Only after that
   surface exists should the repository consider splitting additional
   operator sub-skills.
3. Keep the operator prompt responsible for judgment, escalation, and
   repository-owned policy. Do not try to turn this slice into a fully
   autonomous operator product.
4. Reuse existing sources of truth instead of inventing new ones:
   `factory status --json`, runtime-freshness results, completed-run
   report-review state, release-state evaluation, and normalized issue/PR
   lifecycle facts should feed the new control-state artifact.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses
[`docs/architecture.md`](../../architecture.md).

### Policy Layer

Belongs here:

1. the rule that deterministic wake-up checkpoint ordering is repo-owned
   behavior and should not depend on prompt luck
2. the rule that the operator prompt should focus on judgment, escalation, and
   repo policy rather than re-specifying the entire wake-up algorithm
3. the rule that release blockers and report-review blockers gate ordinary
   queue advancement and landing

Does not belong here:

1. shell-only checkpoint ordering hidden in prompt prose
2. tracker transport or GitHub API details

### Configuration Layer

Belongs here:

1. any typed path derivation for the new operator control-state artifact under
   the selected instance's operator state root
2. any explicit environment contract that exposes the control-state artifact to
   the operator command

Does not belong here:

1. issue/PR policy evaluation logic
2. tracker parsing embedded in the shell script

### Coordination Layer

Belongs here:

1. the deterministic evaluation order for wake-up checkpoints
2. the classification of current operator posture such as runtime-blocked,
   report-review-blocked, release-blocked, action-required, or clear
3. the action list that distinguishes blocked ordinary queue work from
   operator-owned follow-up work

Does not belong here:

1. tracker-specific transport concerns
2. prompt-only ordering rules without typed state

### Execution Layer

Belongs here:

1. operator-loop execution of the control-state evaluator before the operator
   command runs
2. exporting the generated control-state path and summary to the operator
   command environment
3. prompt consumption of that generated artifact

Does not belong here:

1. runner-provider rewrites unrelated to the operator loop
2. ad hoc shell branching that duplicates typed evaluator logic

### Integration Layer

Belongs here:

1. reading existing tracker-derived and operator-local artifacts through stable
   interfaces to build the control-state snapshot
2. normalization of those inputs into one operator-owned checkpoint summary

Does not belong here:

1. new GitHub transport or review parsing rules
2. mixing tracker transport, normalization, and operator policy in one broad
   module

### Observability Layer

Belongs here:

1. the inspectable control-state artifact and any status exposure needed to
   show the current checkpoint posture
2. tests and docs that make the new prompt/code boundary explicit
3. operator-facing summaries that explain which checkpoint currently blocks
   ordinary queue work

Does not belong here:

1. burying control decisions only in log text
2. making the prompt the only inspectable source of operator checkpoint order

## Architecture Boundaries

### New focused operator control-state module(s)

Owns:

1. loading the existing operator inputs needed for one wake-up decision pass
2. evaluating checkpoint posture in deterministic order
3. producing a typed summary plus a normalized action list and blockers

Does not own:

1. GitHub API transport
2. posting review comments or `/land`
3. notebook-writing behavior

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. refreshing the operator control-state artifact at the right point in the
   cycle
2. exporting the artifact path and any summary environment values to the
   operator command
3. keeping the shell script thin by delegating evaluation logic to focused
   TypeScript helpers

Does not own:

1. the only definition of checkpoint policy
2. broad parsing of report-review, release-state, and lifecycle inputs inline
   in bash

### `skills/symphony-operator/operator-prompt.md`

Owns:

1. concise operator instructions for how to use the generated control-state
   artifact
2. durable judgment rules, escalation rules, and repository-policy reminders

Does not own:

1. the full deterministic wake-up sequence in prose
2. the only source of truth for which actions are currently required

### `skills/symphony-operator/SKILL.md` and operator docs

Owns:

1. durable operator behavior, boundaries, and escalation rules
2. explaining what stays in policy/docs versus what is now generated in code

Does not own:

1. per-cycle action ordering duplicated from code
2. hidden control behavior that exists only in prose

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on one narrow seam: add a typed
operator control-state artifact and update the checked-in prompt/skill/docs to
consume that surface instead of embedding the full deterministic wake-up
procedure.

This stays reviewable because it limits the work to:

1. one new focused evaluation module plus any small supporting path/wiring
2. targeted operator-loop plumbing
3. prompt and skill reduction
4. contract tests for the generated checkpoint surface

Deferred from this PR:

1. any broader automation of plan review or landing
2. any new operator sub-skills beyond what is required to clarify the new
   boundary
3. tracker lifecycle or GitHub integration redesign

## Runtime State Model

This slice does not add new tracker lifecycle kinds. It adds an
operator-loop-local checkpoint posture model for one wake-up cycle.

### Posture states

1. `runtime-blocked`
   - detached runtime health or freshness requires repair before ordinary queue
     work
2. `report-review-blocked`
   - completed-run report review has pending `report-ready` or
     `review-blocked` work that must be handled first
3. `release-blocked`
   - release-state or ready-promotion results block downstream advancement or
     `/land`
4. `action-required`
   - operator-gated handoff work exists, such as plan review or `/land`, and
     earlier blockers are clear
5. `clear`
   - no operator-gated work or higher-priority blockers are present for this
     cycle

### Allowed transitions

1. `runtime-blocked -> report-review-blocked`
   - runtime health is acceptable and freshness no longer blocks queue work
2. `report-review-blocked -> release-blocked`
   - pending completed-run report review is cleared
3. `release-blocked -> action-required`
   - release gate no longer blocks queue advancement or landing
4. `action-required -> clear`
   - no remaining plan-review or landing action is pending
5. any state -> `runtime-blocked`
   - a new runtime health or freshness problem is observed on the next cycle

### Explicit non-changes

1. no new issue lifecycle kinds
2. no retry-budget or reconciliation changes
3. no new landing protocol markers or plan-review protocol markers

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker / artifact facts available | Expected decision |
| --- | --- | --- | --- |
| Detached runtime is stopped, degraded, or unreadable | `factory status --json` control state | current active issue state may be stale | classify `runtime-blocked`; repair runtime before ordinary queue work |
| Freshness reports stale `*-idle` | runtime-freshness result and selected instance paths | merge or workflow drift facts | classify `runtime-blocked`; restart before queue advancement |
| Freshness reports stale `*-busy` | runtime-freshness result | live worker still active | record stale-but-busy; do not restart immediately; keep ordinary queue work blocked until the current run reaches a safe checkpoint |
| Completed-run reports are `report-ready` or `review-blocked` | operator review ledger plus report artifacts | no tracker mutation required yet | classify `report-review-blocked`; review reports before plan review or landing |
| Release state is `blocked-by-prerequisite-failure`, `blocked-review-needed`, or promotion is `sync-failed` | `release-state.json` and promotion result | downstream issue/PR metadata | classify `release-blocked`; do not promote or `/land` blocked release work |
| Active issue is `awaiting-human-handoff` and earlier blockers are clear | factory status plus selected instance docs | normalized plan-review lifecycle | classify `action-required`; prompt should review the plan using repo-owned policy |
| PR or active issue is `awaiting-landing-command` and earlier blockers are clear | factory status plus review/check summaries | normalized landing-ready lifecycle | classify `action-required`; prompt should consider posting `/land` if the guard conditions are satisfied |
| No blockers and no operator-gated action remain | all checkpoint inputs clear | no pending handoff work | classify `clear`; operator should record the cycle and stop |

## Storage / Persistence Contract

1. add one inspectable operator-local artifact under the selected instance's
   operator state root, likely alongside `status.json`, `release-state.json`,
   and `report-review-state.json`
2. treat that artifact as a derived checkpoint snapshot, not as a new source of
   repository policy truth
3. keep existing sources of truth unchanged:
   - `factory status --json`
   - runtime-freshness output
   - completed-run report-review ledger and reports
   - `release-state.json`
   - normalized issue and PR lifecycle facts

## Observability Requirements

1. operators must be able to inspect the current checkpoint posture and action
   list without reading the full prompt text
2. prompt-capture tests should prove the prompt now points to the generated
   control-state surface instead of duplicating the entire wake-up procedure
3. the operator status or adjacent artifact surface should make it obvious why
   queue work is blocked and which checkpoint owns that block

## Implementation Steps

1. add the issue plan under
   `docs/plans/300-operator-control-state/plan.md`
2. add typed path support for the new operator control-state artifact if the
   existing instance-state path contract does not already cover it
3. implement a focused control-state evaluator that:
   - loads existing runtime-health, freshness, report-review, release-state,
     and normalized handoff facts
   - evaluates them in deterministic order
   - emits one typed posture plus action/blocker summary
4. add a small CLI/helper entry point so `operator-loop.sh` can refresh that
   control-state artifact before running the operator command
5. wire `operator-loop.sh` to export the control-state path and summary to the
   operator environment
6. reduce `skills/symphony-operator/operator-prompt.md` so it:
   - reads the generated control-state artifact
   - keeps only durable policy and judgment instructions
   - stops duplicating most deterministic checkpoint order prose
7. update `skills/symphony-operator/SKILL.md`,
   `docs/guides/operator-runbook.md`, and nearby operator docs to describe the
   new boundary and artifact
8. add tests for:
   - unit evaluation of checkpoint posture and action ordering
   - integration coverage that the operator loop writes and exports the
     control-state artifact
   - prompt/skill contract coverage proving prompt-scope reduction
9. run local QA:
   - `pnpm format`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`

## Tests And Acceptance Scenarios

### Unit / Contract

1. given runtime degradation or stale-idle freshness, the evaluator emits
   `runtime-blocked` and does not expose ordinary queue work as the first
   action
2. given pending completed-run report review, the evaluator emits
   `report-review-blocked` ahead of plan review or landing actions
3. given blocked release-state or ready-promotion failure, the evaluator emits
   `release-blocked` and marks landing/promotion work as blocked
4. given `awaiting-human-handoff` or `awaiting-landing-command` with earlier
   blockers clear, the evaluator emits `action-required` with the normalized
   action kind

### Integration

1. the operator loop writes the control-state artifact into the instance-scoped
   operator state root and exports its path to the operator command
2. prompt capture shows the prompt reading that artifact and no longer carrying
   the full deterministic checkpoint sequence verbatim
3. self-hosting and selected-instance behavior remain intact

### End-to-End

1. a one-cycle operator wake-up against fixture data can surface:
   - runtime blocked
   - report-review blocked
   - release blocked
   - plan-review required
   - landing required
   through the generated control-state artifact without changing tracker
   lifecycle kinds

## Exit Criteria

1. deterministic operator checkpoint ordering is owned by code and tests rather
   than mainly by prompt prose
2. the operator prompt and skill are materially smaller and focus on policy,
   judgment, and escalation
3. the current checkpoint posture and required operator actions are inspectable
   from a generated artifact
4. local validation passes

## Deferred Work

1. automatic execution of plan-review or landing actions from code
2. additional operator sub-skills once the control-state seam is proven
3. broader operator-loop productization beyond this checkpoint surface
4. tracker or orchestrator lifecycle changes unrelated to operator prompt scope

## Revision Log

- 2026-04-08: Initial plan created for issue `#300` and prepared for the
  `plan-ready` handoff.
