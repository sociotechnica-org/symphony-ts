# WORKFLOW Frontmatter Reference

This document is the exhaustive frontmatter reference for `WORKFLOW.md`.

Use it alongside:

- [Workflow Guide](./workflow-guide.md) for narrative guidance, workflow
  shapes, and runtime-fit discussion
- [README](../../README.md) for quick-start setup and the most common config
  patterns

This reference is written against the current workflow-config contract in:

- [src/config/workflow.ts](../../src/config/workflow.ts) for the stable public
  loader entrypoint
- `src/config/workflow-source.ts` and `src/config/workflow-resolver.ts` for
  the current frontmatter parsing and typed-resolution seams
- [src/domain/workflow.ts](../../src/domain/workflow.ts) for the typed runtime
  contract

It is intentionally focused on YAML frontmatter only. The markdown body below
the frontmatter is documented in the workflow guide.

## File Shape

Every `WORKFLOW.md` must start with YAML frontmatter delimited by `---`,
followed by the markdown prompt body:

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
observability:
  dashboard_enabled: true
---

# Worker prompt body goes here
```

The frontmatter must parse to a YAML mapping/object. A missing or malformed
frontmatter block is invalid.

This `File Shape` example is abbreviated to show structure only. For a complete
working config, see [Minimal GitHub Example](#minimal-github-example) below.

## Top-Level Sections

The parser recognizes these top-level sections:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `observability`

All other runtime behavior comes from the markdown prompt body, checked-in repo
docs, or code-level invariants.

## Full Reference

### `tracker`

Selects the tracker backend and tracker-owned workflow policy surface.

#### `tracker.kind`

- Type: string
- Supported values:
  - `github`
  - `github-bootstrap`
  - `linear`
- Default when omitted: `github-bootstrap`

`github-bootstrap` remains the compatibility default for Symphony’s
self-hosting bootstrap path. New third-party GitHub workflows should normally
prefer `github`.

#### GitHub-backed tracker fields

These fields apply to `tracker.kind: github` and `tracker.kind: github-bootstrap`.

##### `tracker.repo`

- Type: non-empty string
- Required: yes
- Example: `your-org/your-repo`

Can also be overridden by the `SYMPHONY_REPO` environment variable. When that
env var is set, it overrides `tracker.repo` for GitHub-backed trackers and
also drives the derived clone URL.

##### `tracker.api_url`

- Type: non-empty string
- Required: yes
- Example: `https://api.github.com`

Must be a valid URL. Symphony derives the default Git clone URL from this host
plus `tracker.repo`.

##### `tracker.ready_label`

- Type: non-empty string
- Required: yes
- Example: `symphony:ready`

##### `tracker.running_label`

- Type: non-empty string
- Required: yes
- Example: `symphony:running`

##### `tracker.failed_label`

- Type: non-empty string
- Required: yes
- Example: `symphony:failed`

##### `tracker.success_comment`

- Type: non-empty string
- Required: yes

The success comment Symphony leaves when the issue completes.

##### `tracker.review_bot_logins`

- Type: string array
- Required: no
- Default: `[]`

Bot identities whose review feedback should be treated as automated review
surface rather than human review.

##### `tracker.approved_review_bot_logins`

- Type: string array
- Required: no
- Default: `[]`

Reviewer-app identities that count toward the required approved reviewer-app
coverage policy. If you configure expected approved review bots, Symphony can
block landing when none of them have produced qualifying output on the current
PR head.

##### `tracker.reviewer_apps`

- Type: object
- Required: no
- Default: omitted

Preferred first-class reviewer-app policy config for GitHub-backed trackers.
Each key enables a built-in reviewer adapter and declares whether its verdict
is accepted for actionable feedback and/or required before landing.

Supported keys in this slice:

- `devin`

Example:

```yaml
tracker:
  reviewer_apps:
    devin:
      accepted: true
      required: true
```

###### `tracker.reviewer_apps.<key>.accepted`

- Type: boolean
- Required: no
- Default: `true`

When true, an explicit reviewer-app `issues-found` verdict counts as actionable
feedback and can drive `rework-required`.

