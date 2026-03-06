---
name: symphony-operator
description: Operate and maintain the local Symphony factory in this repository. Use this skill when monitoring the live factory, repairing stalled runs, handling PR review and CI follow-up, or improving the operator loop itself.
---

# Symphony Operator

Use this skill when acting as the operator for the local Symphony factory.

## Scope

- Observe the live factory, not just the repository.
- Repair broken or stalled execution.
- Drive PRs through CI and automated review to a mergeable state.
- Keep GitHub as a thin queue and rely on Symphony's own polling and concurrency.

## Wake-Up Workflow

1. Inspect the current repo state, open ready/running issues, open PRs, CI, and review comments.
2. Check the live Symphony worker process and determine whether it is healthy, progressing, stuck, crashed, or misconfigured.
3. If the factory is unhealthy, fix the concrete problem and restart it.
4. If a PR has actionable CI or review feedback, fix it on the PR branch, rerun local QA, push, and continue watching.
5. Only seed or relabel the next issue when the queue is empty or the factory would otherwise be idle.

## Operational Rules

- Do not act as a second scheduler.
- Keep concurrency conservative.
- Treat `symphony:running` with no live worker or no live agent child as an orphaned run and repair it.
- Prefer detached worker sessions that survive outside the current interactive shell.
- Use an isolated checkout when fixing PR branches so local operator-only modifications do not leak into tracked work.

## Factory Fix Rule

If you change tracked repository files to fix the factory:

1. do the work on a branch,
2. open or update a PR,
3. run `/review`,
4. run local QA,
5. get the fix merged to `main`,
6. and restart the factory from the latest `main`.

Do not leave local-only tracked fixes sitting outside the normal PR flow. Workers should run from merged code whenever possible.

## Review Rule

- Do not merge while required CI is red or while actionable review comments remain.
- Greptile and Bugbot comments count as review feedback.
- Low-severity cleanup comments can be answered instead of fixed only when the tradeoff is explicit and defensible.

## Learned Heuristics

- Detached `screen` sessions have been more reliable for unattended local operation than short-lived interactive exec sessions.
- A closed issue plus an open PR usually means the factory reached the PR stage; inspect the PR before restarting anything.
- If the factory has no `symphony:ready` issues, idle is healthy.

## End-of-Cycle Check

Before finishing each wake-up:

1. ask whether this cycle revealed something missing or ambiguous in this skill or the operator prompt,
2. if yes, make the improvement through the normal PR flow when it affects tracked files,
3. and record the result in the final status summary.
