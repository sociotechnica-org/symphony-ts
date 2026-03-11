# The Self-Hosting Loop: Using Symphony to Build Symphony

Symphony runs against the `symphony-ts` GitHub repo and works `symphony-ts` issues by opening PRs back to that same repo. This is how we develop it.

## Setup

### 1. Prepare the local machine

Make sure these are installed and configured:

- `pnpm`
- `git`
- `gh auth login`
- `codex`

Then install repo dependencies:

```bash
pnpm install
```

### 2. Confirm the workflow targets this repo

The checked-in `WORKFLOW.md` should point at:

- `tracker.repo: sociotechnica-org/symphony-ts`
- `workspace.repo_url: git@github.com:sociotechnica-org/symphony-ts.git`
- `agent.command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -`

That means the local orchestrator will poll the real `symphony-ts` GitHub repo and create issue branches inside local workspaces cloned from that same repository.

### 3. Create a real GitHub issue

Open an issue at <https://github.com/sociotechnica-org/symphony-ts/issues>.

Describe the task normally. Then add the label `symphony:ready` — that's the dispatch signal.

### 4. Start Symphony locally

Run one poll cycle:

```bash
pnpm tsx bin/symphony.ts run --once
```

Or run the worker continuously:

```bash
pnpm tsx bin/symphony.ts run
```

In continuous mode, Symphony will keep polling for additional ready issues.

During or after a run, Symphony writes the latest derived status snapshot to `.tmp/status.json`. The `status` CLI reads that file and renders either a simple terminal view or the raw JSON contract for future tooling.

### 5. Watch the issue lifecycle

When Symphony picks up the issue, it should:

1. Replace `symphony:ready` with `symphony:running`
2. Create or reuse a local workspace under `./.tmp/workspaces/`
3. Create branch `symphony/<issue-number>`
4. Have the worker draft the technical plan and stop at the human review station unless plan approval is waived
5. Run Codex implementation work from the approved or waived plan
6. Push the branch
7. Open a PR against `main`
8. Keep polling that PR for CI and automated review state
9. Push follow-up commits on the same branch until the PR is actually clean

If the PR reaches a clean merge-ready state, Symphony will comment on the issue and close it.

If the run fails, Symphony will either retry it in the running loop or mark it `symphony:failed`.

### 6. Review and merge the PR

Symphony owns the local PR follow-through loop:

- Wait for CI and automated review checks
- Detect actionable review feedback
- Push follow-up commits when the PR needs more work
- Stop only when the PR is actually clean

Human merge remains a separate repository action once the PR is ready.

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
