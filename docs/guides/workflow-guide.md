# Workflow Guide

`WORKFLOW.md` is the repository-owned runtime contract for one Symphony factory
instance. It tells Symphony where work comes from, how to prepare workspaces,
which runner to use, and what the worker is expected to do once it starts.

This guide is broader than the README quick start and narrower than the full
parser reference. Use it when you want to design a workflow well, not just make
the YAML parse.

Use the companion reference for field-by-field detail:

- [WORKFLOW Frontmatter Reference](./workflow-frontmatter-reference.md)

## 1. Purpose

`WORKFLOW.md` exists so workflow behavior is checked in, reviewable, and owned
by the repository instead of being hidden in one operator's prompt history.

In practice, `WORKFLOW.md` answers five questions:

1. Where does work come from?
2. How does Symphony prepare a workspace for that work?
3. Which runner executes the work?
4. What instructions does the worker receive?
5. What counts as done for this repository?

That makes `WORKFLOW.md` the join point between repository policy and runtime
behavior:

- frontmatter configures the runtime surface
- the Markdown body becomes the initial worker prompt
- the combination defines one repeatable factory loop

If a behavior is required on every worker run or operator wake-up for this
repository, it should be visible in `WORKFLOW.md`, `AGENTS.md`,
`OPERATOR.md`, code, or tests, not only in operator memory.

## 2. Boundaries

`WORKFLOW.md` is important, but it is not the whole system. The cleanest
Symphony setups keep the following boundaries explicit.

| Surface           | Primary role                              | Put here                                                                                           | Keep out                                                                                  |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `WORKFLOW.md`     | Runtime contract for one factory instance | tracker selection, workspace and runner settings, prompt contract, repo-specific completion bar    | deep engineering policy, hidden operator habits, invariants that only code can guarantee  |
| `AGENTS.md`       | Enduring engineering policy               | design rules, testing bar, review expectations, architecture seams, implementation standards       | transport details, per-instance paths, tracker credentials, temporary operator notes      |
| `OPERATOR.md`     | Repo-owned operator policy                | landing expectations, release gates, post-merge refresh rules, escalation boundaries               | runtime invariants that code must enforce, tracker transport details, local scratch notes |
| repo-local skills | Specialized reusable method               | recurring task guides such as planning, operations, or recurring maintenance                       | rules that must apply to every run, correctness guarantees that should live in code       |
| code and tests    | Hard correctness guarantees               | parsing, state machines, retries, leases, guarded landing, failure handling, tracker normalization | repo policy that should stay repository-owned and editable without code changes           |

A useful rule of thumb:

- `WORKFLOW.md` says how this repository wants Symphony to run
- `AGENTS.md` says how this repository expects engineering work to be done
- `OPERATOR.md` says how this repository expects operators to land, refresh, and escalate
- skills say how to perform a recurring specialized task
- code and tests decide what the runtime actually guarantees

In `symphony-ts` itself, some behavior intentionally appears in more than one
place:

- the prompt requires the technical-plan review station
- `AGENTS.md` explains why that station exists
- tracker code understands the plan-review signals once they appear

That overlap is intentional. Prompts carry repository intent; code carries
runtime semantics.

## 3. File Structure

Every `WORKFLOW.md` has two parts:

1. YAML frontmatter
2. a Markdown prompt body

The basic shape looks like this:

```md
---
tracker:
  kind: github
  repo: your-org/your-repo
polling:
  interval_ms: 30000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
  branch_prefix: symphony/
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -
  prompt_transport: stdin
  timeout_ms: 5400000
  max_turns: 20
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.
```

The YAML is parsed and validated before the runtime starts. The body is not
just documentation; it is the prompt template used for turn 1 of each run.

### 3.1 YAML Frontmatter

The frontmatter is delimited by `---` markers and must parse to a valid YAML
mapping. It configures six top-level areas of factory behavior:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `observability`

