# Phase 1.3.2 Technical Plan: Strengthen Spec-Aligned Planning And Slice Decomposition

## Goal

Strengthen Symphony's repo-owned planning guidance so future issue plans stay explicitly aligned with `SPEC.md`, decompose work along architectural seams, and avoid another oversized mixed-surface PR like Phase 1.2 / PR `#23`.

This slice improves the planning process itself first. It does not attempt to build a generic planning product or change the runtime's orchestration behavior directly.

## Scope

Required outcomes for issue `#30`:

1. strengthen `skills/symphony-plan/SKILL.md` so plans must call out spec alignment, architectural seams, non-goals, slice strategy, acceptance scenarios, and deferred work
2. tighten `WORKFLOW.md` so worker prompts require narrow plan-first decomposition before substantial implementation
3. update repo engineering guidance so one issue / one PR with small review surfaces becomes the default expectation, especially for orchestration-heavy work
4. encode Phase 1.2 / PR `#23` review-churn lessons around tracker boundaries, explicit runtime state modules, and separable components
5. add lightweight regression coverage for the checked-in planning contract where practical

## Non-Goals

This issue does not include:

1. adding a new runtime planning subsystem, planner service, or CLI feature
2. changing the orchestration loop, tracker adapter behavior, or workspace/runner contracts
3. rewriting historical plans to the new standard beyond this issue's own plan
4. inventing a reusable multi-repo planning framework outside `symphony-ts`
5. broadening the current issue into general documentation cleanup unrelated to planning quality

## Current Gaps

Today the repository points agents toward planning, but the durable guidance is still too easy to satisfy with a broad checklist:

1. `skills/symphony-plan/SKILL.md` asks for boundaries and state models, but it does not yet require explicit mapping to the Symphony abstraction levels from `SPEC.md`
2. the current planning skill warns against mixed transport/policy logic, but it does not strongly force issue decomposition or a named one-issue/one-PR seam
3. `WORKFLOW.md` tells the worker to create a plan before substantial changes, but it does not state the minimum planning contents that must appear in that plan
4. `AGENTS.md` already prefers smaller PRs, but the rule is not yet concrete enough to stop review surfaces from expanding across tracker, orchestrator, workflow, and test harness layers in one change
5. Phase 1.2 / PR `#23` showed that the costly review churn clusters around missing seams: tracker transport vs normalization vs policy, implicit orchestration state, and hot files patched in several unrelated places at once

## Spec Alignment By Abstraction Level

This issue changes guidance, not runtime behavior, but the guidance must explicitly steer future plans across the Symphony layers in `SPEC.md`.

### Policy Layer

Belongs here:

- repo-owned planning instructions in `WORKFLOW.md`
- the reusable planning method in `skills/symphony-plan/SKILL.md`
- issue-plan requirements for non-goals, acceptance scenarios, and handoff/deferred work

Does not belong here:

- concrete orchestrator state transitions
- tracker transport details

### Configuration Layer

Belongs here:

- guidance that future plans must distinguish workflow/config changes from policy changes
- wording that keeps `WORKFLOW.md` as the runtime contract rather than an ad hoc checklist

Does not belong here:

- tracker lifecycle policy
- runner or workspace behavior

### Coordination Layer

Belongs here:

- planning requirements for explicit runtime state machines when behavior depends on retries, continuations, reconciliation, or handoff states
- guidance to extract named runtime-state modules instead of overloading counters or maps

Does not belong here:

- tracker API normalization
- prompt wording details that belong to repo policy

### Execution Layer

Belongs here:

- planning guidance that keeps workspace and runner changes decomposed from tracker and orchestration policy where possible

Does not belong here:

- tracker-specific failure handling
- observability rendering decisions

### Integration Layer

Belongs here:

- explicit requirement to separate tracker transport, normalization, and policy
- reminders that tracker-specific quirks must stay at the edge

Does not belong here:

- orchestrator compensation for backend-specific payload quirks

### Observability Layer

Belongs here:

- durable repo guidance that makes planning expectations inspectable and reviewable
- lightweight regression tests that lock the checked-in planning contract

Does not belong here:

- using logs or status output as the only source of planning requirements

## Architecture Boundaries

### `skills/symphony-plan/SKILL.md`

Belongs here:

- the specialized planning method
- required plan sections
- decomposition heuristics
- review-churn triggers and guardrails

Does not belong here:

- repository-wide correctness rules that every worker run must follow regardless of task type

### `WORKFLOW.md`

Belongs here:

- the minimum planning obligations that every implementation run must follow before substantial code changes
- the requirement to narrow work to a reviewable slice when the issue can be decomposed

Does not belong here:

- long-form planning rationale that is better maintained in the skill

### `AGENTS.md`

Belongs here:

- enduring engineering policy for issue plans, PR seams, and architectural boundaries
- repo-wide lessons from review churn that should outlive one issue

