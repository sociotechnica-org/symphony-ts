# AGENTS.md

This repository is the TypeScript implementation of the Symphony spec.

Symphony is a long-running orchestrator that:

1. reads work from a tracker,
2. creates isolated workspaces,
3. runs coding agents,
4. and drives work to a defined handoff state.

## Project Status

This repo is in active construction.

The implementation roadmap lives in:

- `docs/plans/035-bootstrap-factory/plan.md`
- `docs/plans/036-core-runtime-contracts/plan.md`

Current priorities:

1. Phase 0: bootstrap local end-to-end loop on GitHub
2. Phase 1: refactor into stable runtime contracts
3. Phase 2: make Beads the primary tracker backend

## Repository Map

Planned top-level structure:

```text
bin/            CLI entry point
docs/           architecture, principles, plans
skills/         repo-local skills for operators and agents
src/config/     WORKFLOW.md loading, parsing, config resolution
src/observability/  structured logs and operation spans
src/orchestrator/   poll loop, runtime state, retries, reconciliation
src/runner/     agent runner interfaces and implementations
src/tracker/    tracker interfaces and adapters
src/workspace/  workspace lifecycle and hooks
```

## Design Intent

- Keep the runtime close to the Symphony spec.
- Keep tracker-specific logic at the edges.
- Keep Beads as the primary long-term tracker target.
- Keep Context Library as a hook-based integration.
- Keep remote execution out of the critical path until local execution is solid.

## Working Rules

- Prefer small files and explicit interfaces.
- Parse external inputs at the boundary.
- Normalize external payloads into stable internal snapshots before policy or orchestration logic runs.
- Separate transport, normalization, and policy instead of mixing them in one adapter file.
- Use structured logging.
- Keep repo-local operational skills in `skills/` when the behavior should be reused and reviewed.
- Treat `WORKFLOW.md` as a repository-owned runtime contract.
- Make the happy path real early; do not fake end-to-end behavior.
- Preserve a clean separation between workflow/config, tracker, workspace, runner, orchestrator, and observability.
- Keep tracker-specific lifecycle policy at the edge; the orchestrator should consume normalized handoff state rather than compensate for GitHub-specific quirks.
- If orchestration depends on multiple counters, flags, or maps, extract a named runtime-state module with explicit transitions.
- Do not overload one counter for prompt sequencing, retry budgeting, and follow-up budgeting.
- Keep coordination infrastructure such as leases, lock recovery, and temp cleanup in focused modules rather than inline branches.
- Prefer test builders and helpers over repeated ad hoc setup for snapshots, fixtures, temp roots, and cleanup.

## Skills Policy

`WORKFLOW.md`, `AGENTS.md`, and in-repo skills serve different roles.

- `WORKFLOW.md` is the repository runtime contract. It should define the required worker process and completion behavior.
- `AGENTS.md` is the repository engineering policy. It should define enduring design, testing, review, and architecture expectations.
- skills are specialized guides for recurring kinds of work. They may add detailed method, but they should not be the only place where required correctness rules live.

Use this rule of thumb:

- if behavior is required for every worker run, put it in `WORKFLOW.md` or `AGENTS.md`
- if guidance is specialized to a type of task, put it in a skill
- if behavior is part of runtime correctness, put it in code and tests, not only in prompts

For this repo, skills should stay small in number and high in leverage. Prefer checked-in skills that help Symphony build Symphony without making the repository depend on hidden prompt state.

## Issue Workflow

For any GitHub issue assigned for implementation:

1. Create a technical plan in `docs/plans/<issue-number>-<phase-or-task-name>/plan.md`.
2. Use the issue number in the directory name. For now this should match the GitHub issue number.
3. Discuss and refine the plan as needed.
4. Once the plan is ready, post on the GitHub issue that the plan is ready for review.
5. If explicitly instructed not to wait for human feedback, continue directly from the approved plan into implementation.

Plans are part of the system of record. Do not implement substantial work without first creating or updating the plan.

## Scope Changes

If material scope changes are discovered during implementation:

1. update the relevant plan document,
2. comment on the GitHub issue with the change,
3. then continue implementation from the updated plan.

Do not allow implementation to drift away from the written plan silently.

## Implementation Standard

Implemented code must be testable by the agent end-to-end.

That means:

1. the code must type check,
2. the code must lint cleanly,
3. the code must be formatted,
4. unit tests must pass,
5. integration tests must pass,
6. and full end-to-end tests must pass in a way that reflects real user operation.

Do not stop at unit tests if the feature can be exercised as a real workflow.

## External Integration Testing

External integrations must be testable in CI without depending on the real external systems.

Required approach:

1. provide full-fledged mocks or simulators for external systems,
2. make end-to-end tests interact with those mocks as though they were the real systems,
3. verify the actual orchestration flow, not just isolated helper functions.

The target is CI that gives high confidence the feature actually works in practice.

CI end-to-end tests should not depend on real external network calls unless a specific workflow explicitly requires that and it has been approved.

## Pull Requests

Every PR should:

1. reference one primary issue,
2. stay as small as practical while still completing the assigned work,
3. and remain traceable back to the plan and issue discussion.

Prefer smaller reviewable slices over oversized PRs when the work can be split without losing end-to-end integrity.

For orchestration-heavy work, prefer splitting large changes into smaller PRs along stable architectural seams rather than combining tracker policy, orchestrator state, runner behavior, test harness changes, and docs into one review surface. Each PR should either complete one usable vertical slice or land inert, well-tested plumbing that reduces risk for the next slice.

## Related Bugs

If related bugs or correctness issues are discovered while implementing the assigned work, fix them immediately as part of the current effort rather than deferring them by default.

If the additional fixes materially expand scope, update the plan and issue before continuing.

## Completion Workflow

Implementation work is not complete when the code compiles locally. It is complete only when the full delivery loop is finished:

1. plan exists,
2. implementation is complete,
3. `codex review --base origin/main` has been run and all self-review findings have been fixed,
4. formatting, lint, typecheck, and all tests are passing,
5. a PR is created,
6. PR CI is watched until it passes,
7. review comments are addressed,
8. review feedback from Greptile is specifically addressed,
9. and the PR is left in a clean, passing state.

Do not treat "PR opened" as done.
Unless explicitly instructed otherwise, do not stop at "ready to merge". The default expectation is to carry the task through a green, fully addressed PR state.

## Review Loop

After opening a PR:

1. monitor CI until all required checks pass,
2. monitor reviews and automated review comments,
3. address review feedback,
4. push follow-up fixes,
5. and repeat until the PR is clear.

Greptile review feedback is part of the required review loop and must be explicitly handled.

## Execution Bias

In general, keep working through the task until the full delivery loop is finished.

Do not stop early because of a minor obstacle, partial success, or an intermediate milestone if the next required step is clear and feasible.

## Build Standard

Before considering work complete:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`

Where applicable, also run:

4. formatter checks or formatting commands used by the repo
5. integration test suites
6. end-to-end test suites

For Phase 0 and major orchestration changes, also validate the end-to-end loop manually or through a realistic automated harness when available.