Symphony parses the frontmatter at startup through the public workflow loader
at [src/config/workflow.ts](../../src/config/workflow.ts), which delegates the
file-reading, typed resolution, and prompt-building stages to focused modules
under `src/config/`.
If parsing or validation fails, the factory does not start.

### 3.2 Template Rendering

Symphony renders the body with Liquid in strict mode. Unknown variables and
unknown filters fail prompt rendering instead of silently producing broken
prompts.

The main template inputs are:

| Variable       | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `issue`        | normalized issue or work-item context                           |
| `lifecycle`    | normalized handoff lifecycle context, including non-PR handoffs |
| `pull_request` | PR-backed lifecycle context when a pull request exists          |
| `attempt`      | retry attempt number; `null` on the first attempt               |
| `config`       | resolved workflow config with secrets redacted where needed     |

Two nuances matter:

- `lifecycle` can exist even when no PR exists yet, such as plan-review
  handoff states.
- `pull_request` is a PR-only convenience view. If your workflow depends on
  PR data, use `pull_request`; if it depends on normalized handoff state more
  generally, use `lifecycle`.

Today, the injected issue and handoff context is intentionally narrow:

- issue identifiers, title, URL, labels, state, and a sanitized summary
- lifecycle kind, branch name, summary, and check state
- PR URL and branch metadata when a PR exists
- sanitized actionable review-feedback summaries

Raw tracker-authored bodies and comments are intentionally not injected into
the prompt.

## 4. Instance Model

One `WORKFLOW.md` defines one local Symphony instance.

That instance owns runtime state derived from the workflow path, including:

```text
<instance-root>/
  WORKFLOW.md
  .tmp/
    status.json
    startup.json
    factory-main/
    github/
      upstream/
    workspaces/
  .var/
    factory/
    reports/
```

The important distinction is:

- `workflowRoot` is the directory containing `WORKFLOW.md`
- `instanceRoot` is the owning runtime root for that workflow

In the common case, those are the same directory. Symphony also special-cases
detached runtime checkouts under `.tmp/factory-main/WORKFLOW.md` so they still
resolve back to the owning instance root instead of becoming a second instance
by accident.

### 4.1 Instance-Rooted Paths

The instance owns:

- `.tmp/` for transient runtime state
- `.tmp/status.json` for the current status snapshot
- `.tmp/startup.json` for startup-preparation state
- `.tmp/factory-main/` for the detached runtime checkout
- `.tmp/github/upstream/` for the GitHub local bare mirror when applicable
- `.var/factory/` for per-issue artifacts
- `.var/reports/` for generated issue and campaign reports
- `workspace.root` for prepared issue workspaces

These paths belong to the selected workflow instance. They do not become
engine-global state.

### 4.2 One Engine Checkout, Many Workflows

The simplest mental model is still:

- one repository
- one `WORKFLOW.md`
- one running factory

But the current runtime also supports one shared Symphony engine checkout
operating many different workflows by passing `--workflow`.

For example:

```bash
pnpm tsx bin/symphony.ts factory start --workflow /path/to/repo-a/WORKFLOW.md
pnpm tsx bin/symphony.ts factory start --workflow /path/to/repo-b/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --workflow /path/to/repo-a/WORKFLOW.md
```

That works because the instance-scoped runtime paths are derived from the
selected workflow, not from the engine checkout that launched the command.

### 4.3 Recommended Layouts

Three layouts work well today:

1. `WORKFLOW.md` checked into each target repository
2. a shared workflow-library directory, with one workflow per target repo
3. one engine checkout supervising several external repositories via explicit
   `--workflow` paths

The clearest default is still per-repository `WORKFLOW.md`. Shared engine usage
is useful, but only if each workflow has clearly separated instance roots,
workspace roots, and operator commands.

## 5. Frontmatter and Configuration Model

Think of the frontmatter as the runtime-facing half of the contract. It selects
the tracker, workspace model, runner, retry posture, and observability
settings. It does not define arbitrary workflow topology.

This guide summarizes the design intent of each section. For the full parser
contract, examples, and defaults, use the
[WORKFLOW Frontmatter Reference](./workflow-frontmatter-reference.md).

