---
name: fix-ci
description: Drive a GitHub pull request to a clean CI and review state using a deterministic detector plus an agent repair loop. Use this when you want `/fix-ci` style PR closure instead of an LLM-only watch loop.
---

# fix-ci

Use this skill when you need to drive a PR to a clean CI/review state without relying on an LLM-only watch loop.

## What it does

- Polls GitHub PR checks with `gh pr view`.
- Polls GitHub PR review threads with GraphQL.
- Waits until all checks are complete.
- Exits `0` when all checks succeed or are neutral/skipped.
- Exits `1` when any completed check fails or any unresolved non-outdated review thread remains.
- Exits `2` on timeout.

The script is the deterministic detector. The skill itself is the repair loop.

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

- Prefer this skill over ad hoc manual polling when the task is "get this PR clean."
- Run the script first to determine whether there is anything to fix.
- If the script exits `0`, the PR is clean from a CI/review-thread perspective.
- If the script exits `1`, do not stop at reporting:
  1. inspect the failing checks and unresolved review threads it surfaced,
  2. fix the branch,
  3. rerun local QA,
  4. push,
  5. rerun the script,
  6. repeat until it exits `0`.
- If the script times out, treat that as an external blocker and inspect the stuck check directly.

This skill is for closing the loop, not just observing it.