###### `tracker.reviewer_apps.<key>.required`

- Type: boolean
- Required: no
- Default: `false`

When true, Symphony requires current-head reviewer coverage and an explicit
`pass` verdict before the PR can become landable. `required: true` currently
also requires `accepted: true`.

##### `tracker.queue_priority`

- Type: object
- Required: no

GitHub queue-priority config:

###### `tracker.queue_priority.enabled`

- Type: boolean
- Required: yes when `tracker.queue_priority` is present

###### `tracker.queue_priority.project_number`

- Type: integer
- Required: yes when `enabled: true`

GitHub Project V2 project number.

###### `tracker.queue_priority.field_name`

- Type: non-empty string
- Required: yes when `enabled: true`

The Project field to read for priority.

###### `tracker.queue_priority.option_rank_map`

- Type: object mapping string keys to integer values
- Required: no

Used for single-select or text priority fields. Lower numeric rank means
higher scheduling priority.

If `enabled: false`, the GitHub queue-priority object may omit the other
fields.

##### `tracker.respect_blocked_relationships`

- Type: boolean
- Required: no
- Default: `false`

GitHub-only dispatch guard. When enabled, Symphony still requires the ready
label, but it also reads GitHub issue relationship data and treats any issue
with one or more open blockers as non-dispatchable. `fetchReadyIssues()` and
`claimIssue()` both honor this flag. When the flag is disabled, Symphony
preserves label-only behavior; if dependency reads are available it still
normalizes blocker references onto returned issues, and older or
feature-limited GitHub instances fall back to empty blocker lists instead of
failing ordinary reads. Enabled mode fails closed if blocker data cannot be
read from GitHub and surfaces an explicit configuration hint instead of
silently dispatching blocked work.

##### `tracker.plan_review`

- Type: object
- Required: no
- Default: omitted, which preserves Symphony's built-in plan-review protocol

Workflow-owned override surface for the technical-plan review handoff on
GitHub-backed and Linear trackers. When omitted, Symphony preserves the
current built-in `Plan status: plan-ready` / `Plan review: ...` protocol.

Supported keys:

- `plan_ready_signal`
- `legacy_plan_ready_signals`
- `approved_signal`
- `changes_requested_signal`
- `waived_signal`
- `metadata_labels`
- `review_reply_guidance`
- `reply_template_block`

Example:

```yaml
tracker:
  plan_review:
    plan_ready_signal: "Review status: plan-ready"
    legacy_plan_ready_signals: []
    approved_signal: "Review verdict: approved"
    changes_requested_signal: "Review verdict: changes-requested"
    waived_signal: "Review verdict: waived"
    metadata_labels:
      plan_path: "Plan file"
      branch_name: "Issue branch"
      plan_url: "Plan link"
      branch_url: "Branch link"
      compare_url: "Compare link"
```

###### `tracker.plan_review.plan_ready_signal`

- Type: non-empty string
- Required: no
- Default: `Plan status: plan-ready`

###### `tracker.plan_review.legacy_plan_ready_signals`

- Type: string array
- Required: no
- Default: `[Plan ready for review.]`

Use `[]` to disable the built-in legacy compatibility marker entirely.

###### `tracker.plan_review.approved_signal`

- Type: non-empty string
- Required: no
- Default: `Plan review: approved`

###### `tracker.plan_review.changes_requested_signal`

- Type: non-empty string
- Required: no
- Default: `Plan review: changes-requested`

###### `tracker.plan_review.waived_signal`

- Type: non-empty string
- Required: no
- Default: `Plan review: waived`

###### `tracker.plan_review.metadata_labels`

- Type: object
- Required: no
- Default: built-in labels shown below

Supported keys:

- `plan_path` default `Plan path`
- `branch_name` default `Branch`
- `plan_url` default `Plan URL`
- `branch_url` default `Branch URL`
- `compare_url` default `Compare URL`

###### `tracker.plan_review.review_reply_guidance`

- Type: non-empty string
- Required: no
- Default: derived from the configured review-decision markers

