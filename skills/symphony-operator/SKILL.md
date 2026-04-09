---
name: symphony-operator
description: Operate and maintain the local Symphony factory from this repository checkout. Use this skill when monitoring the live factory, repairing stalled runs, handling PR review and CI follow-up, or improving the operator loop itself.
---

# Symphony Operator

Use this skill when acting as the operator for the local Symphony factory.

Canonical procedure docs:

- `docs/guides/operator-runbook.md` for the normal detached runtime workflow
- `docs/guides/failure-drills.md` for repeatable recovery rehearsal and stability checks

Supported repo-owned entry point:

- `pnpm operator` for the continuous wake-up loop
- `pnpm operator:once` for one cycle
- `pnpm operator -- --provider codex --model gpt-5.4-mini` for explicit Codex model selection
- `pnpm operator -- --provider claude` for the checked-in Claude harness path
- `pnpm operator -- --provider codex --model gpt-5.4-mini --resume-session` for instance-scoped resumable wake-ups

The checked-in loop and prompt live next to this skill under
`skills/symphony-operator/`. `.ralph/` is local/generated-only state for the
instance-scoped standing context, wake-up log, status snapshots, logs, and
loop lock files under `.ralph/instances/<instance-key>/`. Release dependency
metadata and the current release advancement posture also live there in
`release-state.json`. When resumable mode is enabled, that same root also
carries `operator-session.json`, the typed record of the compatible reusable
provider session for that instance. The same root now also carries
`control-state.json`, the code-owned checkpoint snapshot for one wake-up
cycle.
Selected-instance repo-specific operator policy belongs in
`<instance-root>/OPERATOR.md` when that file exists.

## Scope

- Observe the live factory, not just the repository.
- Repair broken or stalled execution.
- Drive PRs through CI and automated review to a mergeable state.
- Handle `plan-ready` issues using the selected workflow's configured `tracker.plan_review` protocol: review plans against the selected instance repository's own checked-in contract, request changes when needed, and approve when ready.
- Keep GitHub as a thin queue and rely on Symphony's own polling and concurrency.
- Maintain the selected instance's persistent local operator notebook as:
  - `.ralph/instances/<instance-key>/standing-context.md` for durable guidance
  - `.ralph/instances/<instance-key>/wake-up-log.md` for append-only wake-up history
  - `.ralph/instances/<instance-key>/release-state.json` for typed release dependency metadata and blocked/clear advancement posture

## Control Surface

The operator loop refreshes `control-state.json` before the operator command
runs. Treat that artifact as the code-owned source of truth for deterministic
wake-up ordering.

`control-state.json` summarizes, in fixed order:

1. factory health and runtime freshness
2. completed-run report-review backlog
3. release-state and ready-promotion gates
4. pending plan-review or landing actions

The prompt should consume that artifact rather than restating the full
checkpoint algorithm. When the checked-in prompt and `control-state.json`
disagree, trust the generated artifact and fix the prompt or code through the
normal PR flow.

## Wake-Up Expectations

1. Read the selected instance's standing context first, then the wake-up log.
2. Read `control-state.json` and follow its highest-priority blocked or pending checkpoint before ordinary queue work.
3. If the runtime checkpoint is blocked, repair the concrete runtime or freshness problem first. Stale `*-idle` means restart before queue work; stale `*-busy` means record the drift and defer restart until the next safe checkpoint.
4. If completed-run report review is blocked, read the generated report evidence, persist a review decision with `symphony-report review-record` or `symphony-report review-follow-up`, and record durable lessons in the right notebook surface.
5. If the release checkpoint is blocked, do not promote downstream tickets or post `/land` for blocked release work until the prerequisite failure, metadata gap, or label-sync failure is resolved.
6. If operator-gated actions are pending and earlier checkpoints are clear, handle `awaiting-human-handoff` plan review and `awaiting-landing-command` `/land` work during the cycle.
7. After posting a plan-review decision or `/land`, verify the factory observes it and transitions correctly.
8. After a merge, fast-forward the selected instance root to `origin/main`, rerun the freshness checkpoint, and restart only when the runtime engine or selected `WORKFLOW.md` is actually stale.
9. Use bounded, one-shot probes during the wake-up cycle. Prefer short reads over long-running watchers in the critical path.

## Operational Rules

