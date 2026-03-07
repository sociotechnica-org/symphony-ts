# symphony-ts

TypeScript implementation of the [Symphony spec](https://github.com/openai/symphony).

## Status

Phase 1.2 is implemented.

Today, `symphony-ts` can:

- poll real GitHub issues labeled `symphony:ready`
- claim one of those issues locally
- create or reuse a deterministic per-issue git workspace
- run Codex against that workspace using the rendered `WORKFLOW.md` prompt
- supervise active local agent subprocesses and persist run ownership metadata
- observe the pull request associated with the issue branch
- wait for PR checks and automated review feedback after PR creation
- re-enter the same workspace branch when CI or review feedback needs follow-up
- recover orphaned `symphony:running` issues after local worker or agent loss
- close the issue only after the PR is merge-ready
- retry failed runs locally
- emit a local factory status snapshot and render it in the terminal

This is already being used to build `symphony-ts` itself.

## How It Works

The current runtime is a narrow vertical slice:

1. `bin/symphony.ts` starts the CLI.
2. `src/config/workflow.ts` loads and validates `WORKFLOW.md`.
3. `src/tracker/github-bootstrap.ts` polls GitHub and manages labels/comments/state.
4. `src/workspace/local.ts` clones and resets per-issue workspaces.
5. `src/runner/local.ts` launches Codex as a subprocess.
6. `src/orchestrator/service.ts` ties the loop together and supervises active local runs.

The default issue lifecycle is:

1. an issue gets the `symphony:ready` label
2. Symphony changes it to `symphony:running`
3. Symphony prepares branch `symphony/<issue-number>`
4. Codex implements the issue and opens a PR
5. Symphony keeps the issue in `symphony:running` while PR checks or review feedback are still in flight
6. Symphony re-enters the same branch if CI fails or actionable review feedback appears
7. Symphony comments on the issue and closes it only after the PR is green and review feedback is resolved

If a run fails, Symphony either:

- schedules a retry while keeping the issue in the in-flight factory loop, or
- marks it `symphony:failed` after retries are exhausted

Active run ownership is also persisted locally under the workspace root. On the
next startup or poll, Symphony reconciles `symphony:running` issues against
that local state, terminates orphaned local agent processes when needed, and
resumes or fails the issue from the runtime itself.

## Repository Map

```text
bin/
  symphony.ts                CLI entry point
src/
  cli/                       CLI wiring
  config/                    WORKFLOW.md parsing and prompt rendering
  domain/                    Shared runtime types and errors
  observability/             Structured logging
  orchestrator/              Polling, retries, dispatch
  runner/                    Codex subprocess execution
  tracker/                   GitHub bootstrap tracker
  workspace/                 Local git workspace management
tests/
  unit/                      Small contract tests
  integration/               Adapter and fixture tests
  e2e/                       Full mock-GitHub runtime tests
docs/
  architecture.md            Layer boundaries
  golden-principles.md       Implementation rules
  plans/                     Issue-specific implementation plans
  adrs/                      Architecture decision records
```

## Prerequisites

- Node.js 20+
- `pnpm`
- `git`
- `gh` authenticated against GitHub
- `codex` installed locally

You also need these labels in the target repository:

- `symphony:ready`
- `symphony:running`
- `symphony:failed`

## Quick Start

Install dependencies:

```bash
pnpm install
```

Run one poll cycle:

```bash
pnpm tsx bin/symphony.ts run --once
```

Run continuously:

```bash
pnpm tsx bin/symphony.ts run
```

Inspect the latest local factory status:

```bash
pnpm tsx bin/symphony.ts status
```

Print the machine-readable snapshot:

```bash
pnpm tsx bin/symphony.ts status --json
```

By default, the checked-in `WORKFLOW.md` targets:

- repo: `sociotechnica-org/symphony-ts`
- tracker: GitHub bootstrap adapter
- runner: local Codex CLI

## How to Use Symphony to Build Symphony

This is the recursive local setup: Symphony runs against the `symphony-ts` GitHub repo and works `symphony-ts` issues by opening PRs back to that same repo.

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

### 3. Create a real GitHub issue in `symphony-ts`

Open an issue in:

- <https://github.com/sociotechnica-org/symphony-ts/issues>

Describe the task normally. Then add the label:

- `symphony:ready`

That label is the dispatch signal.

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

During or after a run, Symphony writes the latest derived status snapshot to `.tmp/status.json`.
The `status` CLI reads that file and renders either a simple terminal view or the raw JSON contract
for future tooling.

### 5. Watch the issue lifecycle

When Symphony picks up the issue, it should:

1. replace `symphony:ready` with `symphony:running`
2. create or reuse a local workspace under `./.tmp/workspaces/`
3. create branch `symphony/<issue-number>`
4. run Codex with the rendered issue prompt
5. push the branch
6. open a PR against `main`
7. keep polling that PR for CI and automated review state
8. push follow-up commits on the same branch until the PR is actually clean

If the PR reaches a clean merge-ready state, Symphony will comment on the issue and close it.

If the run fails, Symphony will either:

- retry it in the running loop, or
- mark it `symphony:failed`

### 6. Review and merge the PR

Symphony now owns the local PR follow-through loop:

- wait for CI and automated review checks
- detect actionable review feedback
- push follow-up commits when the PR needs more work
- stop only when the PR is actually clean

Human merge remains a separate repository action once the PR is ready.

That merged PR becomes the new version of Symphony that will work the next issue.

### 7. Repeat

Create the next `symphony-ts` issue, label it `symphony:ready`, and run Symphony again.

That is the self-hosting loop:

1. Symphony works a `symphony-ts` issue
2. Symphony opens a PR into `symphony-ts`
3. the PR merges
4. the improved Symphony is used on the next `symphony-ts` issue

### Practical notes

- Run only one local Symphony instance against this repo at a time in Phase 0.
- If you want to inspect a failed run, set `workspace.cleanup_on_success: false` temporarily or inspect the workspace before the next retry.
- Use `--once` when you want tight control over one issue at a time.

## WORKFLOW.md

`WORKFLOW.md` is the runtime contract for a repository.

It contains:

- YAML front matter for tracker, polling, workspace, hooks, and agent config
- a Liquid template used to render the issue prompt

Key fields in the current workflow:

- `tracker.repo`: GitHub repository to poll
- `tracker.review_bot_logins`: PR comment authors whose feedback should be treated as actionable bot review
- `polling.interval_ms`: poll interval
- `polling.max_concurrent_runs`: local concurrency cap
- `workspace.root`: local workspace root
- `workspace.branch_prefix`: issue branch prefix
- `agent.command`: subprocess command used to run Codex

The checked-in default runner command is:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -
```

## Development

Install dependencies:

```bash
pnpm install
```

Run the full local gate:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Useful commands:

```bash
pnpm dev
pnpm build
```

## Testing Strategy

The repo uses three layers of verification:

- unit tests for pure config, logger, runner, and orchestrator behavior
- integration tests for GitHub adapter and CLI fixtures
- end-to-end tests that exercise the full runtime against an in-process mock GitHub server and a real temporary git remote

Phase 0 also includes real smoke testing against the live `sociotechnica-org/symphony-ts` repository.

## Current Constraints

- The Phase 0 GitHub bootstrap tracker is intended for a single local Symphony instance.
- Issue claiming is label-based and not atomic across multiple independent orchestrators.
- Remote execution backends are not implemented yet.
- Beads is not integrated yet.

## Documentation

Start here:

- [docs/architecture.md](docs/architecture.md)
- [docs/golden-principles.md](docs/golden-principles.md)
- [AGENTS.md](AGENTS.md)

Plans and ADRs live in:

- [`docs/plans/`](docs/plans/)
- [`docs/adrs/`](docs/adrs/)

## References

- Symphony spec: <https://github.com/openai/symphony>
- Symphony spec document: <https://github.com/openai/symphony/blob/main/SPEC.md>
- Harness Engineering post: <https://openai.com/index/harness-engineering/>
- Main project issue: <https://github.com/sociotechnica-org/company/issues/34>
- Phase 0 issue: <https://github.com/sociotechnica-org/company/issues/35>
- Beads: <https://github.com/steveyegge/beads>
- Context Library: <https://github.com/sociotechnica-org/context-library>
- Previous implementation attempt: <https://github.com/sociotechnica-org/symphony-ts-opus>