This is the note inserted above the reply-template block in the worker's
plan-ready comment.

###### `tracker.plan_review.reply_template_block`

- Type: non-empty string
- Required: no
- Default: a Markdown fenced-block template derived from the configured
  review-decision markers

Override this when the repository wants a different reviewer reply template
than the built-in approved / changes-requested / waived block.

#### Linear tracker fields

These fields apply to `tracker.kind: linear`.

##### `tracker.endpoint`

- Type: URL string
- Required: no
- Default: `https://api.linear.app/graphql`

##### `tracker.api_key`

- Type: string or `$ENV_VAR`
- Required: yes, unless `LINEAR_API_KEY` is set

If the value is written as `$LINEAR_API_KEY`-style syntax, Symphony resolves it
from the environment. If omitted entirely, Symphony falls back to
`LINEAR_API_KEY`.

##### `tracker.project_slug`

- Type: non-empty string
- Required: yes

##### `tracker.assignee`

- Type: string or `$ENV_VAR`
- Required: no
- Default: `null`

##### `tracker.active_states`

- Type: non-empty string array
- Required: no
- Default:
  - `Todo`
  - `In Progress`

##### `tracker.terminal_states`

- Type: non-empty string array
- Required: no
- Default:
  - `Closed`
  - `Cancelled`
  - `Canceled`
  - `Duplicate`
  - `Done`

##### `tracker.queue_priority`

- Type: object
- Required: no

Linear queue-priority config currently supports only:

###### `tracker.queue_priority.enabled`

- Type: boolean
- Required: yes when `tracker.queue_priority` is present

When enabled, Symphony maps supported native Linear priority data into the
shared queue-priority contract.

### `polling`

Controls factory poll cadence, concurrency, retry, and watchdog behavior.

#### `polling.interval_ms`

- Type: number
- Required: yes

#### `polling.max_concurrent_runs`

- Type: number
- Required: yes
- Must be `>= 1`

#### `polling.retry`

- Type: object
- Required: yes

##### `polling.retry.max_attempts`

- Type: number
- Required: yes
- Must be `>= 1`

##### `polling.retry.backoff_ms`

- Type: number
- Required: yes

##### Unsupported legacy field

`polling.retry.max_follow_up_attempts` is no longer supported. Review and
rework continuation is tracker-driven now, and the parser will fail if that
field appears.

#### `polling.watchdog`

- Type: object
- Required: no

If omitted, no watchdog config is attached to the resolved workflow.

##### `polling.watchdog.enabled`

- Type: boolean
- Required: no
- Default: `true`

When `enabled: true`, the watchdog section requires the remaining fields.

##### `polling.watchdog.check_interval_ms`

- Type: integer
- Required:
  - yes when watchdog is enabled
  - no when `enabled: false`
- Disabled fallback default: `60000`

##### `polling.watchdog.stall_threshold_ms`

- Type: integer
- Required:
  - yes when watchdog is enabled
  - no when `enabled: false`
- Disabled fallback default: `300000`

Acts as the compatibility baseline. If the phase-specific fields below are
omitted, Symphony uses this value for both active execution and PR
follow-through.

##### `polling.watchdog.execution_stall_threshold_ms`

- Type: integer
- Required: no
- Default: `polling.watchdog.stall_threshold_ms`

Applies while an active run has not yet reached PR follow-through.

##### `polling.watchdog.pr_follow_through_stall_threshold_ms`

- Type: integer
- Required: no
- Default: `polling.watchdog.stall_threshold_ms`

Applies while an active run already has an open PR and is following through on
review/check context.

##### `polling.watchdog.max_recovery_attempts`

- Type: integer
- Required:
  - yes when watchdog is enabled
  - no when `enabled: false`
- Must be `>= 0`
- Disabled fallback default: `2`

### `workspace`

Controls workspace location, clone source, branch naming, retention, and
remote worker-host definitions.

#### `workspace.root`

- Type: non-empty string
- Required: yes

Resolved relative to the instance root, not the engine checkout.

#### `workspace.repo_url`

