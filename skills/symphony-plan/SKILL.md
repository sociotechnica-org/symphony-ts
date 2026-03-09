---
name: symphony-plan
description: Create or refine implementation plans for Symphony issues in a way that stays close to the Symphony spec, preserves clean architectural layers, and reduces review churn.
---

# Symphony Plan

Use this skill before substantial implementation work on a Symphony issue.

The goal is not just to write a task list. The goal is to produce a plan that:

- stays aligned with the Symphony spec,
- preserves the intended layers of the system,
- makes failure and recovery behavior explicit,
- narrows the work to one reviewable slice where possible,
- and reduces the chance of patch-on-patch review churn later.

## Sources Of Truth

Read only what is needed, but do not plan blind.

Required sources:

1. `AGENTS.md`
2. `README.md`
3. relevant files under `docs/`
4. the existing implementation around the affected layers
5. the issue text and comments

When relevant to the issue, also consult:

1. `SPEC.md` from a local Symphony checkout, if available locally, for example the sibling `../symphony/` checkout
2. the matching abstraction-level summary in `docs/architecture.md` when `SPEC.md` is not locally available
3. the upstream `openai/symphony` `SPEC.md` only when network access is available and more detail is needed
4. the Elixir reference implementation, local or upstream, when the issue is about decomposition or runtime seams
5. the Harness engineering principles in `docs/golden-principles.md`

## Planning Standard

Every substantial implementation plan should cover:

1. goal
2. scope
3. non-goals
4. spec alignment by abstraction level
5. current gaps
6. architecture boundaries
7. slice strategy and PR seam
8. runtime state model or runtime state machine, if behavior is stateful
9. failure-class matrix, if recovery or retries are involved
10. storage or persistence contract, if durable state is involved
11. observability requirements
12. implementation steps
13. tests and named acceptance scenarios
14. exit criteria
15. what is deferred to later issues or PRs
16. decision notes when a boundary or tradeoff needs explicit rationale

Do not stop at generic implementation bullets if the feature changes orchestration behavior.
If the plan cannot explain why the work fits in one reviewable PR, the plan is not ready yet.

## Spec Alignment

Plans should explicitly map the work to the Symphony abstraction levels from `SPEC.md`.

Spell out what belongs in each touched layer and what does not:

- Policy Layer
- Configuration Layer
- Coordination Layer
- Execution Layer
- Integration Layer
- Observability Layer

If a layer is intentionally untouched, say so when it keeps the seam clearer.

## Layering Rules

Plans must preserve the intended system boundaries.

Spell out what belongs in each layer:

- config/workflow
- tracker
- workspace
- runner
- orchestrator
- observability

Also spell out what does not belong in a layer.

Examples:

- tracker-specific API quirks should not leak into orchestrator policy
- transport, normalization, and policy should not be mixed in one module
- leases and lock recovery should not live inline inside large coordinator branches
- runtime state should not be represented as a few loose maps if the behavior is stateful enough to deserve explicit transitions
- workflow/config changes should not be hidden inside tracker or runner edits
- status surface work should not force unrelated tracker or orchestrator refactors unless the seam truly requires it

## Slice Decomposition

Default to one issue / one PR with one narrow review surface.

Make the intended seam explicit:

1. what lands in the current PR
2. what is deliberately deferred
3. why the seam is reviewable on its own

Use the Elixir reference as a reminder that supervision, status surface, workflow config, and tracker integration are separable components.

If the work would otherwise mix several of those components in one patch, narrow the current issue to the first usable slice before implementation.

## Harness-Oriented Principles

Use the same principles that make agent-built systems easier to maintain:

1. keep the system of record inside the repo
2. prefer explicit contracts over implicit behavior
3. make the happy path real, not simulated
4. keep code and plans legible to future agents
5. avoid cleverness that hides state or ownership
6. choose small modules with obvious ownership

If the plan would produce a large hot file with transport, policy, and state transitions mixed together, the plan is not ready yet.

## State And Recovery Planning

If the issue changes long-running orchestration, retries, review loops, ownership, or recovery:

1. name the states explicitly
2. name the allowed transitions
3. distinguish counters that mean different things
4. define which states are healthy waiting vs broken/orphaned
5. define what facts the system uses to decide between wait, rerun, fail, or complete

Do not let run sequence, retry budget, follow-up budget, waiting state, and recovery state blur together.

If the behavior depends on several counters, flags, or maps, the plan should call for a named runtime-state module with explicit transitions.

## Failure-Class Matrix

For features involving recovery, reconciliation, subprocesses, trackers, or CI/review loops, include a small matrix of:

