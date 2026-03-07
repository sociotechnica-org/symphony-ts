# Phase 1.3.1 Technical Plan: Human Review Station For Technical Plans

## Goal

Create an explicit, repo-owned human review station for technical plans before implementation begins.

For issue `#29`, that means the checked-in workflow contract must distinguish:

1. plan drafting
2. plan-ready handoff for human review
3. iterative revision from human feedback
4. explicit approval or explicit waiver
5. implementation start only after approval or waiver

This slice stays in policy/workflow guidance. It does not add a tracker-specific subsystem, dashboard, or orchestrator feature.

## Scope

Required outcomes for issue `#29`:

1. define the plan flow as `draft -> plan-ready -> in review -> revise -> approved`
2. document how an agent posts a plan-ready handoff comment and waits unless plan approval is explicitly waived
3. document how an agent revises the plan from human feedback, posts a new review-ready comment, and repeats until approval
4. make the approval gate explicit in repo-owned guidance files that future workers already read
5. add lightweight contract tests that keep the human review station visible and enforceable in repository process terms

## Non-Goals

This issue does not include:

1. adding new orchestrator runtime state, tracker labels, or GitHub-specific automation for plan approval
2. building a UI, dashboard, or custom review service
3. requiring historical issues or plans to be retrofitted beyond this issue's own plan
4. turning plan review into a terminal success state rather than a pre-implementation handoff
5. broad documentation cleanup unrelated to the plan-review station

## Current Gaps

Today the repo requires a plan before substantial implementation, but the human review station is still implicit:

1. `WORKFLOW.md` tells the worker to create a plan and comment when it is ready, but it does not clearly define approval as a blocking handoff before implementation unless waived
2. `AGENTS.md` defines an issue workflow for planning, but it does not explicitly document the iterative review loop of draft, human feedback, revision, and approval
3. `skills/symphony-plan/SKILL.md` explains how to write a strong plan, but it does not yet tell the agent how to handle human review feedback and re-review cycles as a first-class process
4. `README.md` describes the implementation loop, but it does not clearly explain the pre-implementation human plan review station for operators
5. the current planning contract tests verify spec alignment and decomposition rules, but they do not yet lock in plan approval, waiver, and iterative revision expectations

## Spec Alignment By Abstraction Level

This issue works entirely in repo-owned process guidance and keeps the runtime core unchanged.

### Policy Layer

Belongs here:

- defining the required plan handoff flow in `WORKFLOW.md`
- documenting approval, waiver, and revision expectations in `AGENTS.md`
- extending `skills/symphony-plan/SKILL.md` with review-loop instructions
- updating `README.md` so operators can follow the expected process

Does not belong here:

- tracker-specific issue state automation
- orchestrator runtime transitions

### Configuration Layer

Belongs here:

- keeping `WORKFLOW.md` as the repository-owned runtime contract that tells workers when implementation is blocked or allowed

Does not belong here:

- new config schema or front-matter fields for plan approval

### Coordination Layer

Belongs here:

- a documented repo-process state model for the plan handoff

Does not belong here:

- changes to `src/orchestrator/` or durable runtime ownership state

### Execution Layer

Belongs here:

- clear worker instructions about when coding may begin after the plan loop

Does not belong here:

- workspace or runner behavior changes

### Integration Layer

Belongs here:

- issue-comment based review handoff as a documented first slice because it uses the existing tracker surface without adding adapter logic

Does not belong here:

- tracker hardcoding for plan approval states

### Observability Layer

Belongs here:

- checked-in documentation and tests that make the review station inspectable in repo terms

Does not belong here:

- status-surface or logging changes

## Architecture Boundaries

### `WORKFLOW.md`

Belongs here:

- mandatory worker behavior before substantial implementation
- the approval gate: implementation is blocked until a human approves the plan or explicitly waives waiting
- the required iterative loop when human feedback requests revisions

Does not belong here:

- long-form rationale for why the plan should be written a certain way

### `AGENTS.md`

Belongs here:

- durable repo policy for plan review, revision, approval, and waiver
- explicit separation between planning work and implementation work

Does not belong here:

- task-specific prompt phrasing that belongs in the workflow contract

### `skills/symphony-plan/SKILL.md`

Belongs here:

- the method for turning issue scope and human comments into a revised plan
- guidance for summarizing plan deltas when posting a re-review comment
- a reminder to keep the first slice in policy/workflow files for plan-process issues

Does not belong here:

- repo-wide mandatory rules that are not specific to planning work

### `README.md`

Belongs here:

- operator-facing explanation of the plan review station in the self-hosting loop

Does not belong here:

- detailed plan-writing heuristics

### Tests

Belongs here:

- lightweight contract checks that the checked-in files still mention plan-ready, review, revise, approved, and waiver behavior

Does not belong here:

- runtime tests for tracker or orchestrator behavior that this issue intentionally does not change

## Slice Strategy And PR Seam

This issue should land as one narrow PR because the deliverable is a repository process contract.

Primary seam:

1. plan-first workflow guidance in `WORKFLOW.md`, `AGENTS.md`, `README.md`, and `skills/symphony-plan/SKILL.md`
2. lightweight planning-contract regression coverage

Why this fits one reviewable PR:

