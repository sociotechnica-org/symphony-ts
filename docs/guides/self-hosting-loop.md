# The Self-Hosting Loop: Using Symphony to Build Symphony

Symphony runs against the `symphony-ts` GitHub repo and works `symphony-ts` issues by opening PRs back to that same repo. This is how we develop it.

This guide is only for the `symphony-ts` self-hosting path. If you want to run
Symphony against a different repository from a shared engine checkout, use the
third-party onboarding path in [`README.md`](../../README.md), starting with
`pnpm tsx bin/symphony.ts init <target-repo> --tracker-repo <owner/repo>`.

Canonical day-two operating procedure now lives in:

- [`operator-runbook.md`](./operator-runbook.md)
- [`failure-drills.md`](./failure-drills.md)

## Setup

### 1. Prepare the local machine

Make sure these are installed and configured:

- `pnpm`
- `git`
- `gh auth login`
- one supported local runner:
  - `codex`, or
  - Claude Code (`claude`)

Then install repo dependencies:

```bash
pnpm install
```

### 2. Confirm the workflow targets this repo

The checked-in `WORKFLOW.md` should point at:

- `tracker.repo: sociotechnica-org/symphony-ts`
- `agent.command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -`

If you want to self-host with Claude Code instead of Codex, change the checked-in
worker settings before starting the factory:

- set `agent.runner.kind: claude-code`
- set `agent.command` to a valid Claude Code invocation such as
  `claude -p --output-format json --permission-mode bypassPermissions --model sonnet`

For the bootstrap GitHub flow, Symphony can derive the workspace clone URL from
`tracker.repo`, so the checked-in workflow does not need an explicit
`workspace.repo_url` for self-hosting.

That means the local orchestrator will poll the real `symphony-ts` GitHub repo
and create issue branches inside local workspaces cloned from that same
repository. Startup now refreshes a local bare mirror under
`.tmp/github/upstream` first, so those per-issue workspaces clone from the
local mirror instead of directly from GitHub.

The repository containing `WORKFLOW.md` is the local Symphony instance root.
Its `.tmp/`, `.var/`, and detached runtime checkout under `.tmp/factory-main`
belong to that one instance. That is the local multi-instance seam: different
target repositories can each own their own `WORKFLOW.md` and local runtime
state while still using the same engine code.

### 3. Create a real GitHub issue

Open an issue at <https://github.com/sociotechnica-org/symphony-ts/issues>.

Describe the task normally. Then add the label `symphony:ready` — that's the dispatch signal.

### 4. Start Symphony locally

Run one poll cycle directly:

```bash
pnpm tsx bin/symphony.ts run --once
```

Or run the worker continuously in the current shell:

```bash
pnpm tsx bin/symphony.ts run
```

Or start the detached local factory runtime from the repo root:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory status
pnpm tsx bin/symphony.ts factory watch
```

In continuous mode, Symphony will keep polling for additional ready issues. The
factory-control commands are the normal operator surface for the detached
runtime under `<instance-root>/.tmp/factory-main`.
For the full daily-use procedure, recovery interpretation, and restart rules,
use the checked-in operator runbook instead of treating this guide as the only
operations reference.

To run the higher-level repo-owned operator wake-up loop from a clean clone,
use the versioned entry point under `skills/symphony-operator/` through the
package scripts:

```bash
pnpm operator
pnpm operator:once
```

`pnpm operator` runs the continuous wake-up loop. `pnpm operator:once` runs one
operator cycle and exits. The loop writes only local/generated artifacts under
`.ralph/instances/<instance-key>/` such as `operator-scratchpad.md`,
`status.json`, `status.md`, `logs/`, and lock files; the durable tooling and
prompt live in `skills/symphony-operator/`.
This entry point currently expects a Unix-like shell environment such as macOS,
Linux, or WSL/Git Bash on Windows.

Symphony now has two status surfaces:

- `pnpm tsx bin/symphony.ts status` reads the workflow-derived status snapshot
- `pnpm tsx bin/symphony.ts factory status` inspects the detached runtime and
  embeds the latest status snapshot when available

Both surfaces now include the runtime checkout identity for the live factory
code. Use that `HEAD` SHA and checkout path to answer "what version is running
right now?"; for detached control it refers to `<instance-root>/.tmp/factory-main`, not the
operator checkout you are typing in.

For self-hosting operations, prefer `factory status` first, then `factory watch`
when you want a live read-only monitor.

The supported detached control path owns the UTF-8 terminal contract for the
factory runtime: it selects an installed UTF-8 locale for detached startup,
launches GNU Screen with `-U`, and fails clearly when the host cannot provide a
usable UTF-8 locale.

Do not use raw `screen -r <instance-session-name>` as the normal watch path. That
attach path gives your terminal direct foreground ownership of the worker, so
an accidental `Ctrl-C` can stop the detached factory.

The operator loop sits above those factory-control commands; it should inspect
and supervise the detached runtime through `factory status` / `factory watch`
rather than reimplementing scheduler or runner logic.

### 5. Watch the issue lifecycle

When Symphony picks up the issue, it should:

1. Replace `symphony:ready` with `symphony:running`
2. Create or reuse a local workspace under `./.tmp/workspaces/`
3. Create branch `symphony/<issue-number>`
4. Have the worker draft the technical plan and stop at the human review station unless plan approval is waived
5. Run implementation work from the approved or waived plan using the configured
   runner
6. Push the branch
7. Open a PR against `main`
8. Keep polling that PR for CI and automated review state
9. Push follow-up commits on the same branch until the PR is actually clean
10. Wait for a human to approve landing by posting `/land` on the PR
11. Execute the landing path and complete the issue only after merge is observed

If the PR reaches a clean state, Symphony moves into an explicit landing-handoff wait. The issue stays active until a human posts `/land` on the PR and Symphony then observes the merge.

If the run fails, Symphony will either retry it in the running loop or mark it `symphony:failed`.

### 6. Review and land the PR

Symphony owns the local PR follow-through loop:

- Wait for CI and automated review checks
- Detect actionable review feedback
- Push follow-up commits when the PR needs more work
- Stop only when the PR is actually clean and waiting for landing approval

Human approval remains explicit: once the PR is ready, post `/land` on the PR.
Symphony uses that handoff to execute the landing path itself.

That merged PR becomes the new version of Symphony that will work the next issue.

### 7. Repeat

Create the next `symphony-ts` issue, label it `symphony:ready`, and run Symphony again.

That is the self-hosting loop:

1. Symphony works a `symphony-ts` issue
2. Symphony opens a PR into `symphony-ts`
3. The PR merges
4. The improved Symphony is used on the next `symphony-ts` issue

## Practical Notes

- For the canonical daily-use runbook and failure rehearsals, use [`operator-runbook.md`](./operator-runbook.md) and [`failure-drills.md`](./failure-drills.md).
- Run only one local Symphony instance against this repo at a time (Phase 1.2 constraint).
- If you want to inspect successful runs locally, set `workspace.retention.on_success: retain` temporarily or inspect the workspace before the next retry/reset.
- Use `--once` when you want tight control over one issue at a time.
- Prefer `pnpm tsx bin/symphony.ts factory start|stop|restart|status|watch` over ad hoc `screen` and
  process cleanup when operating the detached runtime.
- Prefer `pnpm operator` / `pnpm operator:once` over any ad hoc local `.ralph/`
  script; `.ralph/` is reserved for generated operator state only.