Does not belong here:

- specialized plan-writing walkthroughs that belong in the skill

### Tests

Belongs here:

- lightweight assertions that the checked-in planning contract still mentions the mandatory rules

Does not belong here:

- deep semantic validation of every future plan document

## Slice Strategy

This issue should land as one narrow PR because the deliverable is the planning contract itself.

Primary seam:

1. system-of-record planning guidance (`skills/symphony-plan/SKILL.md`, `WORKFLOW.md`, `AGENTS.md`)
2. lightweight regression coverage proving the guidance remains checked in and inspectable

Deliberately deferred to later issues:

1. new tooling that lint-checks arbitrary plan documents
2. automatic issue splitting or PR sizing heuristics in the runtime
3. broader documentation refactors outside the planning path

## Failure-Class Matrix

| Observed condition                                                                                        | Local facts available                                                            | Expected planning guidance decision                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Plan describes orchestration changes but no named runtime state machine                                   | issue scope mentions retries, continuation, reconciliation, or handoff           | block the plan from being considered ready until explicit states and transitions are written |
| Plan touches tracker behavior in one module without separating transport, normalization, and policy       | proposed file list or implementation notes collapse those concerns               | require a narrower seam or a structural refactor slice first                                 |
| Proposed work spans tracker, orchestrator, workflow, and test harness changes in one PR                   | slice strategy is missing or says "single broad implementation"                  | decompose into one reviewable slice and defer the rest to named follow-up issues             |
| Plan omits non-goals or deferred work                                                                     | scope sounds open-ended and reviewers cannot tell what is intentionally excluded | add named non-goals and explicit deferrals before implementation                             |
| Planning issue starts building a general planning feature instead of strengthening the checked-in process | implementation ideas introduce new runtime products or generic frameworks        | narrow the first slice back to the planning skill/process itself                             |

## Observability Requirements

1. the planning contract must live in checked-in files that future agents read by default
2. the new rules must be visible in both the specialized planning skill and the repo-wide worker guidance
3. regression coverage should fail if the required planning directives disappear from those checked-in contracts

## Implementation Steps

1. create this issue plan and post the plan-ready comment on GitHub
2. strengthen `skills/symphony-plan/SKILL.md` with explicit spec-layer mapping, seam selection, non-goals, failure-class matrices, acceptance scenarios, deferred-work requirements, and Phase 1.2 review-churn lessons
3. update `WORKFLOW.md` so every implementation run is told what the plan must include and when to narrow the slice before coding
4. update `AGENTS.md` so repo-wide policy explicitly favors one issue / one PR with narrow seams and calls out tracker-boundary and runtime-state expectations
5. add a focused unit test that checks the checked-in planning contract still includes the required directives
6. run formatting, lint, typecheck, tests, and self-review before opening the PR

## Tests And Acceptance Scenarios

### Unit

1. a repository contract test verifies that `skills/symphony-plan/SKILL.md` includes the required spec-alignment and decomposition directives
2. a repository contract test verifies that `WORKFLOW.md` includes the stronger plan-first instructions for non-goals, boundaries, slice strategy, and runtime-state requirements
3. a repository contract test verifies that `AGENTS.md` encodes the enduring narrow-PR and boundary rules

### Acceptance Scenarios

1. when a future agent reads the planning skill for an orchestration issue, it is explicitly told to map changes across `SPEC.md` abstraction levels and to require a runtime state machine when retries or reconciliation are involved
2. when a future agent reads `WORKFLOW.md`, it is told to narrow oversized work into a smaller slice before substantial implementation rather than silently proceeding with a mixed-surface patch
3. when a reviewer reads `AGENTS.md`, the repo policy clearly steers the work toward one issue / one PR and away from combining tracker transport, normalization, policy, orchestration state, and harness changes without a justified seam

## Exit Criteria

This issue is complete when:

1. the issue plan exists and reflects the new planning standard
2. `skills/symphony-plan/SKILL.md` explicitly requires spec-layer mapping, non-goals, slice strategy, failure-class matrices, acceptance scenarios, and named deferrals
3. `WORKFLOW.md` and `AGENTS.md` both steer work toward narrow, reviewable PR seams and call out the critical Phase 1.2 architectural lessons
4. regression coverage exists for the checked-in planning contract
5. the resulting PR is small, reviewable, and limited to the planning/process slice itself

## Decision Notes

1. Put the strongest plan-writing method in `skills/symphony-plan/SKILL.md`, but duplicate the minimum mandatory rules in `WORKFLOW.md` and `AGENTS.md` so correctness does not depend on one specialized file being remembered.
2. Treat planning quality as a checked-in contract worth testing, because this issue's primary deliverable is repository guidance rather than runtime code.
3. Keep the first implementation slice constrained to planning/process improvements. If future work wants more automation around plans, that should be a later issue after the tighter contract is already in place.
