---
name: fix-ci
description: Monitor a GitHub pull request's CI until it completes using a deterministic script, then report whether the checks passed or failed. Use this when you want `/fix-ci` style PR check monitoring instead of an LLM-driven watch loop.
---

# fix-ci

Use this skill when you need to wait for GitHub PR checks to finish without relying on an LLM watch loop.

## What it does

- Polls GitHub PR checks with `gh pr view`.
- Waits until all checks are complete.
- Exits `0` when all checks succeed or are neutral/skipped.
- Exits `1` when any completed check fails.
- Exits `2` on timeout.

## How to use it

Run the script:

```bash
node skills/fix-ci/scripts/fix-ci.mjs --pr 17
```

Useful options:

- `--pr <number>`: PR number to watch. If omitted, the script resolves the PR from the current branch.
- `--repo <owner/name>`: GitHub repo override.
- `--interval <seconds>`: Poll interval. Default: `15`.
- `--timeout <seconds>`: Max wait time. Default: `1800`.
- `--once`: Print the current status once and exit immediately.

## Operator use

- Prefer this script over ad hoc manual polling when the task is "wait for CI/review checks to finish."
- If the script exits non-zero because checks failed, inspect the failing checks and fix the PR in the normal branch -> QA -> push loop.
- If the script times out, treat that as an external blocker and inspect the stuck check directly.