- Do not act as a second scheduler.
- Keep concurrency conservative.
- Treat `docs/guides/operator-runbook.md` as the canonical daily-use procedure and keep this skill focused on operator policy, checkpoints, and escalation.
- Treat the factory-control surface as the primary local runtime contract; use ad hoc `screen`, `ps`, or `pkill` inspection only when the control command is unavailable or inconsistent.
- Treat the operator checkout as tooling, not automatically as policy authority. For plan review and repo-owned rules, the selected instance repository is the source of truth.
- Treat `<selected-instance-root>/OPERATOR.md` as the primary repo-specific operator-policy source when it exists. If it does not, fall back to the selected repository's `WORKFLOW.md`, `AGENTS.md`, `README.md`, and other checked-in docs that do exist.
- In a wake-up cycle, favor short, bounded inspection commands over long-running watchers. If a secondary GitHub or watch-surface probe is slow or non-terminal, stop and continue from the latest successful control-surface read instead of waiting indefinitely.
- Do not start `pnpm operator`, `pnpm operator:once`, or `operator-loop.sh` from inside an active wake-up shell. Use the supported factory-control and status commands instead of nesting the operator loop.
- Use `pnpm tsx bin/symphony.ts factory watch` for continuous detached monitoring and `pnpm tsx bin/symphony.ts factory attach` when you need the full-screen TUI; do not use raw `screen -r <instance-session-name>` as the normal watch path because `Ctrl-C` there can kill the worker.
- Treat `symphony:running` with no live detached runtime or no live runner visibility as an orphaned run and repair it.
- Prefer `pnpm tsx bin/symphony.ts factory start|stop|restart` over manual `screen` and process cleanup.
- Treat detached startup locale handling as repo-owned behavior: the supported factory-control path selects an installed UTF-8 locale, launches `screen -U`, and should fail clearly rather than relying on shell-local locale folklore.
- Prefer detached worker sessions that survive outside the current interactive shell.
- Use an isolated checkout when fixing PR branches so local operator-only modifications do not leak into tracked work.
- The factory owns PR follow-up by default. If a fresh actionable review batch lands and the factory does not pick it up, debug the miss as a factory/runtime problem before taking over the branch manually.
- Do not silently replace the worker on an active PR just because the next fix is obvious. Operator PR intervention is for stalled or broken factory behavior, not the normal path.
- If a PR's required checks remain non-terminal for an unusually long time but the same behavior can be reproduced locally, do not stop at the first fixed assertion failure. Keep the PR in active operator treatment until the full locally reproducible hang is resolved or reduced to clearly external infrastructure.
- Keep runner assumptions provider-neutral. The current runtime may use `codex`, `claude-code`, or `generic-command`; do not assume every healthy run appears as a direct `codex exec` child process.
- Keep release dependency truth in the typed `release-state.json` artifact, not only in markdown notes. Standing context may explain release sequencing, but prerequisite failure gating must remain inspectable through the typed artifact.
- Treat plan review as a required operator checkpoint:
  - read the selected workflow's `tracker.plan_review` config first,
  - read the selected instance repository's `OPERATOR.md`, `WORKFLOW.md`, `AGENTS.md`, `README.md`, and relevant docs when they exist,
  - if the plan is sound, post that workflow's approval marker,
  - if revisions are needed, post that workflow's changes-requested marker with concrete guidance,
  - if explicitly bypassing review, post that workflow's waiver marker and record why.

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
  - each wake-up should clear completed-run report review work before ordinary queue advancement
  - each wake-up should clear the release-state prerequisite-failure checkpoint before downstream advancement or `/land` for dependent work
  - each wake-up should check for `plan-ready` issues and decide `approved`, `changes-requested`, or `waived`
  - each wake-up should check for review-clean PRs waiting on `/land` and post it when the guard conditions are satisfied
- Landing is not complete at merge observation alone:
  - after a landed PR merges, the operator should fast-forward the selected instance root checkout to the latest `origin/main`
  - then rerun the freshness check and restart only when runtime or selected-workflow drift actually requires it before allowing the next queued issue to proceed
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
- `pnpm tsx bin/symphony.ts factory attach` is the supported way to recover the full-screen TUI for a detached factory instance; `Ctrl-C` should exit the attach client without stopping the worker.
- The TUI/watch surface is an operator view, not the source of truth. On each wake-up, compare it against `factory status --json`; if issue stage, checks, review counts, session/event text, or token display drift materially, treat that as a product bug rather than hand-waving it away.
- A closed issue plus an open PR usually means the factory reached the PR stage; inspect the PR before restarting anything.
- If the factory has no `symphony:ready` issues, idle is healthy.
- Use the failure-drill guide to rehearse restart, retry, watchdog, and retained-workspace paths instead of encoding those procedures only in scratch notes.

## End-of-Cycle Check

Before finishing each wake-up:

1. append a new timestamped entry to the selected instance wake-up log with current state, open risks, and the next operator checks,
2. ask whether this cycle revealed something missing or ambiguous in this skill or the operator prompt,
3. distinguish between:
   - durable process rules or generally correct operator behavior, which belong in this skill or the operator prompt,
   - durable instance guidance such as queue sequencing, release ordering, and campaign notes, which belong in standing context,
   - transient factory facts and per-cycle observations, which belong in the append-only wake-up log,
4. if a durable rule needs to change, make the improvement through the normal PR flow,
5. and record the result in the final status summary.