- Type: string
- Required:
  - no for GitHub-backed trackers when Symphony can derive a clone URL
  - yes for non-GitHub trackers

Accepted forms:

- remote URL with scheme, such as `https://...`
- SCP-style Git URL, such as `git@github.com:org/repo.git`
- local filesystem path, resolved relative to the directory containing
  `WORKFLOW.md`

Important behavior:

- for GitHub-backed trackers, Symphony derives the clone URL from
  `tracker.api_url` and `tracker.repo`
- if `SYMPHONY_REPO` is set for a GitHub-backed tracker, the derived clone URL
  wins over an explicit `workspace.repo_url`
- Codex SSH remote execution requires `workspace.repo_url` to resolve to a
  remote clone URL, not a local path

#### `workspace.branch_prefix`

- Type: non-empty string
- Required: yes
- Example: `symphony/`

#### `workspace.retention`

- Type: object
- Required: no

Defaults:

- `on_success: delete`
- `on_failure: retain`

##### `workspace.retention.on_success`

- Type: enum
- Allowed values:
  - `delete`
  - `retain`

##### `workspace.retention.on_failure`

- Type: enum
- Allowed values:
  - `delete`
  - `retain`

#### `workspace.cleanup_on_success`

- Type: boolean
- Required: no
- Compatibility alias for `workspace.retention.on_success`

If present and `workspace.retention.on_success` is omitted:

- `true` becomes `delete`
- `false` becomes `retain`

#### `workspace.worker_hosts`

- Type: object keyed by worker-host name
- Required: no
- Default: `{}`

Each worker host supports:

##### `workspace.worker_hosts.<name>.ssh_destination`

- Type: non-empty string
- Required: yes

##### `workspace.worker_hosts.<name>.ssh_executable`

- Type: string
- Required: no
- Default: `ssh`

##### `workspace.worker_hosts.<name>.ssh_options`

- Type: string array
- Required: no
- Default: `[]`

##### `workspace.worker_hosts.<name>.workspace_root`

- Type: non-empty string
- Required: yes

### `hooks`

Optional shell hooks currently supported at workspace creation time.

#### `hooks.after_create`

- Type: string array
- Required: no
- Default: `[]`

### `agent`

Controls the runner provider, command shape, prompt transport, timeout, turn
budget, and env injection.

#### `agent.command`

- Type: non-empty string
- Required: yes

This remains the primary runner command contract. Symphony may infer runner
kind from the command when `agent.runner` is omitted.

#### `agent.prompt_transport`

- Type: enum
- Required: yes
- Allowed values:
  - `stdin`
  - `file`

#### `agent.timeout_ms`

- Type: number
- Required: yes

Applies per runner turn. A run with `agent.max_turns > 1` can consume multiple
timeout windows across continuation turns.

#### `agent.max_turns`

- Type: number
- Required: no
- Default: `1`
- Must be an integer `>= 1`

#### `agent.env`

- Type: object
- Required: no
- Default: `{}`

Values are stringified into the runner environment. For GitHub-backed trackers,
Symphony also injects `GITHUB_REPO=<tracker.repo>`.

#### `agent.runner`

- Type: object
- Required: no

If omitted, Symphony infers the runner:

- `codex` when `agent.command` resolves to the `codex` executable
- otherwise `generic-command`

##### `agent.runner.kind`

- Type: enum
- Required: yes when `agent.runner` is present
- Allowed values:
  - `codex`
  - `generic-command`
  - `claude-code`

If `kind: codex`, `agent.command` must invoke the `codex` CLI.

If `kind: claude-code`, `agent.command` must invoke the `claude` CLI.

##### `agent.runner.kind: codex`

Supports optional remote execution:

###### `agent.runner.remote_execution`

- Type: object
- Required: no

###### `agent.runner.remote_execution.kind`

- Type: enum
- Required: yes when `remote_execution` is present
- Allowed values:
  - `ssh`

###### `agent.runner.remote_execution.worker_hosts`

- Type: string array
- Required: no
- Must contain at least one defined `workspace.worker_hosts` entry

###### `agent.runner.remote_execution.worker_host`

