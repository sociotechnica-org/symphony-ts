---
name: symphony-operator
description: Operate and maintain the local Symphony factory in this repository. Use this skill when monitoring the live factory, repairing stalled runs, handling PR review and CI follow-up, or improving the operator loop itself.
---

# Symphony Operator

Use this skill when acting as the operator for the local Symphony factory.

Canonical procedure docs:

- `docs/guides/operator-runbook.md` for the normal detached runtime workflow
- `docs/guides/failure-drills.md` for repeatable recovery rehearsal and stability checks

Supported repo-owned entry point:

- `pnpm operator` for the continuous wake-up loop
- `pnpm operator:once` for one cycle

The checked-in loop and prompt live next to this skill under
`skills/symphony-operator/`. `.ralph/` is local/generated-only state for the
scratchpad, status snapshots, logs, and loop lock files.

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
3. Use `pnpm tsx bin/symphony.ts factory status --json` as the primary factory-health check and determine whether the detached runtime is healthy, degraded, stopped, stuck, crashed, or misconfigured.
4. Use bounded, one-shot probes during the wake-up cycle. Avoid long-running `watch`, follow, or sleep-heavy commands in the critical wake-up path; if extra inspection is needed, prefer short single reads and proceed from the latest successful control snapshot instead of waiting indefinitely for secondary surfaces.
5. Compare the supported live watch/TUI surface against `factory status --json` whenever practical, but only with bounded probes. Treat `factory status --json` as source of truth and treat meaningful TUI mismatches as bugs to fix or track.
6. Before moving on, explicitly check for operator-gated work that the factory cannot clear by itself:
   - any active issue waiting in `plan-ready` / `awaiting-human-handoff`
   - any PR or active issue waiting in `awaiting-landing-command`
7. If the factory is unhealthy, fix the concrete problem and restart it.
8. If a PR has actionable CI or review feedback, fix it on the PR branch, rerun local QA, push, and continue watching.
9. AGENTS.md and WORKFLOW.md treat checks that remain non-terminal for more than 30 minutes as blocked infrastructure by default. For operator wake-ups, use this narrower carve-out: if the same stuck-check behavior is locally reproducible, treat it as active operator-owned work instead of passive infrastructure waiting, and continue debugging until the PR is actually green or the remaining blocker is clearly external.
10. If an active issue is waiting in `plan-ready`, review the plan and post an explicit review decision comment:

- `Plan review: approved`
- `Plan review: changes-requested`
- `Plan review: waived` (record why in the comment)

11. If a PR is green, review-clean, and waiting in `awaiting-landing-command`, post `/land` on the PR as part of the wake-up cycle unless the user has explicitly told you not to land work automatically.
12. After posting a review decision or `/land`, verify the factory acknowledges it and transitions correctly.
13. When a `/land` completes and the PR actually merges, fast-forward the root checkout and `.tmp/factory-main` to the latest `origin/main`, then restart the detached factory so the next issue runs on merged code.
14. Only seed or relabel the next issue when the queue is empty or the factory would otherwise be idle.

## Operational Rules

- Do not act as a second scheduler.
- Keep concurrency conservative.
- Treat `docs/guides/operator-runbook.md` as the canonical daily-use procedure and keep this skill focused on operator policy, checkpoints, and escalation.
- Treat the factory-control surface as the primary local runtime contract; use ad hoc `screen`, `ps`, or `pkill` inspection only when the control command is unavailable or inconsistent.
- In a wake-up cycle, favor short, bounded inspection commands over long-running watchers. If a secondary GitHub or watch-surface probe is slow or non-terminal, stop and continue from the latest successful control-surface read instead of waiting indefinitely.
- Use `pnpm tsx bin/symphony.ts factory watch` for continuous detached monitoring; do not use raw `screen -r symphony-factory` as the normal watch path because `Ctrl-C` there can kill the worker.
- Treat `symphony:running` with no live detached runtime or no live runner visibility as an orphaned run and repair it.
- Prefer `pnpm tsx bin/symphony.ts factory start|stop|restart` over manual `screen` and process cleanup.
- Treat detached startup locale handling as repo-owned behavior: the supported factory-control path selects an installed UTF-8 locale, launches `screen -U`, and should fail clearly rather than relying on shell-local locale folklore.
- Prefer detached worker sessions that survive outside the current interactive shell.
- Use an isolated checkout when fixing PR branches so local operator-only modifications do not leak into tracked work.
- The factory owns PR follow-up by default. If a fresh actionable review batch lands and the factory does not pick it up, debug the miss as a factory/runtime problem before taking over the branch manually.
- Do not silently replace the worker on an active PR just because the next fix is obvious. Operator PR intervention is for stalled or broken factory behavior, not the normal path.
- If a PR's required checks remain non-terminal for an unusually long time but the same behavior can be reproduced locally, do not stop at the first fixed assertion failure. Keep the PR in active operator treatment until the full locally reproducible hang is resolved or reduced to clearly external infrastructure.
- Keep runner assumptions provider-neutral. The current runtime may use `codex`, `claude-code`, or `generic-command`; do not assume every healthy run appears as a direct `codex exec` child process.
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
- Plan review and landing are default operator duties, not optional extras:
  - each wake-up should check for `plan-ready` issues and decide `approved`, `changes-requested`, or `waived`
  - each wake-up should check for review-clean PRs waiting on `/land` and post it when the guard conditions are satisfied
- Landing is not complete at merge observation alone:
  - after a landed PR merges, the operator should pull the latest `origin/main` into the root checkout and `.tmp/factory-main`
  - then restart the detached factory from that refreshed runtime before allowing the next queued issue to proceed
- When a PR is green and review-clean, the operator should issue `/land` on the PR without waiting for separate human intervention unless the user has explicitly reserved landing for themselves. This is the normal way to keep the factory moving overnight.
- `/land` is appropriate only when:
  - required CI is green,
  - actionable review feedback has been addressed,
  - no unresolved merge-blocking review state remains,
  - and no required check has been stuck in a non-terminal state long enough to count as blocked infrastructure.

## Learned Heuristics

- Detached `screen` sessions have been more reliable for unattended local operation than short-lived interactive exec sessions.
- `pnpm tsx bin/symphony.ts factory status --json` is the fastest trustworthy read of detached runtime health, embedded status snapshot state, and degraded-control problems.
- `pnpm tsx bin/symphony.ts factory watch` is the supported live watch surface for the detached factory; it should absorb operator `Ctrl-C` without stopping the worker.
- The TUI/watch surface is an operator view, not the source of truth. On each wake-up, compare it against `factory status --json`; if issue stage, checks, review counts, session/event text, or token display drift materially, treat that as a product bug rather than hand-waving it away.
- A closed issue plus an open PR usually means the factory reached the PR stage; inspect the PR before restarting anything.
- If the factory has no `symphony:ready` issues, idle is healthy.
- Use the failure-drill guide to rehearse restart, retry, watchdog, and retained-workspace paths instead of encoding those procedures only in scratch notes.

## End-of-Cycle Check

Before finishing each wake-up:

1. update `.ralph/operator-scratchpad.md` with current state, open risks, and the next operator checks,
2. ask whether this cycle revealed something missing or ambiguous in this skill or the operator prompt,
3. distinguish between:
   - durable process rules or generally correct operator behavior, which belong in this skill or the operator prompt,
   - transient factory facts, temporary workarounds, and run-specific context, which belong in `.ralph/operator-scratchpad.md`,
4. if a durable rule needs to change, make the improvement through the normal PR flow,
5. and record the result in the final status summary.