### 5.1 `tracker`

`tracker` selects one work source and one tracker adapter for the instance.

Supported tracker kinds today:

- `github`
- `github-bootstrap`
- `linear`

`github` and `github-bootstrap` share the same GitHub issue and PR lifecycle
semantics. The distinction mainly matters during bootstrap and startup
preparation, not in the steady-state handoff model.

Design implications:

- one workflow selects one tracker backend
- a single workflow does not combine GitHub and Linear
- tracker-specific lifecycle policy stays at the edge and is normalized into
  runtime handoff states

Important GitHub-specific fields:

- issue labels for ready, running, and failed
- `review_bot_logins`
- `approved_review_bot_logins`
- optional GitHub Projects queue-priority mapping

Important Linear-specific fields:

- project slug and API credentials
- assignee filter
- active states
- terminal states
- optional priority normalization from Linear issue priority

### 5.2 `polling`

`polling` controls how aggressively the orchestrator looks for work and how it
responds to failures.

It includes:

- poll interval
- maximum concurrent runs
- retry budget and backoff
- optional watchdog stall detection

Start narrow. `max_concurrent_runs: 1` is a good default until the repository's
workflow is genuinely stable.

### 5.3 `workspace`

`workspace` defines the execution surface for each issue:

- where workspaces live
- what branch prefix to use
- where clones come from
- whether to retain or delete workspaces on success and failure
- which remote worker hosts exist for Codex SSH execution

Important details:

- `workspace.root` is instance-owned and should not overlap between unrelated
  factories unless that is deliberate
- `workspace.repo_url` is resolved relative to the owning `WORKFLOW.md` when
  it is a local path
- for GitHub-backed trackers, Symphony can derive the clone source from
  `tracker.repo`
- `SYMPHONY_REPO` can override the tracker repo and the derived clone URL for
  GitHub-backed workflows
- non-GitHub trackers must set `workspace.repo_url`
- remote Codex execution requires `workspace.repo_url` to resolve to a remote
  clone URL reachable from the worker host

Local workspace preparation today is opinionated:

- clone if absent
- run `hooks.after_create` only on first clone
- fetch `origin`
- resolve the default branch
- reset to `origin/<issue-branch>` if it already exists
- otherwise reset to the default branch and create or reset the issue branch

### 5.4 `hooks`

`hooks.after_create` runs after the first successful clone of a workspace. It
is best used for one-time bootstrap steps that are expensive or awkward to
repeat inside every prompt.

Good uses:

- one-time dependency bootstrapping for a workspace clone
- writing local helper files that should exist in every workspace

Poor uses:

- correctness-critical logic the runtime depends on
- behavior that must run on every attempt, not just the first clone

### 5.5 `agent`

`agent` configures the execution adapter.

It includes:

- runner kind
- command
- prompt transport
- timeout
- max turns
- extra environment variables

Supported runner kinds today:

- `codex`
- `claude-code`
- `generic-command`

Important constraint: one workflow selects one runner configuration at a time.
The runtime does not switch runners per stage or per inner role.

`agent.prompt_transport` matters mostly for local command runners:

- `stdin` pipes the prompt to the command
- `file` writes a temp prompt file and passes that file path to the command

Remote Codex app-server execution requires `stdin`.

### 5.6 `observability`

`observability` controls the terminal dashboard refresh behavior. It does not
disable core runtime status publication.

In other words:

- the TUI is configurable
- status snapshots, startup snapshots, issue artifacts, and reports are still
  runtime-owned outputs

## 6. Prompt Body Contract

The prompt body is the repository-owned worker contract for the initial turn of
each run.

That sentence matters. The body is not a general workflow-graph language, and
it is not rerendered for every continuation turn.

### 6.1 Initial Turn vs Continuation Turns

Turn 1 uses the rendered body of `WORKFLOW.md`.

Later turns do not rerender the body. They use runtime-generated continuation
guidance that tells the worker:

- this is continuation turn `N` of `maxTurns`
- resume from the existing workspace state
- use preserved thread history if the runner supports it
- focus on the remaining issue work

