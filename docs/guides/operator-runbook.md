# Operator Runbook

This is the canonical day-to-day operating guide for the local detached Symphony factory in this repository. Use it with [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md), and [`skills/symphony-operator/SKILL.md`](../../skills/symphony-operator/SKILL.md).

## Supported Surfaces

Use the checked-in factory control commands as the normal runtime contract:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory status
pnpm tsx bin/symphony.ts factory status --json
pnpm tsx bin/symphony.ts factory watch
pnpm tsx bin/symphony.ts factory restart
pnpm tsx bin/symphony.ts factory stop
```

Use the repo-owned operator loop when you want repeated wake-up cycles:

```bash
pnpm operator
pnpm operator:once
```

Normal path rules:

- Treat `factory status --json` as the primary source of truth.
- Use `factory watch` as the supported live read-only monitor.
- Do not use raw `screen -r symphony-factory` as the normal watch path because `Ctrl-C` there can stop the detached worker.
- Prefer `factory start|stop|restart` over ad hoc `screen`, `ps`, or `pkill`.

## Daily Loop

Run this sequence at the start of each operator pass:

1. Inspect `pnpm tsx bin/symphony.ts factory status --json`.
2. If useful, compare the live watch surface with `pnpm tsx bin/symphony.ts factory watch`.
3. Check for operator-gated work the factory cannot clear by itself:
   - active issues in `awaiting-human-handoff`
   - active issues or PRs in `awaiting-landing-command`
4. If the detached runtime is stopped or degraded, repair that first.
5. If a PR is green, review-clean, and required approved bot review has been observed on the current head, post `/land`.
6. After a merge, fast-forward the root checkout and `.tmp/factory-main` to `origin/main`, then restart the detached factory from merged code.

Do not act as a second scheduler. If the factory is healthy, let it own dispatch, retries, and PR follow-up.

## Start, Watch, Restart

Start or restart from the repo root:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory restart
```

Healthy detached operation should show:

- a live worker in `factory status`
- a current embedded status snapshot
- the runtime checkout identity for `.tmp/factory-main`
- no degraded control-state warnings

Watch the live surface with:

```bash
pnpm tsx bin/symphony.ts factory watch
```

Stop only through the supported command:

```bash
pnpm tsx bin/symphony.ts factory stop
```

## Reading Status

Start with these fields in `factory status --json`:

- `control.state`: whether the detached wrapper/runtime is running, stopped, or degraded
- `status.factoryState`: whether the factory is idle, running, blocked, or degraded
- `status.recoveryPosture.summary`: the current operator-facing posture family and summary
- `status.activeIssues`: current issue-level lifecycle state
- `status.retries`: queued retries with class and due time
- `status.runtimeIdentity`: the actual code version running under `.tmp/factory-main`

Interpret the main recovery-posture families this way:

- `healthy`: active work is running without recovery pressure
- `waiting-expected`: work is waiting on plan review, CI, review follow-up, or landing
- `retry-backoff`: at least one issue is queued for retry; avoid manual reruns unless the posture is stuck or degraded
- `watchdog-recovery`: a stalled run triggered watchdog recovery or watchdog-driven retry
- `restart-recovery`: startup is reconciling inherited `symphony:running` work or surfacing restart decisions
- `degraded` or `degraded-observability`: inspect before taking further action; this is not a healthy wait state

Issue-level lifecycle checkpoints:

- `awaiting-human-handoff`: review the technical plan and reply with an accepted plan-review marker
- `awaiting-system-checks`: wait for CI or automated review follow-up unless a check is obviously stuck
- `awaiting-human-review` or `rework-required`: inspect the PR review state and let the factory push follow-up if it is already responding
- `awaiting-landing-command`: post `/land` when the PR is green, review-clean, and required approved bot review has been observed on the current head
- `awaiting-landing`: the landing request was issued; wait for merge observation or a clear landing failure

## Intervention Rules

Intervene directly only when the runtime contract is impaired or an explicit human checkpoint is waiting.

Use this table:

| Situation                                              | Operator action                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `awaiting-human-handoff`                               | Review the plan and post `Plan review: approved`, `Plan review: changes-requested`, or `Plan review: waived`                |
| `awaiting-landing-command` with green, review-clean PR and required approved bot review observed | Post `/land` on the PR                                                                    |
| Detached runtime stopped or degraded                   | Use `factory status`, then `factory start` or `factory restart`                                                             |
| `restart-recovery` visible after startup               | Inspect the recovery summary and per-issue decisions before manual reruns                                                   |
| `retry-backoff` or `watchdog-recovery`                 | Prefer waiting for the queue/recovery path unless the factory is degraded or the posture stops progressing                  |
| Failed issue with retained workspace                   | Inspect artifacts and retained workspace, fix the underlying problem, then relabel or rerun through the normal tracker path |

Avoid manual branch takeovers while the factory is healthy. If the runtime missed CI or review follow-up, treat that as a product problem first.

## Artifacts And Cleanup

Canonical local evidence lives under:

- `.tmp/status.json` for the current runtime snapshot
- `.var/factory/issues/<issue-number>/` for per-issue canonical artifacts
- `.var/reports/issues/<issue-number>/` for generated reports
- `.tmp/workspaces/<issue-number>/` for retained workspaces when retention keeps them

Workspace retention is config-driven. By default, failures stay inspectable and successes are cleaned up. If you need to inspect a successful workspace, temporarily set `workspace.retention.on_success: retain` before the run.

## Manual Handoffs

Two human checkpoints remain explicit even when the factory is otherwise autonomous:

1. Technical plan review before substantial implementation unless the review is explicitly waived.
2. Landing approval through `/land` on a review-clean PR whose current head already has required approved bot review.

If either checkpoint is waiting, treat that as normal `waiting-expected` posture, not a runtime failure.

## Stability Validation

For the repo-owned local credibility checks, run:

```bash
pnpm test -- tests/unit/recovery-posture.test.ts tests/e2e/bootstrap-factory.test.ts
```

The end-to-end stability slice covers concurrent work where one issue reaches PR handoff while another sits in retry backoff, so operators can trust the status surfaces under mixed posture instead of only single-issue happy paths.
