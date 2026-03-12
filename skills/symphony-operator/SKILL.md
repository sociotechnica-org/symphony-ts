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
- Handle `plan-ready` issues: review plans, request changes when needed, and approve when ready.
- Keep GitHub as a thin queue and rely on Symphony's own polling and concurrency.
- Maintain a persistent local operator notebook in `.ralph/operator-scratchpad.md`.

## Wake-Up Workflow

1. Read `.ralph/operator-scratchpad.md` first so the latest operator context survives session loss and compaction.
2. Inspect the current repo state, open ready/running issues, open PRs, CI, and review comments.
3. Check the live Symphony worker process and determine whether it is healthy, progressing, stuck, crashed, or misconfigured.
4. If the factory is unhealthy, fix the concrete problem and restart it.
5. If a PR has actionable CI or review feedback, fix it on the PR branch, rerun local QA, push, and continue watching.
6. If an active issue is waiting in `plan-ready`, review the plan and post an explicit review decision comment:
   - `Plan review: approved`
   - `Plan review: changes-requested`
   - `Plan review: waived` (record why in the comment)
7. After posting a review decision, verify the factory acknowledges it and transitions correctly.
8. Only seed or relabel the next issue when the queue is empty or the factory would otherwise be idle.

## Operational Rules

- Do not act as a second scheduler.
- Keep concurrency conservative.
- Treat `symphony:running` with no live worker or no live agent child as an orphaned run and repair it.
- Prefer detached worker sessions that survive outside the current interactive shell.
- Use an isolated checkout when fixing PR branches so local operator-only modifications do not leak into tracked work.
- The factory owns PR follow-up by default. If a fresh actionable review batch lands and the factory does not pick it up, debug the miss as a factory/runtime problem before taking over the branch manually.
- Do not silently replace the worker on an active PR just because the next fix is obvious. Operator PR intervention is for stalled or broken factory behavior, not the normal path.
- Treat plan review as a required operator checkpoint:
  - if the plan is sound, post `Plan review: approved`,
  - if revisions are needed, post `Plan review: changes-requested` with concrete guidance,
  - if explicitly bypassing review, post `Plan review: waived` and record why.

## Factory Fix Rule

If you change tracked repository files to fix the factory:

1. do the work on a branch,
2. run local QA,
3. run `/review` and fix all self-review findings,
4. open or update a PR,
5. get the fix merged to `main`,
6. and restart the factory from the latest `main`.

Do not leave local-only tracked fixes sitting outside the normal PR flow. Workers should run from merged code whenever possible.

## Review Rule

- Do not merge while required CI is red or while actionable review comments remain.
- Greptile and Bugbot comments count as review feedback.
- Do not treat "all threads resolved" as sufficient by itself. Before merging, also check for top-level bot review comments or review summaries that still contain unaddressed actionable feedback.
- Low-severity cleanup comments can be answered instead of fixed only when the tradeoff is explicit and defensible.

## Learned Heuristics

- Detached `screen` sessions have been more reliable for unattended local operation than short-lived interactive exec sessions.
- A closed issue plus an open PR usually means the factory reached the PR stage; inspect the PR before restarting anything.
- If the factory has no `symphony:ready` issues, idle is healthy.

## End-of-Cycle Check

Before finishing each wake-up:

1. update `.ralph/operator-scratchpad.md` with current state, open risks, and the next operator checks,
2. ask whether this cycle revealed something missing or ambiguous in this skill or the operator prompt,
3. distinguish between:
   - durable process rules or generally correct operator behavior, which belong in this skill or the operator prompt,
   - transient factory facts, temporary workarounds, and run-specific context, which belong in `.ralph/operator-scratchpad.md`,
4. if a durable rule needs to change, make the improvement through the normal PR flow,
5. and record the result in the final status summary.
