# Observability — TUI Dashboard

The Status TUI (`tui.ts`) renders a live terminal dashboard during factory runs.
It is pull-based (polls `orchestrator.snapshot()` on a tick) and push-aware
(accepts `refresh()` calls on state changes).

## Testing the TUI

### Unit tests

```bash
pnpm test -- tests/unit/tui.test.ts
```

Covers: frame rendering, event humanization, TPS calculation, sparkline,
dashboard lifecycle, fingerprint dedup, and a realistic multi-agent scenario.

### Visual QA (plain-text dump)

To inspect rendered frames without a live terminal:

```bash
npx tsx tests/fixtures/tui-qa-dump.ts
```

This renders three scenarios (active agents, idle, offline) at different
terminal widths and prints an event humanization table. Output is
ANSI-stripped plain text. Use this to visually verify layout, column
alignment, event labels, and token formatting after making TUI changes.

Compare output against the Elixir reference screenshot in issue #98.

### Live smoke test against a real GitHub repo

Prerequisites:

- A GitHub test repo (e.g. `sociotechnica-org/symphony-ts-test`) with labels
  `symphony:ready`, `symphony:running`, `symphony:failed`
- Open issues labeled `symphony:ready`
- `GH_TOKEN` set in environment

1. Create a temp directory with a `WORKFLOW.md`:

```yaml
---
tracker:
  kind: github
  repo: sociotechnica-org/symphony-ts-test
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
polling:
  interval_ms: 5000
  max_concurrent_runs: 2
  retry:
    max_attempts: 2
    backoff_ms: 5000
workspace:
  root: ./.tmp/workspaces
  repo_url: https://github.com/sociotechnica-org/symphony-ts-test.git
  branch_prefix: symphony/
  retention:
    on_success: delete
    on_failure: retain
hooks:
  after_create: []
agent:
  runner:
    kind: generic-command
  command: /path/to/tests/fixtures/fake-agent-codex-events.sh
  prompt_transport: stdin
  timeout_ms: 120000
  max_turns: 3
  env: {}
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 200
---
You are working on issue {{ issue.identifier }}: {{ issue.title }}.
```

2. Run the factory:

```bash
cd /path/to/temp-dir
npx tsx /path/to/bin/symphony.ts run \
  --config WORKFLOW.md \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

The `fake-agent-codex-events.sh` fixture emits Codex-style JSON-RPC events
with incrementing token counts over ~20 seconds, then commits and creates a
PR. This exercises: session start/end, reasoning events with token usage,
exec command begin/end, and the full agent handoff lifecycle.

### What to verify

When QA'ing the TUI (either via the dump script or live):

- **Header**: Agents count/max, Throughput (tps) with sparkline, Runtime,
  Tokens (in/out/total with commas), Rate Limits, Project URL, Next refresh
- **Running table**: All columns (ID, STAGE, PID, AGE/TURN, TOKENS, SESSION,
  EVENT) aligned; event labels are human-readable (not raw JSON-RPC methods)
- **Event humanization**: `reasoning update: ...`, `git status`,
  `command completed (exit 0)`, `session started`, `turn completed (...)`
- **Responsive width**: EVENT column expands/contracts with terminal width
- **Edge cases**: no agents → "No active agents"; null PID/session → "n/a";
  no events yet → "no codex message yet"
- **Backoff queue**: retry entries with attempt count, countdown, error text
- **Offline frame**: `app_status=offline` when stopped

## Architecture

- `formatSnapshotContent()` — pure function, takes a snapshot + TPS + width,
  returns a string. All rendering tests use this directly.
- `StatusDashboard` class — manages tick loop, fingerprint dedup, TPS
  sampling, sparkline buckets, and render throttling.
- `humanizeEvent()` — maps raw Codex event types to human-readable labels.
- Event flow: agent stdout → `tryParseStdoutEvent` (local-execution.ts) →
  `integrateCodexUpdate` (running-entry.ts) → `snapshot()` → TUI render.

Codex JSON-RPC events arrive as `{"method":"notifications/message","params":{"msg":{"payload":{"type":"reasoning",...}}}}`.
The runner extracts `params.msg.payload.type` and prefixes it with
`codex/event/` so the TUI's `humanizeWrapperEvent` can dispatch on the suffix.
Token counts are extracted from `params.msg.payload.total_token_usage.*`.