This has two direct consequences:

1. Put durable repository expectations in the initial body, not only in
   turn-local prose.
2. Prefer runners with real continuation semantics when your repository depends
   on multi-turn work.

Codex app-server and Claude Code both support live or resumable session
behavior. Generic command runners do not.

### 6.2 What a Good Prompt Body Includes

A strong `WORKFLOW.md` body usually includes:

- which checked-in files to read first
- repository-specific completion criteria
- validation commands that must pass
- branch, PR, plan, and review expectations for this repository
- how to respond when blocked
- whether to continue an existing branch and PR or open a new one

For example, the self-hosting `symphony-ts` workflow requires the worker to:

- read `AGENTS.md`, `README.md`, and relevant docs
- create or update a technical plan before substantial implementation
- wait for explicit plan approval or waiver
- run the required local checks
- open or update the PR
- continue through CI and review feedback

That is repository policy expressed through the prompt contract.

### 6.3 What a Prompt Body Should Not Try To Do

Avoid using the prompt body to:

- define hidden engineering policy that belongs in `AGENTS.md`
- replace code-level invariants such as guarded landing or retry semantics
- model a true multi-station graph as if the runtime already supports one
- paper over missing runtime features with vague prose
- restate raw issue bodies instead of relying on normalized context plus local
  repository docs

### 6.4 Available Template Variables

The prompt body is rendered as a Liquid template with these main variables:

**`issue`**: the current work item

| Field              | Content                                        |
| ------------------ | ---------------------------------------------- |
| `issue.identifier` | Issue identifier such as `#42`                 |
| `issue.number`     | Numeric issue number                           |
| `issue.title`      | Issue title                                    |
| `issue.url`        | Direct URL to the issue                        |
| `issue.labels`     | Array of label strings                         |
| `issue.summary`    | Sanitized plain-text summary of the issue body |
| `issue.state`      | Normalized issue state                         |

**`lifecycle`**: normalized handoff state, present whenever the tracker has one

| Field                                | Content                                        |
| ------------------------------------ | ---------------------------------------------- |
| `lifecycle.kind`                     | Handoff kind such as `awaiting-system-checks`  |
| `lifecycle.branchName`               | Issue branch name                              |
| `lifecycle.summary`                  | Tracker-owned lifecycle summary                |
| `lifecycle.pullRequest`              | PR handle or `null`                            |
| `lifecycle.pendingCheckNames`        | Array of still-running checks                  |
| `lifecycle.failingCheckNames`        | Array of failed checks                         |
| `lifecycle.actionableReviewFeedback` | Sanitized actionable review feedback summaries |

**`pull_request`**: PR-backed lifecycle context, present only when a PR exists

`pull_request` has the same shape as `lifecycle`, but it is `null` when the
current handoff does not yet have a PR target.

**`attempt`**: retry attempt number

- `null` on the first attempt
- a number on retries

**`config`**: redacted resolved configuration

Use it for non-secret workflow facts such as tracker repo or branch prefix, not
for reconstructing hidden state.

### 6.5 Trust Boundary

Tracker-authored text is intentionally summarized and sanitized before it
enters the prompt.

Today, the injected issue and review summaries:

- strip markup and control characters
- collapse formatting
- trim to bounded lengths
- remove raw issue and comment bodies from direct prompt injection

Treat that summarized text as useful context, not as authority. The prompt
should tell the worker to trust checked-in repository instructions, local code,
and test evidence ahead of tracker narration.

## 7. How Symphony Uses `WORKFLOW.md` at Runtime

The runtime path is fixed enough that it is worth understanding explicitly.

1. Symphony loads `WORKFLOW.md`, parses the frontmatter, and derives the
   instance-rooted runtime paths.
2. Startup preparation runs before the main loop. For GitHub-backed workflows,
   that currently means preparing or refreshing a local bare mirror under
   `.tmp/github/upstream`; Linear uses a no-op preparer.
