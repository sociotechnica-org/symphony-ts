# symphony-ts

A local-first factory orchestrator that turns GitHub issues into pull requests — and lets you see the whole assembly line.

Symphony polls your issue tracker, claims work, spins up AI coding agents, supervises their runs, and follows through on CI failures and review feedback until the PR is landed. Your entire factory configuration lives in a single `WORKFLOW.md` file. No hosted infrastructure, no centralized state, no complexity.

## Why Symphony?

Running one AI coding agent in a terminal is manageable. Running a dozen across different issues, branches, and PRs is a coordination problem. There's no single pane of glass — you end up babysitting tickets, checking what's running, what's stuck, what succeeded, which issues opened PRs.

OpenAI released [the Symphony spec](https://github.com/openai/symphony) to address this ([background](https://openai.com/index/harness-engineering/)). It nails the right abstraction layers: policy, coordination, execution. But the reference implementation isn't accepting contributions. So we rebuilt it in TypeScript.

**What makes symphony-ts different:**

- **Runs locally.** Point it at a repo and it starts working issues. No servers to deploy, no accounts to create.
- **Adapter pattern for everything.** Pluggable trackers (GitHub and Linear) and a provider-neutral runner contract with a local Codex adapter today, remote workers planned. Swap any layer without touching the others.
- **State lives in the tracker.** The entire factory state — what's in progress, what's done, what failed — lives in your tracker (GitHub Issues or Linear) instead of a separate control plane. Today's bootstrap runtime is designed for one local factory instance; broader multi-instance coordination is planned.
- **Visibility.** The tracker gives you real-time visibility into the whole factory. A local status surface shows worker-level detail.
- **It builds itself.** Symphony works `symphony-ts` issues and opens PRs back into this repo. The [self-hosting loop](docs/guides/self-hosting-loop.md) is how we develop it.

## Quick Start

**Prerequisites:** Node.js 20+, `pnpm`, `git`, [`gh`](https://cli.github.com/) (authenticated), and at least one supported local runner installed: [`codex`](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

```bash
git clone https://github.com/sociotechnica-org/symphony-ts.git
cd symphony-ts
pnpm install
```

Your target repo needs three labels: `symphony:ready`, `symphony:running`, `symphony:failed`.

**Before running**, set `tracker.repo` in `WORKFLOW.md` to the GitHub repository you want Symphony to work against (e.g. `your-org/your-repo`). The checked-in default is blank — Symphony will refuse to start without it. You can also set the `SYMPHONY_REPO` environment variable instead:

```bash
export SYMPHONY_REPO=your-org/your-repo
```

See [Configuration](#configuration) for all available fields.

Run one poll cycle:

```bash
pnpm tsx bin/symphony.ts run --once
```

Run continuously:

```bash
pnpm tsx bin/symphony.ts run
```

Check factory status:

```bash
pnpm tsx bin/symphony.ts status          # terminal view
pnpm tsx bin/symphony.ts status --json   # machine-readable
```

Control the local detached factory runtime from the repo root:

```bash
pnpm tsx bin/symphony.ts factory start
pnpm tsx bin/symphony.ts factory status
pnpm tsx bin/symphony.ts factory restart
pnpm tsx bin/symphony.ts factory stop
```

These commands target the checked-out runtime under `.tmp/factory-main`, so the
operator no longer needs to `cd` into the runtime checkout or manually combine
`screen` with `pkill` cleanup.

The status snapshot includes normalized runner visibility for active issues,
including worker state, current phase, session identity, heartbeat/action
timestamps, waiting reason, and condensed output/error summaries.

Generate a per-issue report from local artifacts:

```bash
pnpm tsx bin/symphony-report.ts issue --issue 44
```

Generate a campaign digest from existing per-issue reports:

```bash
pnpm tsx bin/symphony-report.ts campaign --issues 32,43,44
pnpm tsx bin/symphony-report.ts campaign --from 2026-03-01 --to 2026-03-07
```

When available, the report command also applies optional built-in runner-log
enrichment. Today that means Codex JSONL sessions under `~/.codex/sessions/`.
Missing, malformed, or ambiguous runner logs do not block report generation;
the report stays partial and keeps the canonical local artifacts as the source
of truth.

Publish one generated issue report into a checked-out `factory-runs` archive
worktree:

```bash
pnpm tsx bin/symphony-report.ts publish --issue 44 --archive-root ../factory-runs
```

Archive publication stays detached from `symphony run` and `symphony-ts` CI. It
copies the already-canonical local `report.json`, `report.md`, and available
session logs into:

```text
<factory-runs-root>/
  symphony-ts/
    issues/
      <issue-number>/
        <publication-id>/
          report.json
          report.md
          metadata.json
          logs/
```

If publication fails, the local artifacts under `.var/factory/...` and
`.var/reports/...` remain the source of truth.

Campaign digests stay detached from archive publication and are generated only
from existing issue reports. They are written under:

```text
.var/reports/campaigns/<campaign-id>/
  summary.md
  timeline.md
  github-activity.md
  token-usage.md
  learnings.md
```

## How It Works

1. An issue gets the `symphony:ready` label
2. Symphony claims it, swaps the label to `symphony:running`
3. Symphony prepares branch `symphony/<issue-number>` in an isolated local workspace
4. The agent drafts a technical plan and stops at a **human review station** (unless waived)
5. After plan approval, the agent implements the issue and opens a PR
6. Symphony monitors CI and automated review feedback on the PR
7. If CI fails or reviewers request changes, the agent pushes follow-up commits on the same branch
8. When the PR is clean, Symphony waits for an explicit human landing signal such as a `/land` PR comment
9. Symphony executes the landing path and comments on the issue and closes it only after merge is actually observed

If a run fails, Symphony retries. After retries are exhausted, it marks the issue `symphony:failed`.

Active run ownership is persisted locally. On restart, Symphony reconciles `symphony:running` issues against local state, recovers orphaned runs, and resumes or fails them cleanly. Per-issue reporting artifacts are written to `.var/factory/issues/` so they survive workspace cleanup. Generated per-issue reports are written under `.var/reports/issues/<issue-number>/` when the report command is run.

## Configuration

Everything is configured in `WORKFLOW.md` — YAML front matter for the runtime, a [Liquid](https://liquidjs.com/) template for the agent prompt:

```yaml
tracker:
  kind: github-bootstrap
  repo: your-org/your-repo
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed

polling:
  interval_ms: 30000
  max_concurrent_runs: 1

workspace:
  root: ./.tmp/workspaces
  repo_url: git@github.com:your-org/your-repo.git
  branch_prefix: symphony/

agent:
  runner:
    kind: codex
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

| Field                          | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `tracker.repo`                 | GitHub repository to poll for labeled issues                                 |
| `tracker.review_bot_logins`    | PR comment authors treated as actionable bot review                          |
| `polling.interval_ms`          | How often to check for new work                                              |
| `polling.max_concurrent_runs`  | Local concurrency cap                                                        |
| `workspace.root`               | Where isolated workspaces are created                                        |
| `workspace.repo_url`           | SSH or HTTPS URL of the repository cloned for each workspace                 |
| `workspace.branch_prefix`      | Issue branch naming prefix                                                   |
| `agent.runner.kind`            | Selects the execution backend (`codex`, `claude-code`, or `generic-command`) |
| `agent.command`                | Runner command shape; Codex reuses its flags to launch `codex app-server`    |
| `agent.prompt_transport`       | Sends the prompt over `stdin` or via a temp file path                        |
| `agent.timeout_ms`             | Max wall-clock time per runner turn                                          |
| `agent.max_turns`              | Max in-process continuation turns per worker run                             |
| `workspace.cleanup_on_success` | Remove local workspace after a successful run (default `true`)               |

`agent.timeout_ms` applies to each runner turn. If `agent.max_turns` is greater
than `1`, a single worker run can consume multiple per-turn timeout windows
before it exits.

`agent.runner.kind` keeps backend selection in `WORKFLOW.md`. Use `codex` for
the built-in long-lived Codex app-server path, `claude-code` for the first-class
Claude Code adapter, or `generic-command` to launch another local CLI through
the same orchestrator path:

```yaml
agent:
  runner:
    kind: claude-code
  command: claude -p --output-format json --permission-mode bypassPermissions --model sonnet
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

For `agent.runner.kind: codex`, Symphony now starts one `codex app-server`
subprocess per worker run and reuses a single Codex thread across continuation
turns. Keep `agent.command` in the familiar `codex exec ...` shape; Symphony
derives the app-server launch plus thread defaults such as model, sandbox, and
approval policy from that command instead of shelling out with `codex exec resume`.

The Claude Code adapter expects a headless JSON command shape so Symphony can
capture `session_id` for continuation turns and status artifacts. Keep these
constraints in `WORKFLOW.md`:

- use `claude -p` / `claude --print`
- include `--output-format json`
- use non-interactive permissions such as `--permission-mode bypassPermissions`
  or `--dangerously-skip-permissions`
- keep `agent.prompt_transport: stdin`
- do not bake `--resume`, `--continue`, `--session-id`, or a prompt argument
  into `agent.command`; the runner owns those continuation details

Use `generic-command` when you want raw subprocess execution without
Claude-specific session semantics:

```yaml
agent:
  runner:
    kind: generic-command
  command: claude --print
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

The prompt template below the YAML front matter uses Liquid syntax with access to `issue`, `config`, and `pull_request` variables. See the checked-in [`WORKFLOW.md`](WORKFLOW.md) for the full template.

### Linear Tracker

Symphony also supports Linear as a tracker. Set `tracker.kind: linear` in your `WORKFLOW.md`:

```yaml
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: symphony-0c79b11b75ea
  assignee: $LINEAR_ASSIGNEE
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
```

The current Linear slice supports:

- project-scoped GraphQL polling
- paginated issue reads
- issue comment writes
- a Symphony-owned workpad section in the issue description
- active-to-terminal state transitions through the tracker edge

For workflow recovery, the Linear adapter treats the issue workflow state as the primary handoff signal and uses the ticket conversation plus the Symphony-owned workpad as recovery hints:

- `Human Review` maps to `awaiting-human-handoff`
- `Rework` maps to `actionable-follow-up`
- `Merging` maps to `awaiting-system-checks`
- configured terminal states such as `Done` map to `handoff-ready`

The workpad keeps branch and run context durable on the Linear issue, but it is not the only source of truth. A fresh factory can recover the current handoff meaning from Linear workflow state plus repo-owned review markers in ticket comments.

Integration tests use a mock Linear GraphQL server under `tests/support/mock-linear-server.ts`, so no real Linear workspace is required to run the test suite.

## Architecture

Symphony follows the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) abstraction levels:

| Spec Layer    | Implementation                                            | Swappable?                                         |
| ------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Policy        | `WORKFLOW.md`, issue plans, repo guidance                 | Yes — edit the workflow file                       |
| Configuration | `src/config/` — YAML + Liquid parsing                     | —                                                  |
| Coordination  | `src/orchestrator/` — polling, retries, reconciliation    | —                                                  |
| Execution     | `src/runner/` + `src/workspace/` — agent subprocess + git | Yes — change `agent.runner.kind` / `agent.command` |
| Integration   | `src/tracker/` — GitHub and Linear adapters               | Yes — implement a new tracker adapter              |
| Observability | `src/observability/` — structured logs + status           | —                                                  |

### Repository Map

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
  tracker/                   GitHub and Linear tracker adapters
  workspace/                 Local git workspace management
tests/
  unit/                      Small contract tests
  integration/               Adapter and fixture tests
  e2e/                       Full mock-GitHub runtime tests
docs/
  architecture.md            Layer boundaries
  golden-principles.md       Implementation rules
  guides/                    How-to guides for operators
  plans/                     Issue-specific implementation plans
  adrs/                      Architecture decision records
```

### Technical Plan Review Station

Before substantial implementation begins, the workflow requires a human review station for technical plans:

1. The agent writes `docs/plans/<issue-number>-<task-name>/plan.md`
2. The agent commits that reviewed `plan.md`, pushes the issue branch, and posts a `plan-ready` issue comment with direct GitHub links to the branch and plan file
3. If human feedback requests changes, the agent revises the plan and posts another `plan-ready` summary
4. Coding begins only after the plan is approved or explicitly waived with instructions not to wait

This uses issue comments plus the pushed issue branch as the canonical review surface. It does not require a dashboard or tracker-specific approval subsystem. If plan approval is waived, the agent proceeds directly to implementation.

## Development

```bash
pnpm install              # install dependencies
pnpm format:check         # check formatting
pnpm lint                 # lint
pnpm typecheck            # type-check
pnpm test                 # run tests
```

```bash
pnpm dev                  # watch mode
pnpm build                # compile
```

Tests run in three layers: unit tests for pure logic, integration tests for adapters and fixtures, and end-to-end tests against an in-process mock GitHub server with a real temporary git remote.

## Status & Roadmap

**Current phase: 1.2** — single local instance, GitHub Issues and Linear trackers, local Codex runner.

What works today:

- Full issue lifecycle from ready through landed PR
- GitHub Issues and Linear tracker adapters
- Plan review station with human approval gate
- CI and automated review follow-up loop
- Orphaned run recovery on restart
- Local factory status surface and per-issue reporting
- Self-hosting: Symphony builds itself

What's planned:

- Remote worker backends (Devin, NiteShift, remote dev boxes)
- Multi-instance coordination
- Operator agent for factory-level oversight
- Dashboard UI beyond terminal status

## Documentation

- [Architecture](docs/architecture.md) — layer boundaries and spec mapping
- [Golden Principles](docs/golden-principles.md) — implementation rules
- [AGENTS.md](AGENTS.md) — guidance for AI agents working in this repo
- [Self-Hosting Loop](docs/guides/self-hosting-loop.md) — how Symphony builds itself
- [Plans](docs/plans/) — issue-specific implementation plans
- [ADRs](docs/adrs/) — architecture decision records

## References

- [Symphony spec](https://github.com/openai/symphony) ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md))
- [Harness Engineering](https://openai.com/index/harness-engineering/) — OpenAI's post on the approach
