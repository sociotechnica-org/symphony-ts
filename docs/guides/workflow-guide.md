# Workflow Guide

This guide explains how `WORKFLOW.md` is meant to be used in `symphony-ts`.

It is deliberately broader than the quick-start material in the README. The
README should stay focused on getting a factory running. This guide is the
longer-form reference for:

- how `WORKFLOW.md` fits into the architecture
- what the YAML frontmatter actually controls
- how the prompt body should be written
- common workflow shapes that work well today
- where the current model stops and future workflow-topology work begins

## 1. Purpose

`WORKFLOW.md` is the repository-owned runtime contract for one Symphony factory
instance. It is a single checked-in file that tells Symphony everything it needs
to run a factory against a repository: where work comes from, how to prepare
workspaces, what runner to use, what the worker is expected to do, and what
completion means.

It exists as a checked-in file rather than hidden prompt state for several
reasons:

- **Visibility.** Anyone with access to the repository can read the full factory
  configuration and worker prompt. There is no hidden state that controls how
  agents behave.
- **Version control.** Changes to the workflow are tracked in git history just
  like code changes. You can review, revert, and attribute workflow changes the
  same way you handle source code.
- **Reproducibility.** Given the same `WORKFLOW.md` and the same engine version,
  the factory behavior is deterministic. Two operators looking at the same commit
  see the same contract.
- **Portability.** The file travels with the repository. Fork a repo and you
  fork its factory configuration. Move a repo and the workflow moves with it.

Concretely, `WORKFLOW.md` is how a repository tells Symphony:

- **Where work comes from** — which tracker backend (GitHub Issues or Linear)
  and which labels, states, or project filters select eligible work items.
- **How to prepare workspaces** — where to clone, what branch prefix to use,
  what retention policy to apply after runs complete.
- **What runner to use** — which coding agent (Codex, Claude Code, or a generic
  command) executes the work, with what timeout and turn budget.
- **What the worker is expected to do** — the prompt body below the frontmatter
  becomes the worker's instructions, rendered with real issue and PR context at
  runtime.
- **What completion means** — the frontmatter configures retry policy, review
  gates, and landing behavior that together define when Symphony considers a
  work item finished.

## 2. Boundaries

Four layers of configuration serve different roles in a Symphony-managed
repository. Understanding which layer owns which concern prevents duplication,
contradiction, and hidden requirements.

### `WORKFLOW.md` — Runtime Contract

`WORKFLOW.md` defines the runtime contract: the operational configuration that
Symphony reads at startup and the prompt template that workers receive at
execution time.

Put things in `WORKFLOW.md` when they are:

- required for every worker run (tracker selection, polling cadence, runner
  choice, timeout, workspace layout)
- part of the worker's per-issue instructions (the prompt body)
- specific to the factory's operating parameters (concurrency, retry,
  watchdog)

### `AGENTS.md` — Engineering Policy

`AGENTS.md` defines the repository's enduring engineering policy: design
principles, testing requirements, review expectations, and architecture
boundaries that apply regardless of whether work is done by a human, an
interactive agent, or a factory worker.

Put things in `AGENTS.md` when they are:

- design rules that outlive any single workflow
- testing standards that apply to all code changes
- review and merge requirements
- architecture boundaries and dependency rules
- planning and documentation standards

### Skills — Reusable Specialized Method

Skills are repo-local guides in the `skills/` directory that provide detailed
method for recurring kinds of work. A skill might describe how to write a
technical plan, how to operate the factory, or how to handle a specific class of
maintenance task.

Put things in skills when they are:

- specialized to a type of task rather than universal to all work
- detailed enough to warrant their own document
- reusable across multiple issues or runs

### Code and Tests — Hard Correctness Guarantees

Code and tests provide the guarantees that prompts and policy documents cannot.
A prompt can say "run the tests before opening a PR" but only the test suite can
actually verify that the code works.

Put things in code and tests when they are:

- correctness invariants that must be mechanically verified
- runtime behavior that should not depend on prompt compliance
- integration contracts that need automated validation

**Rule of thumb:** if behavior is required for every worker run, put it in
`WORKFLOW.md` or `AGENTS.md`. If guidance is specialized to a type of task, put
it in a skill. If behavior is part of runtime correctness, put it in code and
tests, not only in prompts.

## 3. File Structure

Every `WORKFLOW.md` has two parts: YAML frontmatter and a markdown prompt body.

```md
---
tracker:
  kind: github
  repo: your-org/your-repo
polling:
  interval_ms: 30000
  max_concurrent_runs: 1
  retry:
    max_attempts: 3
    backoff_ms: 60000
workspace:
  root: ./.tmp/workspaces
  branch_prefix: symphony/
agent:
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -
  prompt_transport: stdin
  timeout_ms: 1800000
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}

Rules:

1. Read `AGENTS.md` before making changes.
2. Create or reuse the issue branch for this work.
3. ...
```

### YAML Frontmatter

The frontmatter is delimited by `---` markers and must parse to a valid YAML
mapping. It configures the six top-level sections that control factory behavior:
`tracker`, `polling`, `workspace`, `hooks`, `agent`, and `observability`.

Symphony parses the frontmatter at startup through `src/config/workflow.ts`,
validates required fields, applies defaults, and produces a typed
`ResolvedConfig` that the orchestrator and all service layers consume. A missing
or malformed frontmatter block is a fatal startup error.

### Markdown Prompt Body

Everything after the closing `---` is the prompt body. This is not documentation
or notes — it is the template that becomes the worker's instructions at runtime.