3. Symphony creates the tracker adapter, workspace manager, runner, prompt
   builder, and optional watchdog from the resolved config.
4. The orchestrator publishes startup status, then begins polling the tracker
   for ready, running, and failed issues.
5. Running issues go through restart recovery first. Symphony uses local issue
   leases plus tracker state to decide whether to adopt, requeue, or suppress
   an inherited run.
6. Ready issues are ordered by normalized queue priority when enabled. Running
   issues and due retries still take precedence over fresh ready work.
7. Symphony claims a ready issue through the tracker edge.
8. The workspace manager prepares the issue workspace and issue branch.
9. Symphony renders the initial prompt body with `issue`, `lifecycle`,
   `pull_request`, `attempt`, and redacted `config`.
10. The runner starts the session, telemetry begins, and the watchdog starts if
    enabled.
11. After each successful turn, the tracker reconciles the current handoff
    state.
12. If the lifecycle is `missing-target` or `rework-required` and the turn
    budget remains, Symphony starts another continuation turn.
13. If the lifecycle is `handoff-ready`, Symphony treats that as terminal
    success, completes the issue, clears runtime state, and applies the
    configured workspace-retention policy.
14. If the lifecycle is `awaiting-system-checks`,
    `awaiting-human-review`, `awaiting-human-handoff`,
    `degraded-review-infrastructure`, `awaiting-landing-command`, or
    `awaiting-landing`, the run stops and the issue remains under tracker
    supervision until the next poll.
15. On GitHub, if the issue reaches `awaiting-landing` and the current head has
    not already been attempted, Symphony executes guarded landing.
16. On success, Symphony completes the issue, clears retry state, and applies
    the workspace-retention policy. On failure, it schedules a retry or marks
    the issue failed.

The important design split is:

- `WORKFLOW.md` controls configuration and the initial prompt contract
- the runtime owns claims, retries, restart recovery, watchdog behavior,
  lifecycle reconciliation, and landing

## 8. Built-In Symphony Constraints

The current runtime model is deliberately narrower than a generic workflow
engine. Designing good workflows means designing for those constraints instead
of pretending they do not exist.

### 8.1 Work Source Constraints

Today, work must come from a supported tracker backend.

That means:

- GitHub issues
- Linear project issues

There is no generic arbitrary task inbox backend yet. One `WORKFLOW.md`
selects one tracker backend at a time.

### 8.2 Repository and Delivery Constraints

The current runtime is still repository-backed and outer-loop oriented.

The common shape is:

- one issue
- one prepared workspace
- one issue branch
- one PR or tracker handoff path
- one terminal completion outcome

GitHub is explicitly PR-centric. Linear is less PR-centric at the tracker edge,
but the execution model is still one workspace-backed delivery loop.

### 8.3 Runtime Gate Constraints

Some gates are runtime-owned, not prompt-owned.

Examples:

- retries and backoff
- lease-based run ownership
- restart recovery
- watchdog-based stall recovery
- GitHub landing guards
- GitHub review-bot and approved-review-bot policy

The prompt can tell the worker what the repository expects, but it cannot
replace those policy engines.

### 8.4 Coordination Model Constraints

Current coordination is issue-oriented, not station-oriented.

That means:

- queue priority only reorders ready issues
- one workflow still has one runner configuration
- one issue still executes in one prepared workspace target
- remote host continuity is a dispatch optimization, not a user-defined stage
  graph

### 8.5 Fit Assessment

Strong fit today:

- standard issue -> branch -> PR delivery loops
- repositories with explicit validation commands and a clear completion bar
- self-hosting factories where review and landing semantics matter

Possible today, but only as prompt-level approximation:

- planner -> implementer -> editor inner sequences
- research -> draft -> revise loops
- command-heavy maintenance work in one repository

Poor fit without deeper runtime changes:

- branching multi-station workflows with durable named transitions
- workflows that switch runners mid-flight
- one workflow that combines multiple tracker backends
- work that is not naturally repository- and branch-backed

## 9. Human Handoff Stations

