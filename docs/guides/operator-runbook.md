# Operator Runbook

This is the canonical day-to-day operating guide for the local detached Symphony factory in this repository. Use it with [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md), and [`skills/symphony-operator/SKILL.md`](../../skills/symphony-operator/SKILL.md).

## Supported Surfaces

Use the checked-in factory control commands as the normal runtime contract:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory status
pnpm tsx bin/symphony.ts factory status --json
pnpm tsx bin/symphony.ts factory watch
pnpm tsx bin/symphony.ts factory attach
pnpm tsx bin/symphony.ts factory pause --reason "Prerequisite ticket failed; stop the line."
pnpm tsx bin/symphony.ts factory resume
pnpm tsx bin/symphony.ts factory restart
pnpm tsx bin/symphony.ts factory stop
```

From an engine checkout that is not the active instance root, pass an explicit
selector:

```bash
pnpm tsx bin/symphony.ts factory status --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory watch --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory attach --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory restart --workflow ../target-repo/WORKFLOW.md
```

Use the repo-owned operator loop when you want repeated wake-up cycles:

```bash
pnpm operator
pnpm operator:once
pnpm operator -- --workflow ../target-repo/WORKFLOW.md
```

## Third-Party Onboarding

If you are operating a third-party repository instead of self-hosting
`symphony-ts`, create that repository's local instance contract first from the
engine checkout:

```bash
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo
```

Then review `../target-repo/WORKFLOW.md`, customize its prompt and repo policy,
and use the factory commands in this runbook with `--workflow
../target-repo/WORKFLOW.md` whenever your shell is not already inside that
instance root.

Normal path rules:

- Treat `factory status --json` as the primary source of truth.
- Use `factory watch` as the supported live read-only monitor.
- Use `factory attach` when you need the full-screen TUI for a detached instance.
- Use `factory pause --reason ...` when continuing dispatch would be harmful and the instance must stay halted until human reconciliation.
- Do not use raw `screen -r <instance-session-name>` as the normal watch path because `Ctrl-C` there can stop the detached worker.
- Prefer `factory start|stop|restart|pause|resume` over ad hoc `screen`, `ps`, or `pkill`.

## Daily Loop

Run this sequence at the start of each operator pass:

1. Inspect `pnpm tsx bin/symphony.ts factory status --json`, appending `--workflow <path>` whenever the operator checkout is not the target instance root.
2. Before ordinary queue work, inspect completed-run report review state with:

```bash
pnpm tsx bin/symphony-report.ts review-pending --operator-repo-root <operator-checkout> --json
pnpm tsx bin/symphony-report.ts review-pending --workflow ../target-repo/WORKFLOW.md --operator-repo-root <operator-checkout> --json
```

3. If `review-pending` reports any `report-ready` or `review-blocked` entries, handle those completed-run reports first:
   - read the generated evidence under `.var/reports/issues/<issue-number>/`
   - record a no-follow-up decision with `symphony-report.ts review-record`
   - or create a tracked follow-up issue with `symphony-report.ts review-follow-up`
   - and record durable guidance in standing context plus per-cycle findings in the wake-up log
4. Before downstream release advancement work, inspect release dependency state with:

```bash
pnpm tsx bin/check-operator-release-state.ts --operator-repo-root <operator-checkout> --json
pnpm tsx bin/check-operator-release-state.ts --workflow ../target-repo/WORKFLOW.md --operator-repo-root <operator-checkout> --json
```

5. Treat `.ralph/instances/<instance-key>/release-state.json` as the canonical operator-local release artifact. If it reports `blocked-by-prerequisite-failure` or `blocked-review-needed`, do not promote downstream tickets or post `/land` for downstream PRs in that release until the blocking prerequisite failure or metadata gap is resolved.
6. If useful, compare the live watch surface with `pnpm tsx bin/symphony.ts factory watch`, using the same explicit workflow selector.
7. Use `pnpm tsx bin/symphony.ts factory attach` only when you need the real full-screen TUI for deeper live inspection; `Ctrl-C` exits the attach client only.
8. Check for operator-gated work the factory cannot clear by itself:
   - active issues in `awaiting-human-handoff`
   - active issues or PRs in `awaiting-landing-command`
9. If the detached runtime is stopped or degraded, repair that first.
10. If a PR is green, review-clean, and required approved bot review has been observed on the current head, post `/land`. Do not do that for work the release-state artifact says is blocked by a failed prerequisite or unresolved dependency metadata. If expected reviewer-app output is still missing after checks settle, treat that as degraded infrastructure instead of a normal wait.
11. After a merge, fast-forward the instance root checkout and `<instance-root>/.tmp/factory-main` to `origin/main`, then restart the detached factory from merged code.

Do not act as a second scheduler. If the factory is healthy, let it own dispatch, retries, and PR follow-up.

## Start, Watch, Restart

Start or restart from the repo root:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory restart
```

From another checkout, target the intended instance directly:

```bash
pnpm tsx bin/symphony.ts factory start --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory restart --workflow ../target-repo/WORKFLOW.md
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

Recover the full-screen TUI safely with:

```bash
pnpm tsx bin/symphony.ts factory attach
```

`factory attach` is richer than `factory watch`, but it is still brokered:
`Ctrl-C` exits the attach client without stopping the detached worker.
On macOS, the broker now builds a small local PTY helper on first use; if no
local `cc` compiler is available, `factory attach` fails clearly instead of
falling back to an unsafe direct `screen` attach.

Stop only through the supported command:

```bash
pnpm tsx bin/symphony.ts factory stop
```

When a severe failure means further automation would make recovery harder, stop
the line explicitly first:

```bash
pnpm tsx bin/symphony.ts factory pause --reason "Prerequisite ticket failed; stop the line until the release is reconciled."
pnpm tsx bin/symphony.ts factory status --json
pnpm tsx bin/symphony.ts factory stop
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory resume
```

`factory pause` writes canonical halt state under `.var/factory/`. That halt
survives `factory stop` / `factory start`; only `factory resume` clears it.

## Reading Status

Start with these fields in `factory status --json`:

- `control.state`: whether the detached wrapper/runtime is running, stopped, or degraded
- `status.factoryState`: whether the factory is idle, running, blocked, or degraded
- `status.factoryHalt`: whether the instance is clear, intentionally halted, or has unreadable halt state
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
- `degraded` or `degraded-observability`: inspect before taking further action; this is not a healthy wait state. Missing expected reviewer-app output after checks settle also belongs here.

Issue-level lifecycle checkpoints:

- `awaiting-human-handoff`: review the technical plan and reply with an accepted plan-review marker
- `awaiting-system-checks`: wait for CI or automated review follow-up unless a check is obviously stuck
- `awaiting-human-review` or `rework-required`: inspect the PR review state and let the factory push follow-up if it is already responding
- `degraded-review-infrastructure`: expected reviewer-app output never arrived on the current head after checks settled; inspect the reviewer app/integration before treating the PR as review-clean
- `awaiting-landing-command`: post `/land` when the PR is green, review-clean, and required approved bot review has been observed on the current head
- `awaiting-landing`: the landing request was issued; wait for merge observation or a clear landing failure

## Intervention Rules

Intervene directly only when the runtime contract is impaired or an explicit human checkpoint is waiting.

Use this table:

| Situation                                                                                        | Operator action                                                                                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `awaiting-human-handoff`                                                                         | Review the plan and post `Plan review: approved`, `Plan review: changes-requested`, or `Plan review: waived`                |
| `degraded-review-infrastructure`                                                                 | Inspect the missing reviewer-app output path before further automation or manual landing                                    |
| `awaiting-landing-command` with green, review-clean PR and required approved bot review observed | Post `/land` on the PR                                                                                                      |
| Detached runtime stopped or degraded                                                             | Use `factory status`, then `factory start` or `factory restart`                                                             |
| Severe failure pattern where continuing automation would be harmful                              | Use `factory pause --reason ...`, inspect `factory status`, then optionally `factory stop` until humans reconcile           |
| `restart-recovery` visible after startup                                                         | Inspect the recovery summary and per-issue decisions before manual reruns                                                   |
| `retry-backoff` or `watchdog-recovery`                                                           | Prefer waiting for the queue/recovery path unless the factory is degraded or the posture stops progressing                  |
| Failed issue with retained workspace                                                             | Inspect artifacts and retained workspace, fix the underlying problem, then relabel or rerun through the normal tracker path |

Avoid manual branch takeovers while the factory is healthy. If the runtime missed CI or review follow-up, treat that as a product problem first.

## Artifacts And Cleanup

Canonical local evidence lives under:

- `.tmp/status.json` for the current runtime snapshot
- `.var/factory/issues/<issue-number>/` for per-issue canonical artifacts
- `.var/reports/issues/<issue-number>/` for generated reports
- `.tmp/workspaces/<issue-number>/` for retained workspaces when retention keeps them

Those paths are instance-owned. The repository containing the active
`WORKFLOW.md` is the instance root, and its `.tmp/`, `.var/`, and
`.tmp/factory-main` directories are the local runtime surface for that one
instance.

Operator-loop generated state is separate from that runtime surface. It stays
under the operator checkout's `.ralph/instances/<instance-key>/` tree so two
operator loops targeting different instances do not overwrite each other's
standing context, wake-up log, status, logs, or lock files.
Completed-run report review state also lives there in
`report-review-state.json`; this is the machine-readable ledger for which
generated reports are pending review, reviewed, or blocked, and which follow-up
issues were filed from report findings.
Release dependency state lives there in `release-state.json`; this is the
machine-readable record of configured prerequisite/downstream relationships plus
the current blocked or clear release advancement posture.

Workspace retention is config-driven. By default, failures stay inspectable and successes are cleaned up. If you need to inspect a successful workspace, temporarily set `workspace.retention.on_success: retain` before the run.

## Manual Handoffs

Two human checkpoints remain explicit even when the factory is otherwise autonomous:

1. Technical plan review before substantial implementation unless the review is explicitly waived.
2. Landing approval through `/land` on a review-clean PR whose current head already has required approved bot review.

If either checkpoint is waiting, treat that as normal `waiting-expected` posture, not a runtime failure. If expected reviewer-app output is missing after checks settle, that is not a normal checkpoint wait; it is degraded infrastructure.

## Stability Validation

For the repo-owned local credibility checks, run:

```bash
pnpm test -- tests/unit/recovery-posture.test.ts tests/e2e/bootstrap-factory.test.ts
```

The end-to-end stability slice covers concurrent work where one issue reaches PR handoff while another sits in retry backoff, so operators can trust the status surfaces under mixed posture instead of only single-issue happy paths.