Symphony renders the prompt body using [Liquid](https://liquidjs.com/) template
syntax. At render time, the template has access to:

- `issue` — the current work item (identifier, number, title, URL, labels,
  summary, state)
- `pull_request` — the current PR lifecycle state when a PR exists (kind, URL,
  pending/failing checks, actionable review feedback)
- `config` — a redacted view of the resolved configuration
- `attempt` — the current attempt sequence number

The rendered prompt is what the runner receives. The prompt body should be
written as direct instructions to the worker, not as a description of what the
worker might do.

## 4. Instance Model

One `WORKFLOW.md` defines one local Symphony instance. The repository containing
that `WORKFLOW.md` is the **instance root**, and all runtime paths are resolved
relative to it.

### Instance-Rooted Paths

Each instance owns these directories under its instance root:

```text
<instance-root>/
  WORKFLOW.md                    # the runtime contract
  .tmp/
    factory-main/                # detached runtime checkout
    workspaces/                  # per-issue isolated workspaces (default root)
    github/
      upstream/                  # local bare mirror for GitHub repos
    status.json                  # last-known status snapshot
  .var/
    factory/
      issues/                    # per-issue runtime artifacts
    reports/
      issues/                    # generated per-issue reports
      campaigns/                 # campaign digests
  .ralph/
    instances/
      <instance-key>/            # operator loop state (scratchpad, locks, logs)
```

These paths belong to the instance. They do not leak into a shared engine-global
directory, so multiple instances running from the same engine checkout do not
collide.

### Project-Local vs Engine Checkout Usage

The simplest setup is a `WORKFLOW.md` checked into the target repository itself.
The instance root is the repository root, and all runtime state lives alongside
the code:

```bash
cd target-repo
pnpm tsx /path/to/symphony/bin/symphony.ts run
```

When using a separate Symphony engine checkout to operate against a different
repository, the `--workflow` flag selects which instance to operate:

```bash
# From the engine checkout, operate against a target repo's workflow
pnpm tsx bin/symphony.ts run --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory start --workflow ../target-repo/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --workflow ../target-repo/WORKFLOW.md
```

The instance root in this case is `../target-repo/`, not the engine checkout.

### Multiple Workflows From One Engine Checkout

One Symphony engine checkout can operate many workflows at once. Each target
project owns its own `WORKFLOW.md` and its own instance-rooted runtime state.

Teams may organize workflows in several ways:

- **One workflow per target repository** — the clearest default. Each repo has
  its own `WORKFLOW.md` and its own `.tmp/` and `.var/` trees.
- **A shared workflow-library directory** — a directory of `WORKFLOW.md` files,
  each targeting a different repository. Useful when one operator manages
  multiple repos.
- **Several concurrent local factories** — multiple `factory start` commands
  from the same engine checkout, each pointing at a different `--workflow` path.

The tradeoff: per-repo `WORKFLOW.md` is the clearest default because the
workflow lives with the code it operates on. Multiple workflows from one engine
checkout are supported and useful for centralized operation, but they require
explicit instance separation and attention to which detached runtime belongs to
which workflow.

## 5. Frontmatter and Configuration Model

The YAML frontmatter controls six areas of factory behavior. This section
provides a narrative overview of what each area does and when to adjust it. For
the exhaustive field-by-field reference with types, defaults, and validation
rules, see the separate
[WORKFLOW Frontmatter Reference](./workflow-frontmatter-reference.md).

### 5.1 `tracker` — Where Work Comes From

The `tracker` section selects the tracker backend and configures how Symphony
finds, claims, and completes work items.

Symphony supports three tracker kinds today:

- `github` — polls GitHub Issues using configurable labels
  (`symphony:ready`, `symphony:running`, `symphony:failed`)
- `github-bootstrap` — a compatibility variant of the GitHub tracker used for
  Symphony's self-hosting bootstrap path; shares the same runtime semantics as
  `github`
- `linear` — polls Linear work items using project-scoped GraphQL queries with
  configurable active/terminal states

One `WORKFLOW.md` selects one tracker backend. There is no way to combine
GitHub and Linear in a single workflow or pull work from multiple tracker
sources in one runtime loop.

The tracker section also configures:

- **Review bot logins** — identities whose PR review feedback is treated as
  automated review rather than human review. This affects how Symphony counts
  actionable feedback and whether it waits for human review.
- **Approved review bot logins** — reviewer-app identities that count toward
  required approved-reviewer coverage. When configured, Symphony can block
  landing until at least one of these bots has produced qualifying output on the
  current PR head.
- **Queue priority** — optional tracker-owned ordering for ready work items.
  For GitHub, this reads a Projects V2 field and maps it to a numeric rank. For
  Linear, it maps the native issue priority. When priority is unavailable or
  not configured, Symphony falls back to deterministic issue-number ordering.

### 5.2 `polling` — How Often and How Many

The `polling` section controls the factory's operational cadence:

- **`interval_ms`** — how often Symphony polls the tracker for new work. 30000
  (30 seconds) is a common starting point.
- **`max_concurrent_runs`** — how many work items can execute simultaneously.
  Start with 1 until you are confident in the workflow, then increase as needed.
- **`retry`** — how many times Symphony retries a failed run
  (`max_attempts`) and how long it waits between retries (`backoff_ms`).
- **`watchdog`** — optional liveness monitoring that detects stalled runners.
  When enabled, the watchdog checks for progress at `check_interval_ms`
  intervals and triggers recovery if no progress is observed for
  `stall_threshold_ms`. Recovery attempts are bounded by
  `max_recovery_attempts`.

### 5.3 `workspace` — Where Code Lives

The `workspace` section controls how Symphony prepares isolated execution
environments for each work item:

- **`root`** — the directory where per-issue workspaces are created. Resolved
  relative to the instance root. `./.tmp/workspaces` is the conventional
  default.
- **`repo_url`** — explicit clone source. For GitHub-backed trackers, Symphony
  derives this from `tracker.repo` automatically. Required for non-GitHub
  trackers.
- **`branch_prefix`** — the prefix for issue branches. `symphony/` is the
  conventional default, producing branches like `symphony/42`.
- **`retention`** — what happens to workspaces after runs complete. The default
  is `on_success: delete` and `on_failure: retain`, which cleans up after
  success but preserves failure state for debugging.
- **`worker_hosts`** — optional SSH worker-host definitions for remote Codex
  execution. Each host specifies an `ssh_destination` and a remote
  `workspace_root`.

### 5.4 `agent` — What Runs the Work

The `agent` section controls which coding agent executes work items and how
Symphony communicates with it:

- **`runner.kind`** — selects the runner adapter: `codex`, `claude-code`, or
  `generic-command`. If omitted, Symphony infers `codex` when the command
  invokes `codex`, otherwise `generic-command`.
- **`command`** — the shell command shape for the runner. For Codex, Symphony
  derives an app-server session from this command. For Claude Code, it must be
  a headless JSON-output command. For generic-command, it is any subprocess.
- **`prompt_transport`** — how the rendered prompt reaches the runner: `stdin`
  pipes the prompt to the process, `file` writes it to a temp file and passes
  the path.
- **`timeout_ms`** — maximum wall-clock time per runner turn. A run with
  `max_turns > 1` can consume multiple timeout windows across continuation
  turns.
- **`max_turns`** — maximum continuation turns per worker run. Each turn is a
  separate runner invocation with an updated prompt reflecting the current PR
  and review state. Default is 1.
- **`env`** — additional environment variables injected into the runner process.
  For GitHub-backed trackers, Symphony also injects `GITHUB_REPO`.

### 5.5 `observability` — What You See

The `observability` section controls the local status dashboard:

- **`dashboard_enabled`** — whether the TUI dashboard renders during `run`.
  Defaults to `true`.
- **`refresh_ms`** — how often the dashboard polls the orchestrator snapshot.
  Default 1000ms.
- **`render_interval_ms`** — minimum interval between TUI frame renders.
  Default 16ms (roughly 60fps).

## 6. Prompt Body Contract

The prompt body is the most consequential part of `WORKFLOW.md` for worker
behavior. It is the direct instructions that the coding agent receives for every
work item. Getting it right is the difference between a factory that reliably
produces good work and one that produces unpredictable results.

### What the Prompt Body Should Do

**State the worker's process explicitly.** The prompt should describe the
expected sequence of work: read the docs, create a plan, wait for review,
implement, open a PR, monitor CI, address feedback. Workers do not know the
expected process unless the prompt tells them.

**Define completion criteria.** The prompt should be specific about what "done"
means: tests passing, lint clean, PR opened, CI green, review feedback
addressed. Vague prompts produce vague outcomes.

**Reference repo-owned docs.** The prompt should point workers to `AGENTS.md`,
relevant skills, and other checked-in guidance rather than trying to encode all
engineering policy inline.

**Assume real context will be present.** The prompt template has access to
`issue`, `pull_request`, `config`, and `attempt` variables. Use them. Do not
write prompts that ignore the available context.

### What the Prompt Body Should Not Do

**Do not compensate for missing runtime guarantees.** If a behavior needs to be
enforced mechanically (like "never merge without passing checks"), that belongs
in code and tests, not only in prompt text. Prompts are instructions, not
contracts.

**Do not duplicate the frontmatter.** The prompt body should not restate
configuration that is already in the YAML frontmatter. The frontmatter is
parsed and enforced by the runtime; the prompt body is guidance to the worker.

**Do not include raw external content.** The prompt template should use the
sanitized and summarized fields that Symphony provides (`issue.summary`,
`feedback.summary`) rather than trying to inject raw GitHub markdown or HTML.
Raw external content is excluded from the prompt context by design.

### Available Template Variables

The prompt body is rendered as a Liquid template with these variables:

**`issue`** — the current work item:

| Field              | Content                                        |
| ------------------ | ---------------------------------------------- |
| `issue.identifier` | Issue identifier (e.g. `#42`)                  |
| `issue.number`     | Numeric issue number                           |
| `issue.title`      | Issue title                                    |
| `issue.url`        | Direct URL to the issue                        |
| `issue.labels`     | Array of label strings                         |
| `issue.summary`    | Sanitized plain-text summary of the issue body |
| `issue.state`      | Normalized issue state                         |

**`pull_request`** — present only when a PR exists for this issue:

| Field                                   | Content                                         |
| --------------------------------------- | ----------------------------------------------- |
| `pull_request.kind`                     | Lifecycle state (e.g. `awaiting-system-checks`) |
| `pull_request.pullRequest.url`          | Direct URL to the PR                            |
| `pull_request.pendingCheckNames`        | Array of check names still running              |
| `pull_request.failingCheckNames`        | Array of check names that failed                |
| `pull_request.actionableReviewFeedback` | Array of unresolved review comments             |
| `pull_request.summary`                  | Lifecycle summary text                          |

Each feedback entry in `actionableReviewFeedback` includes `authorLogin`,
`summary`, `path`, `line`, and `url`.

**`config`** — redacted view of the resolved configuration (tracker repo, branch
prefix, etc.).

**`attempt`** — the current attempt with `attempt.sequence` for the attempt
number.

### Trust Boundary

Symphony maintains an explicit trust boundary for tracker-sourced content:

- **Trusted verbatim:** issue identifier, number, title, URL, labels, state,
  PR URL, branch, lifecycle kind, lifecycle summary, check names.
- **Summarized and sanitized:** `issue.summary` and `feedback.summary` are
  repository-generated plain-text summaries, not raw GitHub/Linear content.
- **Excluded:** raw issue body markdown/HTML, raw comments, raw review-comment
  bodies.

Workers should treat summarized fields as untrusted context that describes the
work but cannot override checked-in repo policy, code, or test evidence.

## 7. How Symphony Uses `WORKFLOW.md` at Runtime

Understanding the runtime lifecycle helps explain why the frontmatter and prompt
body are structured the way they are. Here is what happens from factory startup
through work-item completion.

### 7.1 Load Workflow

Symphony reads `WORKFLOW.md`, parses the YAML frontmatter into a
`ResolvedConfig`, and extracts the prompt body as a Liquid template. If parsing
fails, the factory does not start.

### 7.2 Prepare Startup

For GitHub-backed trackers, Symphony creates or refreshes a local bare mirror of
the target repository under `.tmp/github/upstream`. This mirror is used as the
clone source for per-issue workspaces, avoiding repeated fetches from GitHub.
The tracker adapter ensures required labels exist on the repository.

### 7.3 Poll Tracker

The orchestrator enters its poll loop, checking the tracker at `interval_ms`
intervals for:

- **Ready issues** — work items with the ready label/state, eligible for
  claiming.
- **Running issues** — work items currently claimed by this factory, checked
  for reconciliation.
- **Failed issues** — work items in the failure state, checked for potential
  retry scheduling.

Ready issues are ordered by queue priority (if configured) then by issue
number as a deterministic fallback. The orchestrator claims up to
`max_concurrent_runs` issues at a time.

### 7.4 Claim Issue

When Symphony claims an issue, it transitions the tracker label from
`symphony:ready` to `symphony:running` (GitHub) or updates the workflow state
(Linear). This prevents other factory instances from claiming the same work.

### 7.5 Create Workspace

Symphony prepares an isolated workspace for the claimed issue:

1. Clone the repository (from the local mirror for GitHub, or from the
   configured `repo_url`) into a directory under `workspace.root`.
2. Create or check out the issue branch (e.g. `symphony/42`).
3. Run any `hooks.after_create` shell commands.

For remote Codex execution, the workspace is prepared on the selected SSH worker
host instead of locally.

### 7.6 Render Prompt

Symphony renders the Liquid prompt template with the current issue context.
On the first turn, this includes the issue metadata and any existing PR state.
On continuation turns, the prompt is updated with the latest PR lifecycle
state, check results, and actionable review feedback.

### 7.7 Run Worker

Symphony launches the configured runner with the rendered prompt:

- **Codex** — starts a `codex app-server` subprocess and reuses a single
  Codex thread across continuation turns within the same run.
- **Claude Code** — spawns a `claude` process per turn with JSON output
  capturing.
- **Generic command** — spawns the configured command as a subprocess.

The runner has `timeout_ms` to complete each turn. The watchdog (if enabled)
monitors for stalls independently.

### 7.8 Inspect Handoff State

After the runner completes a turn, Symphony inspects the PR and review state
to determine the next action:

- **No PR yet** — if the worker has not opened a PR, the run may continue
  or fail depending on whether the turn budget is exhausted.
- **Awaiting system checks** — CI checks are still running. Symphony waits
  and re-inspects.
- **Checks failing** — one or more required checks failed. If turns remain,
  Symphony renders an updated prompt with the failure details and runs
  another turn.
- **Awaiting review** — checks are passing but review feedback is pending
  or actionable. If turns remain and feedback is actionable, Symphony runs
  another turn with the feedback in the prompt.
- **Awaiting landing command** — checks pass, reviews are clean, and the PR
  is waiting for a human `/land` command.
- **Awaiting landing** — a `/land` command was received. Symphony executes
  the guarded landing path.
- **Handoff ready** — the PR is merged. Symphony marks the issue complete.

### 7.9 Continue Until Handoff

The orchestrator continues running turns (up to `max_turns`) until one of these
terminal conditions:

- The PR is merged and the issue is completed.
- The turn budget is exhausted and the PR is in a waiting state (waiting for
  human review, human landing command, or system checks).
- All retry attempts are exhausted and the issue is marked failed.
- The run is cancelled (operator intervention, shutdown, or watchdog recovery).

Between poll cycles, the orchestrator also handles retry scheduling,
reconciliation of running issues against local state, and status snapshot
publication.

### What Is Fixed by the Runtime vs What Is Prompt-Controlled

The runtime **enforces**:

- Label/state transitions for issue claiming and completion
- Workspace isolation and branch naming
- Runner timeout and turn limits
- Check, review, and landing gates
- Retry scheduling and backoff
- Watchdog stall detection and recovery

The prompt **influences**:

- What the worker actually does within a turn (planning, coding, testing)
- Whether the worker reads docs, writes tests, addresses feedback
- The quality and completeness of the worker's output
- Internal role sequencing within a single run

The prompt cannot override the runtime's gate policy. Even if a prompt says
"merge the PR when you think it is ready," the runtime still requires checks
to pass, reviews to be clean, and a landing command before merge.

## 8. Built-In Symphony Constraints

This section makes the current runtime assumptions explicit so you can tell what
kinds of work fit Symphony well today, what can be approximated, and what does
not fit without deeper runtime changes.

### 8.1 Work Source Constraints

- Work items come from supported tracker backends only. Today that means GitHub
  Issues or Linear work items.
- There is no generic "arbitrary task inbox" backend. You cannot point Symphony
  at a spreadsheet, a Slack channel, or a custom API without implementing a new
  tracker adapter.
- One `WORKFLOW.md` selects one tracker backend at a time. A single workflow
  cannot combine GitHub and Linear or pull work from multiple tracker sources
  in one runtime loop.
- Work items are individual issues or tickets. Symphony does not natively
  understand parent/child issue relationships, epics, or dependency graphs
  (that is planned for later as molecule-aware dispatch).

### 8.2 Repository and Delivery Constraints

- Symphony expects a repository-backed workflow. The current execution model
  assumes that work happens in a git repository with branches and pull requests.
- One work item maps to one delivery loop: one issue, one workspace, one branch,
  one PR, one landing outcome.
- The current lifecycle model is PR-centric. The runtime tracks handoff state
  through a fixed set of lifecycle kinds (`awaiting-system-checks`,
  `awaiting-human-review`, `awaiting-landing-command`, `awaiting-landing`,
  `handoff-ready`, etc.) rather than user-defined station names.
- Checks, reviews, and landing are first-class runtime concepts. The
  orchestrator actively monitors CI check status, review feedback, and merge
  state rather than leaving these entirely to the worker.

### 8.3 Runtime Gate Constraints

- **Check gates** are runtime-owned. Required checks must reach acceptable
  terminal states before the PR can progress toward landing. The runtime
  monitors check status independently of the worker.
- **Review gates** are runtime-owned. The runtime distinguishes human review
  from bot review, tracks actionable feedback, and can require approved
  reviewer-bot coverage before landing.
- **Landing gates** are runtime-owned. Landing is an explicit operation with
  built-in blocked reasons (failing checks, unresolved review threads, missing
  approved bot reviews) rather than a free-form worker decision. The runtime
  re-checks mergeability, required checks, and review state before executing
  the merge.
- Prompt text can influence worker behavior (like "address all review comments
  before moving on") but it cannot replace the runtime's check, review, and
  landing policy engine.

### 8.4 Coordination Model Constraints

- The queue is a queue of work items, not a queue of workflow stations or
  subtasks. Each work item gets one slot in the concurrency pool.
- One workflow has one runner configuration. The runtime does not switch
  runners per internal stage. If your workflow needs Codex for planning and
  Claude Code for implementation, that is not supported at the runtime level
  today.
- One prepared workspace is the main execution unit for a work item. The
  runner operates in that workspace for all turns.
- Queue priority changes ordering among ready items but does not create new
  topology or alternative workflow paths.

### 8.5 Fit Assessment

**Strong fit — works well today:**

- Single-issue, single-PR software factory work (bug fixes, features, refactors)
- Command-heavy maintenance loops (dependency updates, formatting passes,
  migration scripts)
- Repeatable workflows with clear completion criteria
- Repositories where the plan-implement-review-land cycle maps naturally

**Possible as prompt-level approximation:**

- Multi-role inner sequencing within a single run (planner, implementer,
  reviewer as prompt-described phases)
- Quality gates expressed as prompt instructions rather than runtime stations
- Workflows where the worker self-reviews before the PR gets external review

**Does not fit well without deeper runtime changes:**

- Workflows requiring different runners at different stages
- Branching or conditional workflow paths based on intermediate results
- Multi-repository coordination from a single work item
- Non-code workflows with no PR or merge concept
- Workflows requiring durable human gates beyond plan review and landing
- Arbitrary task inboxes that are not GitHub Issues or Linear

## 9. Human Handoff Stations

Symphony enforces specific points where human judgment is required before the
factory continues. These are runtime-level stations, not just prompt-level
suggestions.

### 9.1 Plan Approval

Before substantial implementation begins, the workflow requires the agent to
create a technical plan and stop at a human review station.

**How it works:** The worker writes a plan to
`docs/plans/<issue-number>-<task-name>/plan.md`, commits it to the issue branch,
pushes the branch, and posts a `plan-ready` comment on the GitHub issue with
links to the plan file and branch. The factory then waits for a human response.

**Accepted review markers:**

- `Plan review: approved` — proceed to implementation
- `Plan review: changes-requested` — revise the plan
- `Plan review: waived` — skip plan review and proceed directly

**Waivable?** Yes. Plan review can be explicitly waived by including
`Plan review: waived` as a response, or by the issue or operator instructions
stating that plan approval is not required. When waived, the worker proceeds
directly from planning to implementation.

**Configurable?** Plan approval is a prompt-level convention enforced by the
worker prompt, not a runtime-level gate. The runtime does not block execution
until plan approval; instead, the worker prompt instructs the agent to wait.
If you remove the plan-review instructions from your prompt body, workers will
not stop for plan review.

### 9.2 PR Review

After a PR is opened, Symphony monitors it through CI checks and review
feedback. The runtime distinguishes between:

- **Human review** — feedback from accounts not listed in
  `tracker.review_bot_logins`, treated as the authoritative review signal.
- **Bot review** — feedback from accounts listed in
  `tracker.review_bot_logins`, treated as automated review surface that may
  require worker rework but does not substitute for human review.
- **Approved bot review** — output from accounts listed in
  `tracker.approved_review_bot_logins`, which counts toward required
  approved-reviewer coverage when configured.

**Relaxable?** Partially. If you do not configure `review_bot_logins` or
`approved_review_bot_logins`, Symphony does not enforce bot-review coverage
requirements. The runtime still monitors review state and surfaces it to
workers, but the gate is lighter. However, Symphony's landing path always
checks for unresolved review threads and failing checks regardless of
configuration.

### 9.3 Landing (`/land`)

When a PR reaches a state where checks pass and reviews are clean, Symphony
waits for an explicit human landing signal before merging. Today, this is a
`/land` comment on the PR.

**How it works:** The runtime transitions the PR from `awaiting-landing-command`
to `awaiting-landing` when it detects a `/land` comment. It then executes a
guarded landing path that re-checks mergeability, required checks, approved bot
review presence, and unresolved review threads before performing the merge.

**Auto-land?** Auto-landing does not exist today. Every merge requires an
explicit `/land` command. This is a deliberate design choice: the factory should
not merge code without human authorization. Implementing auto-land would require
code changes to the landing policy.

**Configurable?** The landing command (`/land`) is currently fixed in the runtime.
The guarded landing path's pre-merge checks (mergeability, check status, review
state) are also runtime-owned and not configurable through frontmatter.

### What Is First-Class vs Prompt-Level

| Station              | Enforcement   | Configurable               | Waivable                 |
| -------------------- | ------------- | -------------------------- | ------------------------ |
| Plan approval        | Prompt-level  | Remove from prompt to skip | Yes, via review marker   |
| PR review monitoring | Runtime-level | Review bot lists           | Partially (bot coverage) |
| Landing command      | Runtime-level | Not configurable           | No                       |
| Guarded merge checks | Runtime-level | Not configurable           | No                       |

## 10. Common Workflow Shapes That Work Well Today

This section describes workflow shapes that work with the current Symphony
runtime. Everything here is achievable today without code changes.

### 10.1 Standard Software Factory

The most common shape: one issue becomes one branch, one PR, and one merge.

```text
Issue claimed
  → Workspace created
    → Agent creates plan
      → Human reviews plan (or waives)
        → Agent implements and opens PR
          → CI runs, reviews happen
            → Agent addresses feedback (continuation turns)
              → Human posts /land
                → Symphony merges
                  → Issue closed
```

This is the shape that Symphony's runtime is built around. The orchestrator
manages every transition. The prompt body controls what the agent does within
each turn, and the runtime controls the gates between stages.

**When to use:** Standard feature development, bug fixes, refactoring tasks,
documentation updates — any work that maps to "one issue, one PR."

### 10.2 Command-Heavy Maintenance Loop

Some repositories need a factory that mostly runs commands, verifies their
output, and patches things up. Examples: dependency updates, code formatting
passes, migration script execution, security patch application.

In this shape, the prompt body focuses on command execution and verification
rather than creative implementation:

```text
Rules:

1. Run `npm audit fix` and verify the changes compile.
2. Run the test suite and fix any failures.
3. Open a PR with the changes.
```

**When to use:** Recurring maintenance tasks where the work is mechanical and
the process is well-defined. The factory value here is reliability and
scheduling, not creative problem-solving.

### 10.3 Runner-Specific Repositories

Some repositories work best with a specific runner, and the prompt body should
include runner-specific guidance.

**Codex repositories** can take advantage of Codex's long-lived app-server
sessions and tool capabilities. The prompt can assume Codex-specific behaviors
like the `tracker_current_context` dynamic tool.

**Claude Code repositories** should keep the command shape headless
(`claude -p --output-format json`) and include guidance appropriate for Claude's
capabilities, such as subagent usage and skill invocation.

**When to use:** When the repository has a clear affinity for one runner and
the prompt should include runner-aware instructions.

### 10.4 Multi-Role Inner Sequence in One Run

The most powerful current pattern: the prompt describes multiple internal roles
that the agent adopts sequentially within a single run, while Symphony still
manages the outer issue/branch/PR loop.

```text
You will work through three phases for this issue:

Phase 1 — Planner:
Read the issue, explore the codebase, and create a technical plan.
Write it to docs/plans/<issue-number>-<task>/plan.md.

Phase 2 — Implementer:
Implement the plan. Write code, tests, and docs.

Phase 3 — Reviewer:
Review your own implementation. Check for correctness, style, test
coverage, and completeness. Fix anything you find.

Only open the PR after completing all three phases.
```

**When to use:** When you want higher-quality output from a single factory run.
The planner-implementer-reviewer pattern catches errors that a single-pass
implementation misses. This is the recommended "advanced but current" pattern
for production use.

## 11. Multi-Role Prompt Patterns

This section describes the intermediate design space where Symphony runs one
outer issue/branch/PR loop but the worker prompt encodes internal role phases.
This is the most immediate way to get multi-role behavior without waiting for
future runtime-level station support.

### The Pattern

Instead of one flat set of instructions, the prompt body describes a sequence
of named roles, each with its own focus:

```text
Work through these roles in order:

## Role 1: Planner
- Read AGENTS.md and relevant docs
- Understand the issue requirements
- Create a technical plan
- Commit the plan to the issue branch

## Role 2: Implementer
- Follow the plan
- Write code and tests
- Run the test suite locally
- Commit working code

## Role 3: Editor
- Review the implementation against the plan
- Check for style, correctness, and completeness
- Simplify where possible
- Fix issues before opening the PR
```

### Recommended Default Pattern: Planner → Implementer → Editor

For software delivery, `planner → implementer → editor` is the recommended
default multi-role pattern because it maps directly to Symphony's existing
software-factory runtime:

- **Planner** reads the issue and codebase, creates a technical plan, and
  commits it. This role naturally feeds into the plan-review station if the
  prompt includes plan-review handoff instructions.
- **Implementer** follows the plan and writes code, tests, and documentation.
  This role produces the branch and PR that the runtime manages.
- **Editor** reviews the implementation for quality, catches issues the
  implementer missed, and cleans up before the PR is opened. This role
  reduces review churn and rework cycles.

### Alternative Patterns

**Planner → Writer → Editor** — for content-heavy or documentation
repositories where the output is prose rather than code. The writer focuses on
drafting content and the editor focuses on clarity and accuracy.

**Spec → Implement → Simplify → Verify** — for implementation-heavy work
where simplification is a distinct, valuable step. The verify role runs tests
and checks rather than reviewing prose.

**Research → Draft → Revise** — for exploratory work where understanding the
problem is a significant part of the effort.

### How Skills Support Multi-Role Prompts

Repo-local skills in `skills/` can provide detailed guidance for individual
roles without bloating the prompt body. The prompt can reference a skill:

```text
## Role 1: Planner
Read `skills/symphony-plan/SKILL.md` and follow its planning standard.
```

This keeps the prompt body focused on the role sequence while delegating
detailed method to checked-in skill documents.

### Where Subagents Help

Some runners (notably Claude Code) support launching subagents for specific
tasks within a turn. Subagents can help with multi-role patterns by:

- Running research tasks in parallel with the main implementation
- Performing focused code review on specific files
- Executing independent verification steps

The prompt can guide subagent usage without Symphony needing to know about
subagents at the runtime level.

### Limits of This Approach

Multi-role prompt patterns are effective but limited:

- **Good for one PR / one artifact flow.** The roles produce one coherent
  output that flows through Symphony's existing gates.
- **Not true runtime-enforced topology.** If the agent skips a role, the
  runtime does not notice. Role compliance is prompt-level, not runtime-level.
- **Not sufficient for branching, durable gates, or complex orchestration.**
  If you need the runtime to enforce transitions between stages, wait for
  human approval at intermediate points, or route work differently based on
  intermediate results, prompt-level roles are not enough.

Future runtime-level station support (tracked in
[issue #234](https://github.com/sociotechnica-org/symphony-ts/issues/234))
would make role transitions first-class runtime concepts with per-station
runners, prompts, and gates.

## 12. Tracker-Specific Guidance

### 12.1 GitHub

GitHub is the most mature and feature-complete tracker backend in Symphony.

**Labels:** Symphony uses three configurable labels to track issue state:

- `ready_label` (default `symphony:ready`) — marks issues eligible for the
  factory to claim.
- `running_label` (default `symphony:running`) — marks issues currently being
  worked by the factory.
- `failed_label` (default `symphony:failed`) — marks issues where all retry
  attempts are exhausted.

These labels must exist on the repository before the factory starts. Symphony
creates them automatically if they are missing.

**PR Lifecycle:** The GitHub tracker manages the full PR lifecycle:

1. Worker creates a branch and opens a PR
2. Symphony monitors CI check runs and commit statuses
3. Symphony monitors review comments, distinguishing human from bot feedback
4. When checks pass and reviews are clean, the PR enters
   `awaiting-landing-command`
5. A human posts `/land` on the PR
6. Symphony executes the guarded merge

**Check Stabilization:** Symphony waits for checks to settle before acting on
their results. A check state is considered stable after two consistent
observations, preventing premature reactions to transient check states.

**Queue Priority:** When configured, Symphony reads a GitHub Projects V2 field
to determine issue ordering. Supported field types are integer numbers and
single-select or text fields with an explicit `option_rank_map`. Lower numeric
rank means higher priority. Issues without priority data fall back to
issue-number ordering.

**Startup Mirror:** On startup, GitHub-backed workflows create a local bare
mirror under `.tmp/github/upstream`. Per-issue workspaces clone from this
mirror instead of hitting GitHub directly, reducing API usage and improving
clone speed.

### 12.2 Linear

Linear support covers project-scoped work-item polling with configurable
active and terminal states.

**State Model:** Linear uses workflow states instead of labels:

- `active_states` (default: `Todo`, `In Progress`) — states that indicate
  work is eligible or in progress.
- `terminal_states` (default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`,
  `Done`) — states that indicate work is complete or abandoned.

**Handoff Mapping:** Linear workflow states map to Symphony handoff kinds:

- `Human Review` → `awaiting-human-handoff`
- `Rework` → `actionable-follow-up`
- `Merging` → `awaiting-system-checks`
- Terminal states (e.g. `Done`) → `handoff-ready`

**Workpad:** The Linear adapter writes a Symphony-owned workpad section into
the Linear issue description to keep branch and run context durable. This
workpad is a recovery hint, not the sole source of truth. A fresh factory can
recover handoff meaning from Linear workflow state plus repo-owned markers.

**API Key:** Linear requires an API key, configured as `tracker.api_key` in
frontmatter. Use `$LINEAR_API_KEY` syntax to resolve from the environment,
or omit the field to fall back to the `LINEAR_API_KEY` environment variable.

**Key Differences from GitHub:**

- Linear does not have a native PR-centric loop. The PR lifecycle tracking is
  less tightly integrated than with GitHub.
- Linear uses GraphQL for all API calls, not REST.
- Queue priority maps native Linear issue priority when
  `tracker.queue_priority.enabled: true`, without needing project field
  configuration.

## 13. Runner-Specific Guidance

### 13.1 Codex

Codex is Symphony's most feature-rich runner adapter. It uses a long-lived
`codex app-server` session per worker run rather than spawning separate
processes per turn.

**App-Server Model:** Keep `agent.command` in the familiar `codex exec ...`
shape. Symphony derives the app-server launch configuration (model, sandbox
policy, approval policy) from that command. Do not use `codex exec resume` or
other continuation-specific command shapes; the runner owns continuation
behavior internally.

**Continuation Turns:** Within a single run, Codex reuses one thread across all
continuation turns. Each turn sends an updated prompt reflecting the current PR
and review state. The app-server stays alive between turns, preserving thread
context.

**Token Accounting:** The Codex adapter captures token usage
(input, output, total) from the app-server's event stream. These metrics appear
in status snapshots, per-issue reports, and campaign digests. Rate-limit
pressure is also detected from Codex events and influences dispatch scheduling.

**Dynamic Tools:** Codex app-server sessions advertise a
`tracker_current_context` dynamic tool that returns sanitized current issue and
PR context through Symphony's runner/tracker boundary. This provides workers
with up-to-date context without shell affordances.

**Remote Execution:** Codex supports remote execution over SSH. Configure
`workspace.worker_hosts` with SSH destinations and set
`agent.runner.remote_execution` to route Codex sessions to remote machines.
The orchestrator stays local; only the workspace and runner process execute
remotely.

**Requirements:**

- `agent.command` must invoke the `codex` CLI
- Remote execution requires `workspace.repo_url` to be a remote URL (not a
  local path) and `agent.prompt_transport: stdin`

### 13.2 Claude Code

The Claude Code adapter provides first-class support for Anthropic's Claude
Code CLI as a runner.

**Command Shape:** The command must be headless and JSON-outputting:

```yaml
agent:
  runner:
    kind: claude-code
  command: claude -p --output-format json --permission-mode bypassPermissions --model sonnet
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 20
```

**Key constraints:**

- Use `claude -p` or `claude --print` for non-interactive mode
- Include `--output-format json` so Symphony can capture `session_id` for
  continuation turns and status artifacts
- Use non-interactive permissions (`--permission-mode bypassPermissions` or
  `--dangerously-skip-permissions`)
- Keep `agent.prompt_transport: stdin`
- Do not bake `--resume`, `--continue`, `--session-id`, or a prompt argument
  into `agent.command`; the runner owns those continuation details

**When to Use:** When Claude is the preferred model for a repository, or when
you want Claude-specific capabilities like subagent orchestration within
worker turns.

### 13.3 Generic Command

The generic-command runner provides raw subprocess execution for any CLI tool,
without runner-specific session management or event integration.

```yaml
agent:
  runner:
    kind: generic-command
    provider: pi
    model: pi-pro
  command: pi --print
  prompt_transport: stdin
  timeout_ms: 1800000
```

**When to Use:** When you want to use a backend that Symphony does not have a
first-class adapter for. The generic-command runner just spawns the subprocess,
pipes the prompt, and captures stdout/stderr.

**Limitations compared to first-class runners:**

- No structured event stream (token accounting, progress events)
- No session reuse across continuation turns
- No runner-specific dynamic tools
- `provider` and `model` are observability metadata only; they do not change
  subprocess behavior

## 14. Multi-Instance and Multi-Workflow Usage

One Symphony engine checkout can operate many repositories simultaneously.
Each target project owns its own `WORKFLOW.md` and its own instance-rooted
runtime state.

### Operating Multiple Repositories

Use the `--workflow` flag to select which instance to operate from a single
engine checkout:

```bash
# Start factories for multiple repositories
pnpm tsx bin/symphony.ts factory start --workflow ../repo-a/WORKFLOW.md
pnpm tsx bin/symphony.ts factory start --workflow ../repo-b/WORKFLOW.md
pnpm tsx bin/symphony.ts factory start --workflow ../repo-c/WORKFLOW.md

# Check status of each independently
pnpm tsx bin/symphony.ts factory status --workflow ../repo-a/WORKFLOW.md
pnpm tsx bin/symphony.ts factory status --workflow ../repo-b/WORKFLOW.md
```

Each factory runs its own detached session, its own poll loop, and its own
workspace tree. They do not share runtime state.

### Scaffolding New Instances

The `init` command scaffolds a `WORKFLOW.md` in a target repository:

```bash
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo
pnpm tsx bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo --runner claude-code
```

This creates a starter `WORKFLOW.md` that you should review and customize before
running agents.

### Organizational Patterns

**One workflow per target repository** — the recommended default. Each repo
contains its own `WORKFLOW.md`, making the factory configuration visible to
anyone working in that repo.

**Shared workflow-library directory** — a directory containing workflow files
for multiple repositories. Useful when one operator centrally manages several
factories:

```text
workflows/
  repo-a-WORKFLOW.md
  repo-b-WORKFLOW.md
  repo-c-WORKFLOW.md
```

Each workflow still defines its own instance root (the directory containing
the workflow file), so runtime state stays separated.

**Several concurrent local factories** — multiple `factory start` commands
running simultaneously from the same engine checkout. Each targets a different
`--workflow` path and operates independently.

### When Multi-Instance Becomes Operationally Confusing

Multi-instance operation works well when each factory is clearly scoped to one
repository. It becomes harder to manage when:

- Many factories share overlapping operational concern (common dependencies,
  shared CI, cross-repo changes)
- Operator status checking requires cycling through many `--workflow` paths
- Factory failures in one instance cascade to others through shared
  infrastructure

Start with one or two instances and scale up as operational confidence grows.

## 15. Examples

### Minimal GitHub Workflow

The simplest working `WORKFLOW.md` for a GitHub repository:

```yaml
---
tracker:
  kind: github
  repo: your-org/your-repo
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: "Fixed in PR #{{ pull_request.number }}"

polling:
  interval_ms: 30000
  max_concurrent_runs: 1
  retry:
    max_attempts: 3
    backoff_ms: 60000

workspace:
  root: ./.tmp/workspaces
  branch_prefix: symphony/

agent:
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -
  prompt_transport: stdin
  timeout_ms: 1800000
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
Issue Summary: {{ issue.summary }}

Rules:

1. Read `AGENTS.md` before making changes.
2. Create or reuse the issue branch.
3. Implement the issue completely, including tests.
4. Open a pull request against `main`.
5. Leave the workspace in a clean git state.
```

### Claude Code Workflow

Using Claude Code as the runner:

```yaml
---
tracker:
  kind: github
  repo: your-org/your-repo
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: "Completed in PR #{{ pull_request.number }}"

polling:
  interval_ms: 30000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    backoff_ms: 30000

workspace:
  root: ./.tmp/workspaces
  branch_prefix: symphony/

agent:
  runner:
    kind: claude-code
  command: claude -p --output-format json --permission-mode bypassPermissions --model sonnet
  prompt_transport: stdin
  timeout_ms: 1800000
  max_turns: 10
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
Issue Summary: {{ issue.summary }}

{% if pull_request %}
Pull Request: {{ pull_request.pullRequest.url }}
Status: {{ pull_request.kind }}
Failing checks: {{ pull_request.failingCheckNames | join: ", " }}
{% endif %}

Rules:

1. Read `AGENTS.md` before making changes.
2. Implement the issue, write tests, and open a PR.
3. If CI is failing, fix the failures and push.
4. Address any review feedback.
```

### Multi-Role Planner-Implementer-Editor Prompt

A prompt body using the recommended multi-role pattern:

```md
You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
Issue Summary: {{ issue.summary }}

{% if pull_request %}
Pull Request State:

- Status: {{ pull_request.kind }}
- URL: {{ pull_request.pullRequest.url }}
- Failing checks: {{ pull_request.failingCheckNames | join: ", " }}
- Actionable feedback: {{ pull_request.actionableReviewFeedback | size }}
  {% endif %}

Work through three phases in order:

## Phase 1: Planner

Read `AGENTS.md`, `README.md`, and relevant docs. Understand the codebase
and the issue requirements. Write a plan:

- What files need to change and why
- What tests need to be written
- What edge cases exist
- What is explicitly out of scope

Commit the plan to the issue branch before moving to Phase 2.

## Phase 2: Implementer

Follow the plan. Write code, write tests, run the test suite.
Do not skip tests. Do not leave TODOs for later.

Commit working code before moving to Phase 3.

## Phase 3: Editor

Review your own implementation:

- Does it match the plan?
- Are there unnecessary changes?
- Is the code simple and readable?
- Do the tests cover the important cases?
- Does it lint and typecheck cleanly?

Fix anything you find. Then open the PR.

Rules:

1. Work only inside this repository clone.
2. Open a pull request against `main` in {{ config.tracker.repo }}.
3. If the PR already exists, address CI or review feedback instead.
4. Leave the workspace in an inspectable git state.
```

### Linear Workflow

Using Linear as the tracker backend:

```yaml
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: your-project
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
  queue_priority:
    enabled: true

polling:
  interval_ms: 30000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    backoff_ms: 30000

workspace:
  root: ./.tmp/workspaces
  repo_url: git@github.com:your-org/your-repo.git
  branch_prefix: symphony/

agent:
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -
  prompt_transport: stdin
  timeout_ms: 1800000
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
Issue Summary: {{ issue.summary }}

Rules:

1. Read `AGENTS.md` before making changes.
2. Implement the issue and open a PR.
3. Leave the workspace in a clean git state.
```

Note: Linear-backed workflows require an explicit `workspace.repo_url` because
Symphony cannot derive a clone URL from Linear's project metadata.

### Remote Codex Execution

Running Codex on a remote SSH worker host:

```yaml
---
tracker:
  kind: github
  repo: your-org/your-repo
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: "Done"

polling:
  interval_ms: 30000
  max_concurrent_runs: 2
  retry:
    max_attempts: 2
    backoff_ms: 30000

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
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

(prompt body here)
```

## 16. Anti-Patterns

These are common mistakes that produce poor results or confusion.

### Giant Vague Prompts With No Completion Bar

A prompt that says "work on this issue" without defining what "done" means will
produce unpredictable results. Workers need explicit steps and explicit criteria
for when to stop.

**Fix:** Define the expected process (plan, implement, test, PR) and the
completion bar (tests pass, lint clean, PR opened with all checks green).

### Repo Policy Hidden Only in Prompt Text

If your repository has testing requirements, review standards, or architecture
rules, those belong in `AGENTS.md` where any contributor (human or agent) can
find them. Hiding policy only in the `WORKFLOW.md` prompt body means it is
invisible outside the factory context.

**Fix:** Put enduring policy in `AGENTS.md`. Have the prompt reference it with
"Read `AGENTS.md` before making changes."

### Using Prompt Prose to Paper Over Missing Runtime Invariants

If you find yourself writing "never merge without passing checks" or "always
wait for review approval" in your prompt, the runtime already enforces those
things. If the runtime does not enforce them, a prompt instruction is not a
reliable substitute.

**Fix:** Verify that the behavior is runtime-enforced (check gates, review
gates, landing gates). If it is not, file an issue for the missing runtime
invariant rather than relying on prompt compliance.

### Pretending Prompt-Level Role Sequencing Is True Workflow Topology

Multi-role prompt patterns (Section 11) are useful but not the same as
runtime-enforced stations. If the agent skips the "editor" role, the runtime
will not notice. Treating prompt roles as hard gates creates a false sense of
safety.

**Fix:** Use multi-role prompts for quality improvement, not for correctness
guarantees. If a transition must be enforced, it needs runtime support.

### Copying the Root `symphony-ts` Workflow Blindly

The root `WORKFLOW.md` in the `symphony-ts` repository is tailored for
Symphony's self-hosting loop. It includes plan-review protocols, specific skill
references, and documentation standards that do not apply to other repositories.

**Fix:** Use `symphony init` to scaffold a starter workflow, then customize the
prompt body for your repository's actual process and requirements.

### Overloading One Workflow for Multiple Concerns

Trying to make one `WORKFLOW.md` handle both feature development and maintenance
tasks with conditional prompt logic creates complexity that is hard to debug.

**Fix:** If two kinds of work need genuinely different processes, consider using
two separate workflows (one per concern) rather than one workflow with branching
prompt logic.

## 17. Migration Path

Moving from ad hoc agent usage to a structured factory is a progression, not a
binary switch. Each step adds structure only when the work justifies it.

### Stage 1: Ad Hoc Interactive Agent

You ask an agent for help with a specific task. The interaction is
conversational, exploratory, and human-steered at every step. This is
Agent World — the right place to start.

### Stage 2: Repeated Manual Interaction

You find yourself repeating the same kind of interaction: "update dependencies
in this repo," "fix the failing lint rules," "implement this type of feature."
The pattern is recognizable but not yet automated.

### Stage 3: Extract a Skill

You capture the repeatable pattern as a skill document — a checked-in guide
that describes the process explicitly enough that an agent (or a human) can
follow it consistently.

### Stage 4: Schedule or Trigger the Skill

You start running the skill on a schedule or in response to events. The work
is still agent-executed but the trigger is automatic. This is the beginning
of workflow thinking.

### Stage 5: Adopt a Factory

When the process is repeatable, multi-step, and worth enforcing, you wrap a
Symphony factory around it. The factory handles the coordination (polling,
claiming, workspace setup, retry, gates) while the prompt handles the work
instructions.

This is the transition from Agent World to Workflow World. The factory is for
workflows that are important enough to make structured, durable, and
autonomous.

### Stage 6: Richer Station-Defined Workflows (Future)

When the runtime supports configurable workflow stations with per-station
runners, prompts, and gates, you can move from prompt-level role sequencing
to true runtime-enforced topology. This is the future direction tracked in
[issue #234](https://github.com/sociotechnica-org/symphony-ts/issues/234).

Not every workflow needs to reach Stage 6. Many workflows work well at Stage 5
with prompt-level multi-role patterns and do not need runtime-enforced stations.

### Key Principle

Not every useful skill needs a factory. The factory is for workflows that are
important enough to make structured, durable, and autonomous. Keep using
interactive agents for exploratory work, one-off tasks, and processes that are
still evolving.

For more on the conceptual distinction between agent-shaped and factory-shaped
work, see [Why Factory](../concepts/why-factory.md).

## 18. Future Direction

Symphony's current runtime model is a single-prompt, single-runner,
PR-centric factory loop. This works well for the standard software delivery
workflow, and prompt-level multi-role patterns extend it meaningfully. But
some workflow shapes require capabilities that the current model does not
support.

### What Is Being Explored

[Issue #234](https://github.com/sociotechnica-org/symphony-ts/issues/234)
tracks the generalization of Symphony from a fixed PR lifecycle to configurable
multi-station workflows. The key ideas include:

- **Station definitions** as runtime data, each with its own prompt, runner
  configuration, and execution semantics.
- **Per-station runners and prompts** — different stages could use different
  models or different runner kinds.
- **Human gates as first-class workflow primitives** — not just plan review
  and landing, but arbitrary human approval points.
- **Typed station kinds** — agent execution, shell commands, human gates,
  conditional routing, parallel fork/join, child workflows.
- **Non-code workflows** — workflow shapes that do not end in a PR, such as
  content production or research pipelines.

### What This Means for `WORKFLOW.md` Today

The current `WORKFLOW.md` contract is stable and will continue to work.
Multi-station support, if it lands, would extend the contract rather than
replace it. A workflow that does not define stations would behave exactly as
it does today.

The best advice for current users: design your workflows for the current
runtime, use prompt-level multi-role patterns where they add value, and do not
pretend that prompt roles are runtime-enforced stations. When the runtime grows
station support, you will be able to adopt it incrementally.