Symphony already has several human interaction points. They are not all
enforced in the same way.

| Station               | Current support                              | Who enforces it                      | Notes                                                               |
| --------------------- | -------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| technical-plan review | supported today, but repository-driven       | prompt and tracker lifecycle support | `symphony-ts` self-hosting makes this mandatory unless waived       |
| PR or human review    | first-class on GitHub, state-based on Linear | tracker policy                       | GitHub inspects review comments, unresolved threads, and bot output |
| landing command       | GitHub-only today                            | tracker policy and guarded landing   | `/land` must be explicitly observed before GitHub merge execution   |

### 9.1 Plan Review

Plan review is a runtime-supported station, but it is not automatically
required for every repository.

The default protocol is:

- `Plan status: plan-ready`
- `Plan review: approved`
- `Plan review: changes-requested`
- `Plan review: waived`

Repositories can override those markers, the plan-ready metadata labels, and
the reply-template guidance through `tracker.plan_review` in `WORKFLOW.md`.

In `symphony-ts` itself, the prompt and `AGENTS.md` make this handoff required
before substantial implementation. Other repositories can choose not to use it.

### 9.2 Review

On GitHub, Symphony treats review as a first-class lifecycle:

- actionable human feedback produces `awaiting-human-review`
- actionable bot feedback can produce `rework-required`
- unresolved non-outdated review threads can block landing
- missing required approved-review-bot output produces
  `degraded-review-infrastructure`

On Linear, review is modeled through workflow states such as `Human Review`
and `Rework`, plus tracker comments carrying review signals.

### 9.3 Landing

Landing is currently strongest on GitHub.

GitHub landing requires:

- an explicit `/land` first line
- a mergeable non-draft PR
- a clean merge-state status
- no failing or pending required checks
- no actionable bot feedback
- no unresolved non-outdated human review threads
- no missing required approved bot-review coverage
- no stale approved head SHA

Linear does not implement merge execution. Teams using Linear must treat
landing as an external process or model it through workflow states.

## 10. Common Workflow Shapes That Work Well Today

### 10.1 Standard Software Factory

This is the best fit for the current runtime:

- one issue
- one branch
- one PR
- optional plan review before coding
- implementation
- review
- explicit landing

If your repository follows this shape, Symphony is operating in its intended
lane.

### 10.2 Command-Heavy Maintenance Loop

Symphony also works well for repositories where the worker mostly:

- runs commands
- inspects outputs
- patches code or config
- reruns validation

The main requirement is still a clear completion bar. "Run commands until
things look better" is not enough.

### 10.3 Runner-Specific Repositories

Some repositories genuinely want prompt text that assumes a specific runner.

That is reasonable when the repository depends on:

- Codex continuation behavior
- Claude-specific CLI or session behavior
- a custom generic command backend

Keep that runner specificity in the prompt only when it reflects a real
repository dependency.

### 10.4 Multi-Role Inner Sequence in One Run

This is the most useful advanced pattern available today.

A single run can still ask the worker to perform internal roles such as:

- planner -> implementer -> editor
- planner -> writer -> editor
- spec -> implement -> simplify -> verify

That works because the runtime still sees one outer issue, branch, and PR loop
while the prompt encodes an internal sequence inside one workspace.

## 11. Multi-Role Prompt Patterns

If you want richer behavior without changing the runtime, use one explicit
inner sequence in the prompt body.

The best current default is:

1. planner
2. implementer
3. editor

That pattern maps well to the current runtime because it still converges on one
branch, one PR, and one completion decision.

A simple shape looks like this:

```md
Working mode for this run:

1. Plan briefly before editing. Identify the narrowest safe slice.
2. Implement the slice completely.
3. Edit for clarity and simplicity after the code works.
4. Verify with the required local checks before stopping.
```

Guidance for writing multi-role prompts:

- keep the roles sequential
- keep them inside one workspace and one delivery path
- end with one explicit completion bar
- use skills for specialized repeated roles when needed
- assume the runtime still supervises only the outer issue lifecycle

