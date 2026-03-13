# The Self-Hosting Loop: Using Symphony to Build Symphony

Symphony runs against the `symphony-ts` GitHub repo and works `symphony-ts` issues by opening PRs back to that same repo. This is how we develop it.

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
repository.

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
```

In continuous mode, Symphony will keep polling for additional ready issues. The
factory-control commands are the normal operator surface for the detached
runtime under `.tmp/factory-main`.

Symphony now has two status surfaces:

- `pnpm tsx bin/symphony.ts status` reads the workflow-derived status snapshot
- `pnpm tsx bin/symphony.ts factory status` inspects the detached runtime and
  embeds the latest status snapshot when available

For self-hosting operations, prefer `factory status` first.

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

- Run only one local Symphony instance against this repo at a time (Phase 1.2 constraint).
- If you want to inspect a failed run, set `workspace.cleanup_on_success: false` temporarily or inspect the workspace before the next retry.
- Use `--once` when you want tight control over one issue at a time.
- Prefer `pnpm tsx bin/symphony.ts factory start|stop|restart|status` over ad hoc `screen` and
  process cleanup when operating the detached runtime.