- Type: string
- Required: no
- Must match one defined `workspace.worker_hosts` entry

`worker_hosts` and `worker_host` are mutually exclusive.

Remote-execution constraints:

- `workspace.repo_url` must be remote, not local
- `agent.prompt_transport` must be `stdin`

##### `agent.runner.kind: generic-command`

Optional metadata fields:

###### `agent.runner.provider`

- Type: string
- Required: no
- Default: `null`

###### `agent.runner.model`

- Type: string
- Required: no
- Default: `null`

These are observability metadata only; they do not change subprocess behavior.

##### `agent.runner.kind: claude-code`

No additional runner-specific YAML fields are currently defined. The command
shape is still important:

- use `claude -p` / `claude --print`
- include `--output-format json`
- keep it non-interactive

### `observability`

Controls local TUI/status behavior.

#### `observability.dashboard_enabled`

- Type: boolean-like
- Required: no
- Default: `true`

The parser accepts:

- omitted -> `true`
- `false` -> `false`
- `"false"` -> `false`
- any other present value -> truthy / `true`

#### `observability.refresh_ms`

- Type: number
- Required: no
- Default: `1000`

#### `observability.render_interval_ms`

- Type: number
- Required: no
- Default: `16`

#### `observability.issue_reports`

- Type: object
- Required: no
- Default: omitted

Controls automatic per-issue report generation and optional archive
publication after terminal issue outcomes.

##### `observability.issue_reports.archive_root`

- Type: string
- Required: no
- Default: omitted

When configured, Symphony attempts to publish each terminal issue report into
the checked-out `factory-runs` archive rooted at this path after generating or
refreshing the local report. Relative paths resolve from the repository that
owns `WORKFLOW.md`.

If omitted, Symphony still generates the local terminal issue report
automatically, but publication stays manual through `symphony-report publish`.

## Minimal GitHub Example

```yaml
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
```

## GitHub With Review Bots And Queue Priority

```yaml
tracker:
  kind: github
  repo: your-org/your-repo
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: "Implemented in PR #{{ pull_request.number }}"
  review_bot_logins:
    - cursor
    - devin-ai-integration
  approved_review_bot_logins:
    - devin-ai-integration
  reviewer_apps:
    devin:
      accepted: true
      required: true
  respect_blocked_relationships: true
  queue_priority:
    enabled: true
    project_number: 7
    field_name: Priority
    option_rank_map:
      P0: 0
      P1: 1
      P2: 2
```

## Linear Example

```yaml
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
```

## Codex SSH Remote Execution Example

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
```

## Constraints And Invalid Combinations

- `tracker.repo` is required for GitHub-backed trackers unless provided through
  `SYMPHONY_REPO`
- `workspace.repo_url` is required for non-GitHub trackers
- `agent.prompt_transport` must be `stdin` or `file`
- `agent.max_turns` must be an integer `>= 1`
- `polling.max_concurrent_runs` must be `>= 1`
- `polling.retry.max_attempts` must be `>= 1`
- `polling.watchdog.check_interval_ms` must be an integer `> 0`
- `polling.watchdog.stall_threshold_ms` must be an integer `> 0`
- `polling.watchdog.execution_stall_threshold_ms` must be an integer `> 0`
- `polling.watchdog.pr_follow_through_stall_threshold_ms` must be an integer `> 0`
- `polling.watchdog.max_recovery_attempts` must be an integer `>= 0`
- `agent.runner.kind: codex` requires `agent.command` to invoke `codex`
- `agent.runner.kind: claude-code` requires `agent.command` to invoke `claude`
- `agent.runner.remote_execution.worker_host` and
  `agent.runner.remote_execution.worker_hosts` cannot both be set
- remote Codex execution requires:
  - `workspace.repo_url` to be remote
  - `agent.prompt_transport: stdin`

## Maintenance Note

This document is hand-maintained today. Follow-up issue [#236](https://github.com/sociotechnica-org/symphony-ts/issues/236)
tracks generating or mechanically validating this reference from code/tests so
it stays parser-aligned.