Subagents can still be useful inside a run, but the runtime does not supervise
them as first-class workflow stations.

The limits of this approach still matter:

- good for one PR and one artifact flow
- not true runtime-enforced topology
- not sufficient for branching, durable gates, or complex orchestration

## 12. Tracker-Specific Guidance

### 12.1 GitHub

GitHub is the most complete tracker backend today.

What GitHub workflows get:

- ready, running, and failed issue labels
- issue claim semantics
- PR discovery by branch name
- normalized checks
- normalized review feedback
- explicit `/land` signaling
- guarded merge execution
- optional GitHub Projects queue priority

Two especially important GitHub settings are:

- `review_bot_logins`
- `approved_review_bot_logins`

The first tells Symphony which review authors are bots. The second tells it
which bot outputs count as required approved external review coverage on the
current head.

### 12.2 Linear

Linear uses a different edge model.

Instead of PR-native lifecycle policy, Linear currently relies on:

- project states
- issue assignment
- a workpad stored in the issue description
- review comments carrying handoff signals

Successful runs update the workpad and usually move the issue into `Human
Review` when that state exists. Rework and terminal completion are then driven
by Linear workflow states and comments.

Linear is a good fit when your team already uses Linear as the system of record
for work state and does not need Symphony itself to execute PR merges.

## 13. Runner-Specific Guidance

### 13.1 Codex

Codex is the primary runner model in the current runtime.

Important characteristics:

- Symphony derives a long-lived `codex app-server` session from the configured
  exec-style command
- one Codex thread is reused across continuation turns for a run
- token accounting and runner telemetry are first-class
- dynamic tools can be exposed, including current tracker context
- local and SSH remote execution are supported

Use Codex when you want the strongest built-in continuation semantics and the
richest runtime telemetry.

For SSH remote Codex execution, the current required shape is:

- `agent.runner.remote_execution.kind: ssh`
- `agent.prompt_transport: stdin`
- configured worker hosts under `workspace.worker_hosts`
- `workspace.repo_url` set to a remote clone URL reachable from the worker host

### 13.2 Claude Code

Claude Code is also a first-class runner, but with a different continuation
story.

The command must be headless and JSON-outputting:

```yaml
agent:
  runner:
    kind: claude-code
  command: claude -p --output-format json --permission-mode bypassPermissions --model sonnet
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

Key constraints:

- use `claude -p` or `claude --print` for non-interactive mode
- include `--output-format json` so Symphony can capture the backend session id
- use non-interactive permissions
- keep `agent.prompt_transport: stdin`
- do not bake `--resume`, `--continue`, or `--session-id` into `agent.command`

Current behavior:

- the first turn runs the configured Claude command
- later turns resume using the backend session id returned by the previous turn
- the outer Symphony loop stays the same

Claude Code is local-only in the current runtime.

### 13.3 Generic Command

`generic-command` is the fallback runner adapter.

It is useful when you have a backend that can be modeled as:

- one local command
- a prompt over stdin or file
- optional provider and model metadata for observability

What it does not currently provide:

- first-class session semantics
- remote transport
- rich continuation support

If you set `agent.max_turns > 1` with a generic command runner, assume
continuation turns will cold-start subprocesses.

## 14. Multi-Instance and Multi-Workflow Usage

The runtime is instance-scoped enough that one Symphony engine checkout can
operate several workflows safely, but only if the operator stays explicit.

Good operating practice:

- always pass `--workflow` when working outside the current repository
- treat `factory start`, `factory stop`, `factory status`, and `factory watch`
  as instance-scoped commands
- keep each workflow's `workspace.root` and instance-owned runtime paths
  separate

Examples:

```bash
pnpm tsx bin/symphony.ts run --once --workflow /path/to/repo-a/WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
pnpm tsx bin/symphony.ts factory start --workflow /path/to/repo-a/WORKFLOW.md
pnpm tsx bin/symphony.ts factory watch --workflow /path/to/repo-a/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --workflow /path/to/repo-b/WORKFLOW.md
```

For new third-party instances, use the scaffolder instead of copying the
self-hosting workflow or operator playbook blindly:

```bash
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo --runner claude-code
```

This is powerful, but it is easier to operate poorly than the simple per-repo
default. If multiple factories start to feel ambiguous, move back toward one
workflow per repository and one explicit operator loop per instance.

## 15. Examples

The best live examples in the current repository are:

- the self-hosting workflow at [../../WORKFLOW.md](../../WORKFLOW.md)
- the self-hosting operator playbook at [../../OPERATOR.md](../../OPERATOR.md)
- the minimal GitHub example in
  [workflow-frontmatter-reference.md#minimal-github-example](./workflow-frontmatter-reference.md#minimal-github-example)
- the GitHub review-bot and queue-priority example in
  [workflow-frontmatter-reference.md#github-with-review-bots-and-queue-priority](./workflow-frontmatter-reference.md#github-with-review-bots-and-queue-priority)
- the Linear example in
  [workflow-frontmatter-reference.md#linear-example](./workflow-frontmatter-reference.md#linear-example)
- the remote Codex example in
  [workflow-frontmatter-reference.md#codex-ssh-remote-execution-example](./workflow-frontmatter-reference.md#codex-ssh-remote-execution-example)

One especially useful prompt-body pattern that is not obvious from the YAML
examples alone is the inner planner -> implementer -> editor sequence:

```md
Work through three phases in order:

## Phase 1: Planner

Read the repo docs, inspect the code, and write the narrowest safe plan.

## Phase 2: Implementer

Follow the plan completely. Write code, write tests, and run the required
checks.

## Phase 3: Editor

Review the result for simplicity, remove unnecessary changes, and make sure the
implementation matches the plan before opening or updating the PR.
```

Use the repository root `WORKFLOW.md` as a self-hosting example, not as a
generic starter template. It is intentionally strict because it encodes this
repository's own engineering process.

## 16. Anti-Patterns

Common ways to make a workflow harder to operate:

- treating `WORKFLOW.md` as free-form notes instead of a runtime contract
- copying the `symphony-ts` self-hosting prompt into an unrelated repository
  without trimming its repo-specific process
- hiding enduring engineering rules only in prompt prose when they belong in
  `AGENTS.md`
- asking the prompt to enforce invariants the runtime should own
- pretending an inner prompt sequence is already a true workflow graph
- writing a giant vague prompt with no explicit completion bar
- assuming continuation turns will repeat the full body automatically
- enabling remote Codex execution without a worker-reachable remote clone URL
- assuming queue priority changes workflow topology instead of only ready-queue
  ordering

## 17. Migration Path

The cleanest way to adopt Symphony is incrementally.

1. Start with an ad hoc manual agent loop.
2. Move durable repository policy into `AGENTS.md`.
3. Extract specialized repeated task instructions into skills.
4. Write a narrow `WORKFLOW.md` around the stable outer loop.
5. Keep the first workflow boring: one issue, one branch, one completion path.
6. Add queue priority, review-bot policy, or remote workers only when the
   repository actually needs them.
7. Reach for richer workflow topology only when the current outer loop is
   clearly the limiting factor.

That progression keeps `WORKFLOW.md` honest. It becomes the encoded version of
a workflow you already understand, not a speculative graph of behavior the
runtime does not yet provide.

For more on the conceptual distinction between agent-shaped and factory-shaped
work, see [Why Factory](../concepts/why-factory.md).

## 18. Future Direction

The current runtime does not yet support configurable multi-station workflow
graphs. `WORKFLOW.md` selects one tracker, one workspace model, one runner
configuration, and one prompt contract for an issue-oriented outer loop.

The planned generalization work tracked in issue `#234` is aimed at moving
beyond the fixed issue -> branch -> PR -> review -> landing model and toward
configurable multi-station workflows. That direction is real, but it is future
work, not today's contract.

Until that lands, the right mental model is:

- use the runtime for the outer delivery loop
- use the prompt for a small inner role sequence when needed
- do not confuse the latter for true workflow topology