- observed condition
- local facts available
- normalized tracker facts available
- expected decision

Examples:

- local process dead, no PR
- local process dead, PR awaiting review
- tracker says running, no local state
- stale lease with live process
- stale lease with dead process

This is one of the best ways to avoid repetitive review comments later.

## Tests And Acceptance Scenarios

Do not just say "add tests."

Name the exact scenarios that prove the feature works.

For orchestration changes, plans should usually include:

- unit coverage for pure policy/state transitions
- integration coverage for adapter/runtime interaction
- end-to-end coverage for the real user-visible failure mode

Name the end-to-end scenarios explicitly.

For planning/process issues, add lightweight contract tests when the checked-in guidance itself is the primary deliverable.

## Phase 1.2 Review-Churn Lessons

Encode these lessons directly in the plan instead of waiting for review comments:

1. separate tracker transport, normalization, and policy at the boundary
2. require explicit runtime state machines for retries, continuations, reconciliation, and handoff states
3. avoid broad PRs that combine tracker seams, orchestrator state, workflow prompts, and harness cleanup without a named slice strategy
4. prefer shared test builders/helpers when the same fixtures or temp-root setup repeat across multiple tests

## Review-Churn Trigger

If you find yourself planning a change that would patch a large existing file in several unrelated places, stop and reconsider the decomposition.

If likely review comments would cluster around:

- nullability and boundary parsing
- stale state handling
- mixed transport/policy logic
- hidden counters or budgets
- test harness cleanup

then the plan should include a small structural refactor up front rather than deferring it to code review.

If the first slice is still too broad after that refactor, the issue should be decomposed further before coding.

## Planning-Process First Slice

When the issue is about planning, workflow guidance, or prompt contracts, the first implementation slice should improve the checked-in planning process itself.

Do not turn that first slice into a generic planning product, planner service, or large automation framework.

## Human Review Station

Technical plans in this repo go through an explicit human review station before substantial implementation.

Use these process states:

1. `draft`
2. `plan-ready`
3. `in review`
4. `revise`
5. `approved`
6. `waived`

Required behavior:

1. when the plan meets the planning standard, post an issue comment that the plan is `plan-ready` for review
2. unless the issue or operator explicitly says not to wait, stop there and treat the plan as being `in review`
3. if human feedback requests changes, move to `revise`, update the plan, and post a fresh comment that summarizes the deltas before returning to `plan-ready`
4. a waiver can arrive from `draft`, `plan-ready`, or `in review`; treat all three as valid transitions to `waived`
5. begin substantial implementation only after the plan is explicitly `approved` or explicitly `waived`
6. if approval is waived, record that fact in the issue or PR notes so the handoff remains inspectable

Use these exact first-line markers for the human reply protocol:

- `Plan review: approved`
- `Plan review: changes-requested`
- `Plan review: waived`

The `plan-ready` issue comment should include:

- the exact first line `Plan status: plan-ready`
- the plan path
- a short summary
- a short note that the review reply must begin with one of the accepted markers
- copy-pasteable fenced markdown templates for `approved`, `changes-requested`, and `waived`

This review station is the first slice for plan-process issues because it preserves the workflow boundary and uses existing issue comments instead of inventing new runtime machinery.

## Plan Output

Write the plan to:

- `docs/plans/<issue-number>-<task-name>/plan.md`

Use a stable, descriptive directory name.

After writing the plan:

1. sanity-check that it matches the issue
2. sanity-check that spec alignment, non-goals, boundaries, slice strategy, acceptance scenarios, and deferred work are explicit
3. comment on the issue that the plan is `plan-ready`
4. follow the Human Review Station above: unless plan approval is explicitly waived, stop at `plan-ready`, treat the plan as `in review`, and wait for human review before substantial implementation
5. if review feedback arrives, revise the plan, summarize the changes in a fresh issue comment, and return to `plan-ready`
6. once the plan is explicitly `approved`, or plan approval is explicitly `waived`, begin substantial implementation; if approval is waived, record that waiver in the issue or PR notes so the handoff remains inspectable

Use this exact reply-template block in the `plan-ready` comment:

````md
```md
Plan review: approved

Summary

- Approved to implement.
```

```md
Plan review: changes-requested

Summary

- One-sentence decision.

What is good

- ...

Required changes

- ...

Architecture / spec concerns

- ...

Slice / PR size concerns

- ...

Approval condition

- Approve after ...
```

```md
Plan review: waived

Summary

- Plan review is waived; proceed to implementation.
```
````

Current enforcement is guidance and process expectation; orchestrator-level pause support is deferred.
