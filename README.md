# symphony-ts

A local-first factory orchestrator that turns GitHub issues into pull requests — and lets you see the whole assembly line.

Symphony polls your issue tracker, claims work, spins up AI coding agents, supervises their runs, and follows through on CI failures and review feedback until the PR is landed. Your entire factory configuration lives in a single `WORKFLOW.md` file. No hosted infrastructure, no centralized state, no complexity.

## Why Symphony?

Running one AI coding agent in a terminal is manageable. Running a dozen across different issues, branches, and PRs is a coordination problem. There's no single pane of glass — you end up babysitting tickets, checking what's running, what's stuck, what succeeded, which issues opened PRs.

OpenAI released [the Symphony spec](https://github.com/openai/symphony) to address this ([background](https://openai.com/index/harness-engineering/)). It nails the right abstraction layers: policy, coordination, execution. But the reference implementation isn't accepting contributions. So we rebuilt it in TypeScript.

**What makes symphony-ts different:**

- **Runs locally.** Point it at a repo and it starts working issues. No servers to deploy, no accounts to create.
- **Adapter pattern for everything.** Pluggable trackers (GitHub and Linear) plus a runner contract that separates provider identity from execution transport. Built-in `codex`, `claude-code`, and `generic-command` adapters stay local today; remote workers can land against the same contract later. Swap any layer without touching the others.
  The `codex` adapter now treats `codex app-server` as its primary structured transport boundary for startup, continuation turns, approvals, streaming events, and shutdown.
  Codex app-server sessions now also advertise one first-party dynamic tool, `tracker_current_context`, which returns sanitized current issue and PR context through Symphony's runner/tracker boundary instead of shell affordances.
- **State lives in the tracker.** The entire factory state — what's in progress, what's done, what failed — lives in your tracker (GitHub Issues or Linear) instead of a separate control plane. Today's bootstrap runtime is designed for one local factory instance; broader multi-instance coordination is planned.
- **Each `WORKFLOW.md` owns one local instance.** The repository containing `WORKFLOW.md` is the instance root. Its `.tmp/`, `.var/`, and detached runtime checkout under `.tmp/factory-main` belong to that instance, so one engine checkout can operate against many target repositories without sharing local runtime state.
- **Visibility.** The tracker gives you real-time visibility into the whole factory. A local status surface shows worker-level detail.
- **It builds itself.** Symphony works `symphony-ts` issues and opens PRs back into this repo. The [self-hosting loop](docs/guides/self-hosting-loop.md) is how we develop it.

## Quick Start

**Prerequisites:** Node.js 20+, `pnpm`, `git`, [`gh`](https://cli.github.com/) (authenticated), and at least one supported local runner installed: [`codex`](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

```bash
git clone https://github.com/sociotechnica-org/symphony-ts.git
cd symphony-ts
pnpm install
```

To scaffold a project-local Symphony instance inside another repository from
this engine checkout, run:

```bash
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo
```

`symphony init` scaffolds both `WORKFLOW.md` and `OPERATOR.md`.
Use `--runner claude-code` or `--runner generic-command` to change the starter
runner, and use `--force` to replace existing scaffolded files. You can also
target an explicit workflow path instead of a repository directory:

```bash
pnpm tsx bin/symphony.ts init ../target-repo/WORKFLOW.md --tracker-repo your-org/your-repo
```

The checked-in root [`WORKFLOW.md`](WORKFLOW.md) and
[`OPERATOR.md`](OPERATOR.md) are the self-hosting contracts for
`symphony-ts`; do not copy them blindly into unrelated repositories. Review
and customize the scaffolded target-repo `WORKFLOW.md` and `OPERATOR.md` for
that repository's prompt, checks, runtime policy, and operator policy before
running agents.
That checked-in self-hosting workflow already sets
`tracker.repo: sociotechnica-org/symphony-ts`, so the repo-owned operator path
does not require a shell-level `SYMPHONY_REPO` export.

Your target repo needs three labels: `symphony:ready`, `symphony:running`, `symphony:failed`.

If you are writing `WORKFLOW.md` manually instead of using `symphony init`,
set `tracker.repo` to the GitHub repository you want Symphony to work against
(for example `your-org/your-repo`). Symphony will refuse to start without it.
Consider checking in `OPERATOR.md` alongside that workflow so repo-specific
operator policy lives in the repository instead of only in global tooling.
You can also set the `SYMPHONY_REPO` environment variable instead:

```bash
export SYMPHONY_REPO=your-org/your-repo
```

See [Configuration](#configuration) for all available fields.
Repositories that use the technical-plan review station can override the
comment markers, metadata labels, guidance text, and reply-template block via
`tracker.plan_review`; omitting that section preserves Symphony's current
`Plan status: plan-ready` and `Plan review: ...` protocol.

For deeper docs, use:

- [Workflow Guide](docs/guides/workflow-guide.md) for workflow design,
  runtime constraints, handoff stations, and examples
- [WORKFLOW Frontmatter Reference](docs/guides/workflow-frontmatter-reference.md)
  for the exhaustive YAML frontmatter contract

The repository containing that `WORKFLOW.md` is the local Symphony instance root. Relative runtime paths such as `workspace.root: ./.tmp/workspaces` resolve from that owning repository, and Symphony keeps instance-local artifacts under that same repository's `.tmp/` and `.var/` trees.

Run one poll cycle:

```bash
pnpm tsx bin/symphony.ts run --once --workflow ../target-repo/WORKFLOW.md
```

Startup preparation now runs on this mainline `run` path. Do not use or
invent a separate "safe" wrapper entrypoint for GitHub bootstrap hardening.

Run continuously:

```bash
pnpm tsx bin/symphony.ts run --workflow ../target-repo/WORKFLOW.md
```

Check the workflow-derived status snapshot:

```bash
pnpm tsx bin/symphony.ts status --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts status --json --workflow ../target-repo/WORKFLOW.md
```

Control or inspect the local detached factory runtime from the engine checkout:

```bash
pnpm tsx bin/symphony.ts factory start --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory watch --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory attach --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory pause --reason "Prerequisite ticket failed; stop the line." --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory resume --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --json --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory restart --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory stop --workflow ../target-repo/WORKFLOW.md
```

When you are already inside the target instance root, the same commands may
omit `--workflow` and use the local `WORKFLOW.md` by default.

`factory start` launches the same startup-preparation path as `symphony run`
and surfaces startup preparation/failure details through `factory status`
instead of relying on a separate wrapper command.
Use `factory pause --reason ...` when operators need to stop the line without
forgetting why. That halt is instance-owned durable runtime state under
`.var/factory/`, survives `factory stop` / `factory start`, and requires an
explicit `factory resume` before new work dispatches again.

For the canonical detached-runtime operating procedure and failure rehearsals,
see [Operator Runbook](docs/guides/operator-runbook.md) and
[Failure Drills](docs/guides/failure-drills.md).

These commands target the checked-out runtime under
`<instance-root>/.tmp/factory-main` whenever that checkout is launchable.
When it is absent during bootstrap, detached control falls back to the
invoking source checkout instead of silently pretending the runtime checkout
was current. Use `status` when you want the raw runtime snapshot for a
specific workflow path, and use `factory status` when you want the detached
runtime control state plus the embedded status snapshot. Operators should
generally start with `factory status`, then use `factory watch` for continuous
monitoring and `factory attach` when they need the full-screen TUI for a
detached instance.

The supported detached control path now normalizes the launched runtime to an
installed UTF-8 locale and starts GNU Screen with `-U`. If the host does not
provide any usable UTF-8 locale, `factory start` / `factory restart` fail
clearly instead of silently launching a mojibake-prone TUI.

For detached monitoring, do not use raw `screen -r <instance-session-name>` as
the normal watch path. Attaching that way gives your terminal the worker's
foreground signal boundary, so an accidental `Ctrl-C` can stop the factory.
Use `factory attach` instead when you need the full graphical TUI for a
detached instance; it keeps `Ctrl-C` scoped to the foreground attach client.
On macOS, `factory attach` now builds a small local PTY helper the first time
it runs so the brokered attach path can keep owning `Ctrl-C`; if no local `cc`
compiler is available, the command fails clearly instead of falling back to an
unsafe raw attach.
The attach client now also normalizes the child `TERM` locally when the
operator shell exports an empty or Screen-incompatible value, including known
long names such as `rxvt-unicode-256color`, so operators do not need to wrap
the command in a manual `TERM=...` override and the detached runtime
environment stays unchanged.

The status snapshot includes normalized runner visibility for active issues,
including worker state, current phase, provider identity, execution transport,
session identity, heartbeat/action timestamps, waiting reason, and condensed
output/error summaries.
It also projects the current ready-queue order with normalized queue-priority
rank/label facts so operators can see which ready issue would dispatch next and
when Symphony fell back to deterministic issue-number ordering.
Status surfaces now also publish a runtime checkout identity for the live
factory code, including the runtime checkout path, `HEAD` commit SHA, commit
timestamp, and dirty-state summary when git metadata is available. This
describes the running runtime checkout (for detached control, `.tmp/factory-main`),
not whatever commit your operator checkout currently has checked out.
Status surfaces now also distinguish snapshot freshness explicitly:
`fresh` for the live worker, `stale` for leftover historical snapshots, and
`unavailable` while startup is still publishing a current snapshot or no
readable snapshot exists.

For the repo's operator-assisted self-hosting loop, use the versioned operator
entry point instead of any local `.ralph/` script:

```bash
pnpm operator        # continuous wake-up loop
pnpm operator:once   # single operator wake-up cycle
pnpm operator -- --workflow ../target-repo/WORKFLOW.md
pnpm operator -- --provider codex --model gpt-5.4-mini
pnpm operator -- --provider claude
pnpm operator -- --provider codex --model gpt-5.4-mini --resume-session
```

The checked-in loop lives under `skills/symphony-operator/`. `.ralph/` remains
local/generated-only for per-instance standing context, append-only wake-up
history, loop status, logs, and lock files under
`.ralph/instances/<instance-key>/`, including the
machine-readable completed-run review ledger `report-review-state.json`.
The same state root now also carries `control-state.json`, the generated
checkpoint snapshot that the operator prompt reads instead of restating the
entire wake-up algorithm.
The same operator state root now also carries `release-state.json`, the typed
record of configured release dependencies plus the current blocked or clear
release-advancement posture for that instance.
When resumable operator sessions are enabled, the same state root also carries
`operator-session.json`, the typed instance-local record of the reusable
backend session id plus the provider/model/command fingerprint it is compatible
with.
Operator wake-ups now inspect that ledger before ordinary queue advancement so
completed-run report findings are turned into tracked follow-up work promptly.
The current entry point requires a Unix-like shell environment such as macOS,
Linux, or WSL/Git Bash on Windows.
The same wake-up path now also runs a dependency-aware ready promoter for
GitHub-backed release DAGs. It reads the canonical operator-local
`release-state.json` dependency graph, computes which downstream issues are
currently eligible, and records the resulting eligible set plus any added or
removed `symphony:ready` labels back into that same typed artifact.
Use `--provider` and `--model` for the normal harness-selection path,
`--resume-session` or `--infinite-session` to reuse a compatible provider
session across wake-ups, and `--operator-command` or
`SYMPHONY_OPERATOR_COMMAND` only as the raw-command escape hatch. Operator
status artifacts now expose the resolved provider, model, command source,
effective command, and session mode/reset reason.
When the operator loop targets an external repository with `--workflow`, treat
that selected instance repository as the owner of plan-review standards and
repo policy. The `symphony-ts` checkout supplies operator tooling and local
state, but plan review and operator policy should read the selected
repository's `OPERATOR.md`, `WORKFLOW.md`, `AGENTS.md`, `README.md`, and
relevant docs when they exist instead of implicitly importing `symphony-ts`
architecture rules.

Generate a per-issue report from local artifacts:

```bash
pnpm tsx bin/symphony-report.ts issue --issue 44
```

Symphony now runs this generation step automatically after a terminal issue
outcome is recorded. Successful runs generate reports after merge is observed;
failed runs generate reports after the terminal failure is recorded. The manual
command remains available for ad hoc regeneration.

Inspect pending completed-run report reviews for the selected operator
instance:

```bash
pnpm tsx bin/symphony-report.ts review-pending --operator-repo-root . --json
pnpm tsx bin/symphony-report.ts review-pending --workflow ../target-repo/WORKFLOW.md --operator-repo-root /path/to/operator-checkout --json
```

Record that a completed report was reviewed with no follow-up issue:

```bash
pnpm tsx bin/symphony-report.ts review-record --issue 44 --status reviewed-no-follow-up --summary "Reviewed the completed run report; no tracked follow-up was needed."
```

File a GitHub follow-up issue from a report finding and persist the linkage in
the operator review ledger:

```bash
pnpm tsx bin/symphony-report.ts review-follow-up --issue 44 --title "Capture missing merge and close facts in issue reports" --body-file /tmp/finding.md --summary "Filed a follow-up issue for the report finding."
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

Canonical session artifacts now persist any backend-provided runner-event token
and cost facts that Symphony observed live. Reports and status surfaces project
those canonical facts first and stay explicit about partial or unavailable
accounting when a backend does not emit them.
When explicit backend cost is missing, issue-report generation now applies
checked-in provider pricing for supported models once stored session token
detail is sufficient; explicit backend cost facts still remain authoritative.

Publish one generated issue report into a checked-out `factory-runs` archive
worktree:

```bash
pnpm tsx bin/symphony-report.ts publish --issue 44 --archive-root ../factory-runs
```

If `WORKFLOW.md` sets `observability.issue_reports.archive_root`, Symphony also
attempts this publication step automatically after each terminal run. Local
artifacts remain canonical if archive publication is blocked or partial.
When the generated report already identified matched local raw runner logs
such as Codex JSONL session files, archive publication now preserves that raw
evidence by default even if canonical artifact `logPointers` were empty.

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
3. Symphony prepares branch `symphony/<issue-number>` in an isolated execution workspace (today a local checkout, later also a remote target seam)
4. The agent drafts a technical plan and stops at a **human review station** (unless waived)
5. After plan approval, the agent implements the issue and opens a PR ready for review by default unless repository policy explicitly calls for draft mode
6. Symphony monitors CI and automated review feedback on the PR
7. If CI fails or reviewers request changes, the agent pushes follow-up commits on the same branch
8. When the PR is clean and at least one configured approved reviewer bot has produced output on the current head, Symphony waits for an explicit human landing signal such as a `/land` PR comment
9. Symphony executes a guarded landing path that re-checks mergeability, required checks, required approved bot review presence, and unresolved review threads before merge
10. Symphony comments on the issue and closes it only after merge is actually observed

If expected reviewer apps are configured and never produce qualifying output on the current head after checks settle, Symphony treats that as degraded external infrastructure rather than a normal review-clean wait state.

If a run fails, Symphony retries. After retries are exhausted, it marks the issue `symphony:failed`.

Active run ownership is persisted locally as a transport-aware execution-owner record. On restart, Symphony reconciles `symphony:running` issues against local state, recovers orphaned runs, and resumes or fails them cleanly without assuming every execution owns a local runner PID. Per-issue reporting artifacts are written to `.var/factory/issues/` so they survive workspace cleanup. Symphony records automatic report-generation/publication receipts in `.var/factory/issues/<issue-number>/terminal-reporting.json` and writes generated per-issue reports under `.var/reports/issues/<issue-number>/`.
Those paths are instance-owned: for any given run they live under the repository that owns the active `WORKFLOW.md`, not under a shared engine-global temp root.

## Configuration

Everything is configured in `WORKFLOW.md` — YAML front matter for the runtime, a [Liquid](https://liquidjs.com/) template for the agent prompt:

Use this section for the common options. For the full parser-aligned frontmatter
contract, defaults, constraints, and examples, see
[WORKFLOW Frontmatter Reference](docs/guides/workflow-frontmatter-reference.md).

For narrative guidance about how to shape workflows, multi-role prompt
patterns, handoff stations, and current runtime constraints, see
[Workflow Guide](docs/guides/workflow-guide.md).

```yaml
tracker:
  kind: github
  repo: your-org/your-repo
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  review_bot_logins:
    - greptile[bot]
    - bugbot[bot]
  approved_review_bot_logins:
    - greptile[bot]
    - bugbot[bot]
  reviewer_apps:
    devin:
      accepted: true
      required: true
  respect_blocked_relationships: true
  queue_priority:
    enabled: true
    project_number: 12
    field_name: Priority
    option_rank_map:
      P0: 0
      P1: 1

polling:
  interval_ms: 30000
  max_concurrent_runs: 1

workspace:
  root: ./.tmp/workspaces
  branch_prefix: symphony/
  retention:
    on_success: delete
    on_failure: retain
  worker_hosts:
    builder:
      ssh_destination: symphony@builder.example.com
      workspace_root: /var/tmp/symphony/workspaces

agent:
  runner:
    kind: codex
    remote_execution:
      kind: ssh
      worker_hosts:
        - builder
        - builder-b
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

`tracker.queue_priority` reserves a tracker-boundary contract for normalized
ready-work ordering metadata. For GitHub, Symphony can read one configured
Projects V2 field, normalize supported values into `issue.queuePriority`, and
keep missing, unset, unmapped, or unsupported project data as `null` so ready
work still falls back to deterministic issue-number ordering. The current
GitHub slice supports integer number fields directly plus single-select or text
fields when `option_rank_map` provides the rank mapping. For Linear, Symphony
can optionally normalize the native issue `priority` field into the same
contract when `tracker.queue_priority.enabled: true`; native `priority: 0`,
`null`, or disabled config still fall back to `queuePriority: null`.

`tracker.respect_blocked_relationships` is an optional GitHub-only dispatch
guard. When enabled, Symphony keeps using the ready label as the coarse gate,
but it also asks GitHub whether the issue currently has any open blocking
relationships and excludes blocked issues from dispatch. Claiming re-checks the
same fact to catch fetch/claim races. The default is `false`, which preserves
today's label-only behavior. Enabled mode fails closed if GitHub cannot return
the blocked-status fact. Older or feature-limited GitHub instances that do not
expose `issueDependenciesSummary` through GraphQL will also fail closed with a
message that points back to this toggle.

When multiple remote Codex worker hosts are configured, Symphony selects a host
at dispatch time, keeps continuation turns on that same host, and prefers the
previous host again on retry while it remains available. Status surfaces now
publish per-host occupancy plus preferred retry-host hints so no-host bottlenecks
are inspectable instead of looking like generic retry noise.

For the checked-in GitHub workflow prompt, tracker content is not passed
through uniformly. The prompt contract is:

- Trusted verbatim: issue identifier/number/title/URL/labels/state and
  normalized PR lifecycle metadata such as URL, branch, lifecycle summary, and
  check names.
- Summarized and sanitized: `issue.summary` and `feedback.summary`, which are
  repository-generated plain-text summaries derived from GitHub issue bodies
  and actionable automated review feedback.
- Excluded: raw GitHub issue body markdown/HTML, raw issue comments, raw
  review-comment bodies, and other GitHub-authored text not explicitly exposed
  by the prompt-facing context.

Workers should treat those summarized GitHub fields as untrusted context that
helps explain the task, not as instructions that can override checked-in repo
policy, code, docs, or local test evidence.

| Field                                | Purpose                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `tracker.repo`                       | GitHub repository to poll for labeled issues                                           |
| `tracker.review_bot_logins`          | PR comment authors treated as actionable bot review                                    |
| `tracker.approved_review_bot_logins` | Legacy reviewer-app identities whose current-head output must appear before landing    |
| `tracker.reviewer_apps`              | First-class reviewer-app policy with explicit `accepted` and `required` semantics      |
| `polling.interval_ms`                | How often to check for new work                                                        |
| `polling.max_concurrent_runs`        | Local concurrency cap                                                                  |
| `workspace.root`                     | Where isolated workspaces are created                                                  |
| `workspace.repo_url`                 | Explicit clone source URL or local path; local paths resolve relative to `WORKFLOW.md` |
| `workspace.branch_prefix`            | Issue branch naming prefix                                                             |
| `workspace.worker_hosts.<name>`      | Optional SSH worker-host definitions for remote Codex execution                        |
| `agent.runner.kind`                  | Selects the logical runner provider (`codex`, `claude-code`, or `generic-command`)     |
| `agent.runner.remote_execution`      | Optional remote execution selection for Codex (`kind: ssh`, `worker_host: <name>`)     |
| `agent.command`                      | Runner command shape; Codex reuses its flags to launch `codex app-server`              |
| `agent.prompt_transport`             | Sends the prompt over `stdin` or via a temp file path                                  |
| `agent.timeout_ms`                   | Max wall-clock time per runner turn                                                    |
| `agent.max_turns`                    | Max in-process continuation turns per worker run                                       |
| `workspace.retention.on_success`     | Terminal success workspace policy: `delete` or `retain` (default `delete`)             |
| `workspace.retention.on_failure`     | Terminal failure workspace policy: `delete` or `retain` (default `retain`)             |

`workspace.cleanup_on_success` remains accepted as a compatibility alias for
`workspace.retention.on_success`.

`agent.timeout_ms` applies to each runner turn. If `agent.max_turns` is greater
than `1`, a single worker run can consume multiple per-turn timeout windows
before it exits.

For `tracker.kind: github`, Symphony derives the workspace clone URL from
`tracker.repo` (or `SYMPHONY_REPO`) for the maintained GitHub backend. On
startup, GitHub-backed workflows create or refresh a local bare mirror under
`.tmp/github/upstream` and clone per-issue workspaces from that mirror instead
of hitting GitHub directly. `tracker.kind: github-bootstrap` remains supported
as a compatibility path for the self-hosting bootstrap flow and currently
shares the same runtime semantics. Set `workspace.repo_url` explicitly when you
want to override the derived source or when using a tracker/config path that
does not provide enough repository information on its own. Explicit local-path
`workspace.repo_url` values are resolved relative to the owning `WORKFLOW.md`.
Startup preparation now hands that mirror to the workspace layer as a typed
workspace-source override instead of rewriting the configured `workspace.repo_url`.

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

When `agent.runner.remote_execution.kind: ssh` is set, Symphony keeps the
orchestrator local but prepares the issue workspace on the selected
`workspace.worker_hosts.<name>` target and launches `codex app-server` through
one local `ssh` subprocess bound to that remote workspace. Remote Codex runs
currently require:

- `workspace.repo_url` to be a remote clone URL reachable from the worker host
- `agent.prompt_transport: stdin`
- one explicit `worker_host` selection per worker run

Example:

```yaml
workspace:
  root: ./.tmp/workspaces
  repo_url: git@github.com:your-org/your-repo.git
  branch_prefix: symphony/
  worker_hosts:
    builder:
      ssh_destination: symphony@builder.example.com
      workspace_root: /var/tmp/symphony/workspaces

agent:
  runner:
    kind: codex
    remote_execution:
      kind: ssh
      worker_host: builder
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

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
    provider: pi
    model: pi-pro
  command: pi --print
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

`provider` and `model` are optional repo-owned metadata for observability.
Use them when the command launches another backend such as Pi so status,
artifacts, and reports show a stable identity instead of the generic default.

The prompt template below the YAML front matter uses Liquid syntax with access
to `issue`, `config`, `lifecycle`, and `pull_request` variables. `lifecycle`
is available for any normalized tracker handoff state, including pre-PR states
such as approved plan-review resumes. `pull_request` stays PR-only so existing
templates can safely dereference PR fields. See the checked-in
[`WORKFLOW.md`](WORKFLOW.md) for the full template.

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
  runner/                    Local runner adapters and live session handling
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

This repository is in active construction, but the core local factory is already real. The table below is derived from the merged PR history in this repository and summarizes the capabilities that have actually landed so far.

| Capability                                                                                                                            | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Local end-to-end GitHub issue -> branch -> PR -> merge loop                                                                           | `done`   |
| Human plan-review station before substantial implementation                                                                           | `done`   |
| Follows through on CI failures and review feedback until a PR is ready to land                                                        | `done`   |
| Human-controlled landing flow for merge-ready PRs                                                                                     | `done`   |
| Restart recovery and watchdog handling for stuck or interrupted runs                                                                  | `done`   |
| Detached factory control CLI: `factory start`, `factory status`, `factory watch`, `factory attach`, `factory restart`, `factory stop` | `done`   |
| Status TUI with live runner/session context                                                                                           | `done`   |
| Per-issue reports from local runtime artifacts                                                                                        | `done`   |
| Campaign digest reporting across issues                                                                                               | `done`   |
| `factory-runs` archive publication for reports and logs                                                                               | `done`   |
| GitHub tracker adapter                                                                                                                | `done`   |
| Linear tracker adapter                                                                                                                | `done`   |
| Ready-queue prioritization from tracker metadata                                                                                      | `done`   |
| Generic command runner                                                                                                                | `done`   |
| Claude Code runner                                                                                                                    | `done`   |
| Codex runner                                                                                                                          | `done`   |
| Remote Codex execution over SSH                                                                                                       | `done`   |
| Multi-instance local factories from one Symphony engine checkout                                                                      | `done`   |
| Installed Symphony engine distribution support                                                                                        | `done`   |
| Self-hosting: Symphony works `symphony-ts` issues and opens PRs back here                                                             | `done`   |
| Beads tracker adapter and Beads workflow contract                                                                                     | `coming` |
| Detection/classification of stalled required checks instead of waiting forever                                                        | `coming` |
| Operator message injection into active or resumable worker sessions                                                                   | `coming` |
| Broader remote execution backends beyond current SSH Codex support                                                                    | `coming` |
| Automated QA review station and review-station pluggability                                                                           | `coming` |
| Context Library hook                                                                                                                  | `coming` |
| Molecule-aware dispatch                                                                                                               | `coming` |

The highest-signal roadmap items currently tracked in GitHub Issues are:

- [Phase 2: Beads Tracker Adapter + Beads Workflow Contract](https://github.com/sociotechnica-org/symphony-ts/issues/9)
- [Detect and classify stalled required checks instead of waiting forever](https://github.com/sociotechnica-org/symphony-ts/issues/221)
- [Support operator message injection into active or resumable worker sessions](https://github.com/sociotechnica-org/symphony-ts/issues/222)
- [Phase 8: Remote Execution Backends](https://github.com/sociotechnica-org/symphony-ts/issues/15)
- [Phase 1.3.5: Automated QA Review Station](https://github.com/sociotechnica-org/symphony-ts/issues/33)
- [Future: Automated Review Station Evaluation And Pluggability](https://github.com/sociotechnica-org/symphony-ts/issues/36)
- [Phase 5: Context Library Hook](https://github.com/sociotechnica-org/symphony-ts/issues/12)
- [Phase 4: Molecule-Aware Dispatch](https://github.com/sociotechnica-org/symphony-ts/issues/11)

For the repo-owned implementation record behind this evolving roadmap, see:

- [`docs/plans/035-bootstrap-factory/plan.md`](docs/plans/035-bootstrap-factory/plan.md)
- [`docs/plans/036-core-runtime-contracts/plan.md`](docs/plans/036-core-runtime-contracts/plan.md)

## Documentation

- [Architecture](docs/architecture.md) — layer boundaries and spec mapping
- [Golden Principles](docs/golden-principles.md) — implementation rules
- [AGENTS.md](AGENTS.md) — guidance for AI agents working in this repo
- [Operator Runbook](docs/guides/operator-runbook.md) — daily detached factory operation
- [Failure Drills](docs/guides/failure-drills.md) — restart, retry, watchdog, and stability rehearsal
- [Self-Hosting Loop](docs/guides/self-hosting-loop.md) — how Symphony builds itself
- [Plans](docs/plans/) — issue-specific implementation plans
- [ADRs](docs/adrs/) — architecture decision records

## References

- [Symphony spec](https://github.com/openai/symphony) ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md))
- [Harness Engineering](https://openai.com/index/harness-engineering/) — OpenAI's post on the approach
