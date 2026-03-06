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

1. the local Symphony spec checkout, if available locally, for example the sibling `../symphony/` checkout
2. the Elixir reference implementation, if available locally, for example under `../symphony/elixir/`
3. the Harness engineering principles in `docs/golden-principles.md`

## Planning Standard

Every substantial implementation plan should cover:

1. goal
2. scope
3. non-goals
4. current gaps
5. architecture boundaries
6. runtime state model or state machine, if behavior is stateful
7. failure-class matrix, if recovery or retries are involved
8. storage or persistence contract, if durable state is involved
9. observability requirements
10. implementation steps
11. tests and named acceptance scenarios
12. exit criteria
13. decision notes when a boundary or tradeoff needs explicit rationale

Do not stop at generic implementation bullets if the feature changes orchestration behavior.

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

Do not let run sequence, retry budget, waiting state, and recovery state blur together.

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

## Review-Churn Trigger

If you find yourself planning a change that would patch a large existing file in several unrelated places, stop and reconsider the decomposition.

If likely review comments would cluster around:

- nullability and boundary parsing
- stale state handling
- mixed transport/policy logic
- hidden counters or budgets
- test harness cleanup

then the plan should include a small structural refactor up front rather than deferring it to code review.

## Plan Output

Write the plan to:

- `docs/plans/<issue-number>-<task-name>/plan.md`

Use a stable, descriptive directory name.

After writing the plan:

1. sanity-check that it matches the issue
2. sanity-check that boundaries are explicit
3. comment on the issue that the plan is ready

If implementation is explicitly allowed to continue without waiting, continue from the plan.