1. it changes one coherent concern: pre-implementation human review of plans
2. it stays out of tracker, orchestrator, runner, and workspace runtime code
3. it proves the behavior through checked-in documentation and tests rather than a broad feature build

## Plan Review State Model

This issue changes process state, not runtime orchestration state, but the handoff still needs explicit transitions.

States:

1. `draft`: the issue plan exists but has not yet been handed off for human review
2. `plan-ready`: the plan satisfies the repo planning standard and the issue has a comment asking for human review
3. `in-review`: the agent is waiting for human approval or requested changes
4. `revise`: human feedback requires updates to the plan before implementation
5. `approved`: a human explicitly approves the plan
6. `waived`: the issue or operator explicitly says not to wait for approval
7. `implementing`: code changes begin after `approved` or `waived`

Allowed transitions:

1. `draft -> plan-ready`
2. `plan-ready -> in-review`
3. `in-review -> revise`
4. `revise -> plan-ready`
5. `in-review -> approved`
6. `draft -> waived`
7. `plan-ready -> waived`
8. `approved -> implementing`
9. `waived -> implementing`

Invalid transitions to block in guidance:

1. `draft -> implementing` without explicit waiver
2. `plan-ready -> implementing` without explicit approval or waiver
3. `revise -> implementing` without a fresh review-ready handoff

## Failure-Class Matrix

| Observed condition                                                           | Local facts available                                 | Expected process decision                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Plan file exists but no issue comment says it is ready for review            | plan path exists, no review handoff has been posted   | do not start implementation; post the plan-ready review handoff first                      |
| Human feedback asks for plan changes                                         | issue comments request revisions                      | update the plan, summarize the changes, and return to `plan-ready` for another review pass |
| No approval comment exists and no waiver instruction exists                  | plan is ready but approval state is absent            | remain blocked in the review station and do not implement                                  |
| Operator or issue instructions explicitly say not to wait for human feedback | explicit waiver exists in issue or operator prompt    | record the waiver in the process comment or final notes and continue to implementation     |
| Human approves the plan                                                      | issue comments contain explicit approval              | implementation may begin from the approved plan                                            |
| Plan-process issue starts proposing runtime tracker automation               | proposed changes reach into tracker/orchestrator code | narrow the slice back to repo-owned workflow guidance and tests                            |

## Observability Requirements

1. the plan review station must be visible in the checked-in workflow contract, repo policy, planning skill, and operator docs
2. the guidance must use stable process terms such as `plan-ready`, `review`, `revise`, `approved`, and `waived`
3. contract tests must fail if the approval gate or revision loop disappears from those checked-in files

## Implementation Steps

1. create this issue plan and post a plan-ready comment on GitHub
2. update `WORKFLOW.md` to define the blocking approval gate, waiver path, and iterative revision loop
3. update `AGENTS.md` so the issue workflow clearly distinguishes plan writing, review, revision, approval, and implementation start
4. update `skills/symphony-plan/SKILL.md` with explicit instructions for responding to human plan feedback and posting revised plan handoffs
5. update `README.md` so the operator-facing loop describes plan review before implementation
6. extend `tests/unit/planning-contract.test.ts` to lock in the new review-station rules
7. run formatting, lint, typecheck, tests, and self-review before opening the PR

## Tests And Acceptance Scenarios

### Unit

1. `tests/unit/planning-contract.test.ts` verifies that `WORKFLOW.md` requires approval or waiver before implementation and names the plan review loop
2. the same contract test verifies that `AGENTS.md` documents plan-ready, review, revise, approved, and waived behavior
3. the same contract test verifies that `skills/symphony-plan/SKILL.md` explains iterative revision from human feedback
4. the same contract test verifies that `README.md` exposes the human review station to operators

### Acceptance Scenarios

1. when a worker reads `WORKFLOW.md`, it is explicitly told to stop after posting the plan-ready handoff unless the issue or operator waived waiting
2. when a human requests changes on the issue, the worker updates `docs/plans/<issue-number>-<task-name>/plan.md`, posts a revised plan-ready summary, and waits again
3. when a human approves the plan, the worker can begin implementation without ambiguity
4. when the issue explicitly instructs the worker not to wait for human feedback, the worker can continue directly after the plan while still preserving the documented plan-review flow

## Exit Criteria

This issue is complete when:

1. this issue has a checked-in plan that defines the plan review station and approval gate
2. `WORKFLOW.md`, `AGENTS.md`, `skills/symphony-plan/SKILL.md`, and `README.md` all distinguish planning from implementation and document revision plus approval or waiver
3. the repo process clearly blocks implementation on plan approval unless waived
4. lightweight contract tests cover the documented review station
5. the resulting PR stays inside the policy/workflow layer and does not introduce runtime orchestration changes

## Deferred To Later Issues Or PRs

1. tracker-native plan approval states or labels
2. orchestrator support for pausing work on plan review as a runtime handoff state
3. dashboards or custom services for reviewing plans
4. automated linting of arbitrary plan documents beyond the checked-in contract tests

## Decision Notes

1. Treat plan approval as a repo-owned workflow handoff first, because that matches the spec boundary and keeps this slice out of tracker-specific orchestration logic.
2. Use issue comments as the first review surface because they already exist and satisfy the acceptance bar without inventing new infrastructure.
3. Test the checked-in guidance directly because the primary deliverable is process behavior encoded in repository contracts, not new runtime code.
