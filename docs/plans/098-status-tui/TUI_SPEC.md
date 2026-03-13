# Symphony Terminal UI (TUI) Specification

Status: Reference specification derived from the Elixir implementation

Purpose: Define the terminal-based status dashboard that provides real-time operator
visibility into Symphony's orchestration state. This spec assumes familiarity with
SPEC.md and that the orchestrator, config layer, and agent runner are already built.

## 1. Overview

The TUI is a GenServer (or equivalent long-running process) that periodically polls the
Orchestrator's snapshot and renders a full-screen ANSI terminal display. It is the
primary operator interface during local Symphony runs.

Key properties:

- **Observability-only.** The TUI reads orchestrator state but never mutates it. The
  orchestrator must function identically with or without the TUI running.
- **Pull-based with push hints.** The TUI polls on a configurable tick interval and also
  accepts push notifications (`notify_update`) that trigger an immediate re-render attempt.
- **Rate-limited rendering.** Output is throttled to avoid overwhelming the terminal with
  redraws when events arrive faster than the render interval.
- **Supervision-managed.** The TUI is a child of the application supervisor, started after
  the Orchestrator and HTTP server. It renders an "offline" frame on application shutdown.

## 2. Architecture and Data Flow

### 2.1 Where the TUI Sits

```
┌──────────────┐
│  Orchestrator │──── owns runtime state (running, retrying, codex_totals, rate_limits)
└──────┬───────┘
       │
       │  Orchestrator.snapshot()  (synchronous call, 15s timeout)
       │
┌──────▼───────────┐
│  StatusDashboard  │──── GenServer, renders to terminal
└──────┬───────────┘
       │
       │  IO.write (ANSI escape sequences)
       │
┌──────▼───────┐
│   Terminal    │
└──────────────┘
```

### 2.2 Data Source: Orchestrator Snapshot

The TUI's sole data source is `Orchestrator.snapshot()` (see SPEC.md Section 13.3). The
TUI calls this synchronously each render cycle. The snapshot returns:

```
%{
  running: [%RunningEntry{...}, ...],
  retrying: [%RetryEntry{...}, ...],
  codex_totals: %{input_tokens, output_tokens, total_tokens, seconds_running},
  rate_limits: %{limit_id, primary, secondary, credits} | nil,
  polling: %{checking?: boolean, next_poll_in_ms: integer} | nil
}
```

If the Orchestrator process is not registered or the call times out, the TUI renders a
degraded "snapshot unavailable" frame and continues ticking.

### 2.3 Push Notification Path

The Orchestrator calls `StatusDashboard.notify_update()` whenever state changes. This
function does two things:

1. Broadcasts on a PubSub topic (`"observability:dashboard"`) for web dashboard
   subscribers (outside scope of this spec).
2. Sends a `:refresh` message directly to the StatusDashboard process, triggering an
   immediate render attempt (subject to rate limiting).

The Orchestrator calls `notify_update` at these points:

- Poll tick start and completion
- Poll cycle completion (new issues fetched)
- Agent task exit (`:DOWN` monitor message)
- Worker runtime info received
- Codex worker update received (token counts, events)
- Retry processing

### 2.4 Supervision Tree Position

```
SymphonyElixir.Supervisor (one_for_one)
  ├── Phoenix.PubSub
  ├── Task.Supervisor
  ├── WorkflowStore
  ├── Orchestrator
  ├── HttpServer
  └── StatusDashboard    <── started last, depends on Orchestrator being registered
```

On application stop, `StatusDashboard.render_offline_status()` is called to display a
final "app_status=offline" frame before the process tree shuts down.

## 3. Configuration

The TUI reads its settings from the workflow config's `observability` section
(loaded via `Config.settings!().observability`):

| Field                | Type    | Default | Description                                       |
| -------------------- | ------- | ------- | ------------------------------------------------- |
| `dashboard_enabled`  | boolean | `true`  | Master enable/disable for the terminal dashboard  |
| `refresh_ms`         | integer | `1000`  | Interval between automatic tick-based refreshes   |
| `render_interval_ms` | integer | `16`    | Minimum time between rendered frames (~60fps cap) |

All three settings can be overridden via constructor options (useful for tests).

The TUI also auto-disables in the `:test` Mix environment to avoid polluting test output.

### 3.1 Config Hot-Reload

On every tick, the TUI re-reads the current config to pick up hot-reloaded workflow
changes. This means `dashboard_enabled`, `refresh_ms`, and `render_interval_ms` can
change at runtime without restarting the process.

## 4. Render Lifecycle

### 4.1 Tick Loop

```
init()
  → read config
  → schedule first :tick after refresh_ms

handle_info(:tick)
  → refresh_runtime_config()        # re-read hot config
  → maybe_render()                  # snapshot + format + rate-limit + output
  → schedule_tick(refresh_ms)       # loop

handle_info(:refresh)               # push from notify_update
  → refresh_runtime_config()
  → maybe_render()
  → (no reschedule — the tick loop continues independently)
```

### 4.2 Render Rate Limiting

The TUI uses a three-tier approach to avoid terminal thrashing:

1. **Snapshot fingerprinting.** The raw snapshot data is compared to the previous
   snapshot. If identical AND the minimum idle rerender interval (1 second) hasn't
   elapsed, the render is skipped entirely.

2. **Content deduplication.** The formatted string is compared to the last rendered
   string. If identical, no IO is performed.

3. **Flush timer throttling.** If a render is needed but `render_interval_ms` hasn't
   elapsed since the last render:
   - The content is stored as `pending_content`.
   - A `{:flush_render, timer_ref}` message is scheduled for the remaining interval.
   - Only one flush timer can be active at a time (subsequent updates overwrite
     `pending_content` but don't create new timers).
   - When the flush fires, the latest pending content is rendered.

This ensures the terminal is updated at most once per `render_interval_ms` while always
eventually showing the latest state.

### 4.3 Terminal Output

Rendering writes to stdout using ANSI escape sequences:

```
IO.write([
  IO.ANSI.home(),       # cursor to top-left (ESC[H)
  IO.ANSI.clear(),      # clear screen (ESC[2J)
  formatted_content,
  "\n"
])
```

The `render_fun` is injectable (defaults to `render_to_terminal/1`) so tests can
capture output without writing to the actual terminal.

## 5. Display Layout

The TUI renders a box-drawing frame with the following sections:

```
╭─ SYMPHONY STATUS
│ Agents: 3/5
│ Throughput: 1,234 tps
│ Runtime: 12m 34s
│ Tokens: in 45,678 | out 12,345 | total 58,023
│ Rate Limits: tier-4 | primary 890/1,000 reset 45s | secondary 8/10 reset 120s | credits unlimited
│ Project: https://linear.app/project/PROJ-SLUG/issues
│ Dashboard: http://127.0.0.1:4000/
│ Next refresh: 42s
├─ Running
│
│   ID       STAGE          PID      AGE / TURN   TOKENS     SESSION        EVENT
│   ──────────────────────────────────────────────────────────────────────────────────
│ ● MT-101   working        12345    2m 15s / 7       4,521  abc1...f2e3a1  turn completed (completed) (in 1,200, out 800)
│ ● MT-102   working        12346    1m 03s / 3       2,100  def4...89abcd  command output streaming
│ ● MT-103   starting       12347    0m 05s / 0           0  n/a            session started
│
├─ Backoff queue
│
│  ↻ MT-104 attempt=3 in 12.500s error=rate limited
│  ↻ MT-105 attempt=1 in 2.000s
╰─
```

### 5.1 Header Section

| Line         | Data Source                          | Formatting                                                    |
| ------------ | ------------------------------------ | ------------------------------------------------------------- |
| Agents       | `length(running)` / `max_concurrent` | Green count / gray max                                        |
| Throughput   | Rolling TPS (see Section 6)          | Cyan, comma-grouped integer                                   |
| Runtime      | `codex_totals.seconds_running`       | Magenta, `Xm Ys` format                                       |
| Tokens       | `codex_totals.*`                     | Yellow, comma-grouped, `in X \| out Y \| total Z`             |
| Rate Limits  | `snapshot.rate_limits`               | Composite: limit ID (yellow), buckets (cyan), credits (green) |
| Project      | `config.tracker.project_slug`        | Cyan URL or gray "n/a"                                        |
| Dashboard    | `config.server.host` + bound port    | Cyan URL or omitted if no server                              |
| Next refresh | `snapshot.polling`                   | Cyan countdown or "checking now..." or "n/a"                  |

### 5.2 Running Table

Each running agent is a row in a fixed-width columnar table:

| Column   | Width | Source Field                    | Notes                                     |
| -------- | ----- | ------------------------------- | ----------------------------------------- |
| Status   | 1     | `last_codex_event`              | Colored dot (● ) — see color map below    |
| ID       | 8     | `identifier`                    | Issue identifier (e.g., "MT-101")         |
| STAGE    | 14    | `state`                         | Orchestrator state for this session       |
| PID      | 8     | `codex_app_server_pid`          | OS PID of the agent process               |
| AGE/TURN | 12    | `runtime_seconds`, `turn_count` | `Xm Ys / N` format                        |
| TOKENS   | 10    | `codex_total_tokens`            | Right-aligned, comma-grouped              |
| SESSION  | 14    | `session_id`                    | Compacted: first 4 + "..." + last 6 chars |
| EVENT    | flex  | `last_codex_message`            | Fills remaining terminal width            |

The EVENT column width is computed dynamically:
`terminal_columns - fixed_column_widths - chrome_width` (minimum 12 characters).

Terminal width is detected via `:io.columns()`, falling back to the `COLUMNS` env var,
falling back to a default of 115.

#### Status Dot Color Map

| Condition                  | Color   |
| -------------------------- | ------- |
| No event yet (`:none`)     | Red     |
| `codex/event/token_count`  | Yellow  |
| `codex/event/task_started` | Green   |
| `turn_completed`           | Magenta |
| All other events           | Blue    |

Rows are sorted by `identifier` (ascending).

### 5.3 Backoff Queue

Each retrying entry is rendered as a single line:

```
│  ↻ {identifier} attempt={N} in {due_in_seconds}s [error={truncated_message}]
```

- Identifier in red, attempt in yellow, countdown in cyan, error in dim
- Error messages are sanitized (newlines → spaces, collapsed whitespace, truncated to 96 chars)
- Entries sorted by `due_in_ms` (ascending — soonest retry first)
- Empty queue shows: "No queued retries" (gray)

### 5.4 Empty States

- No running agents: "No active agents" (gray) replaces the table body
- No retrying entries: "No queued retries" (gray)
- Orchestrator unavailable: entire body replaced with "Orchestrator snapshot unavailable" (red)

## 6. Throughput Calculation

### 6.1 Rolling TPS

Token throughput is calculated as a rolling rate over a 5-second window:

```
samples = [{timestamp_ms, cumulative_total_tokens}, ...]

rolling_tps(samples, now_ms, current_tokens):
  prepend (now_ms, current_tokens) to samples
  prune samples older than 5 seconds
  if fewer than 2 samples: return 0.0
  oldest = last(samples)
  delta_tokens = current_tokens - oldest.tokens
  elapsed_ms = now_ms - oldest.timestamp
  return delta_tokens / (elapsed_ms / 1000.0)
```

### 6.2 TPS Throttling

To avoid jitter in the display, TPS is recalculated at most once per wall-clock second.
Within the same second, the previous value is reused.

### 6.3 Sparkline Graph (Internal)

Token samples are retained for a 10-minute window (longer than the 5-second TPS window)
to support a sparkline throughput graph. The graph divides the window into 24 buckets,
computes average TPS per bucket, and maps values to Unicode block characters:
`▁ ▂ ▃ ▄ ▅ ▆ ▇ █`

## 7. Humanized Event Summaries

The EVENT column displays a human-readable summary of the last Codex protocol message
received for each running agent. This is a pure formatting function with no side effects.

### 7.1 Event Taxonomy

Events are classified by their `method` field or wrapper event suffix:

| Protocol Method / Event                          | Humanized Output                                    |
| ------------------------------------------------ | --------------------------------------------------- |
| `thread/started`                                 | "thread started (thread_id)"                        |
| `turn/started`                                   | "turn started (turn_id)"                            |
| `turn/completed`                                 | "turn completed (status) (in X, out Y)"             |
| `turn/failed`                                    | "turn failed: error_message"                        |
| `turn/cancelled`                                 | "turn cancelled"                                    |
| `turn/diff/updated`                              | "turn diff updated (N lines)"                       |
| `turn/plan/updated`                              | "plan updated (N steps)"                            |
| `thread/tokenUsage/updated`                      | "thread token usage updated (in X, out Y, total Z)" |
| `item/started`, `item/completed`                 | "item started/completed: type (id, status)"         |
| `item/agentMessage/delta`                        | "agent message streaming: preview..."               |
| `item/commandExecution/requestApproval`          | "command approval requested (command)"              |
| `item/commandExecution/outputDelta`              | "command output streaming"                          |
| `item/fileChange/requestApproval`                | "file change approval requested (N files)"          |
| `item/tool/requestUserInput`                     | "tool requires user input: question"                |
| `item/tool/call`                                 | "dynamic tool call requested (tool_name)"           |
| `account/updated`                                | "account updated (auth mode)"                       |
| `account/rateLimits/updated`                     | "rate limits updated: summary"                      |
| Wrapper: `codex/event/task_started`              | "task started"                                      |
| Wrapper: `codex/event/user_message`              | "user message received"                             |
| Wrapper: `codex/event/token_count`               | "token count update (in X, out Y, total Z)"         |
| Wrapper: `codex/event/exec_command_begin`        | "command_text" (extracted from parsed_cmd)          |
| Wrapper: `codex/event/exec_command_end`          | "command completed (exit N)"                        |
| Wrapper: `codex/event/mcp_startup_update`        | "mcp startup: server_name state"                    |
| Wrapper: `codex/event/mcp_startup_complete`      | "mcp startup complete"                              |
| Wrapper: `codex/event/agent_message_delta`       | "agent message streaming: preview..."               |
| Wrapper: `codex/event/agent_reasoning_delta`     | "reasoning streaming: preview..."                   |
| Wrapper: `codex/event/exec_command_output_delta` | "command output streaming"                          |

### 7.2 Field Extraction Strategy

Codex protocol messages arrive with inconsistent key conventions (string vs atom keys,
camelCase vs snake_case). The humanizer uses a lenient multi-key lookup strategy:

- `map_value(map, ["key_name", :key_name, "keyName", :keyName])` — tries each key
  in order, returns first non-nil match.
- `map_path(map, ["params", "nested", "field"])` — walks a nested path with automatic
  string/atom key fallback at each level.

This makes the TUI resilient to protocol variations without requiring strict schema
enforcement on incoming events.

### 7.3 Text Sanitization

All humanized output is:

- Collapsed to single-line (newlines → spaces, whitespace collapsed)
- ANSI escape sequences stripped
- Control characters removed
- Truncated to 140 characters max for the event summary, 80 for inline text previews

## 8. ANSI Color Palette

The TUI uses standard ANSI escape codes (no 256-color or truecolor):

| Semantic Use        | ANSI Code |
| ------------------- | --------- |
| Reset               | `\e[0m`   |
| Bold/Bright         | `\e[1m`   |
| Dim/Faint           | `\e[2m`   |
| Red (errors)        | `\e[31m`  |
| Green (healthy)     | `\e[32m`  |
| Yellow (tokens)     | `\e[33m`  |
| Blue (active)       | `\e[34m`  |
| Magenta (runtime)   | `\e[35m`  |
| Cyan (links/tps)    | `\e[36m`  |
| Gray (chrome/muted) | `\e[90m`  |

Every colorized segment is wrapped: `{color_code}{text}\e[0m`.

## 9. CLI Entrypoint

The CLI module (`CLI`) is the escript entrypoint that starts the full application
(including the TUI). It is separate from the TUI GenServer.

### 9.1 Startup Flow

```
main(args)
  → parse CLI switches
  → require --i-understand-that-this-will-be-running-without-the-usual-guardrails
  → set workflow file path
  → optionally set --logs-root and --port
  → Application.ensure_all_started(:symphony_elixir)
  → wait_for_shutdown()  (monitors Supervisor, blocks until exit)
```

### 9.2 Guardrails Banner

If the acknowledgement flag is missing, the CLI renders a styled warning box using
Unicode box-drawing characters (`╭╮╰╯─│`) in bold red, explaining that the user must
opt in.

### 9.3 Shutdown

The CLI monitors the application supervisor. When it exits:

- Normal exit → `halt(0)`
- Abnormal exit → `halt(1)`

The application's `stop/1` callback calls `StatusDashboard.render_offline_status()` to
display a final offline frame before the terminal is released.

## 10. Testability

The TUI is designed for testability without requiring a real terminal:

- **Render function injection:** `render_fun` option in `start_link` allows tests to
  capture rendered strings instead of writing to stdout.
- **Config overrides:** `refresh_ms`, `enabled`, and `render_interval_ms` can be
  overridden via constructor options.
- **Auto-disable in test:** The TUI checks `Mix.env() != :test` and disables itself
  in test mode (overridable via `enabled: true` option).
- **Public test helpers:** Several private functions are exposed with `_for_test`
  suffixes for unit testing formatting logic:
  - `format_snapshot_content_for_test/2,3`
  - `format_running_summary_for_test/1,2`
  - `format_tps_for_test/1`
  - `tps_graph_for_test/3`
  - `format_timestamp_for_test/1`
  - `dashboard_url_for_test/3`
  - `rolling_tps/3` (public, `@doc false`)
  - `throttled_tps/5` (public, `@doc false`)

## 11. Implementation Checklist

For an agent building this TUI from SPEC.md:

1. **Add observability config fields** to the config schema: `dashboard_enabled` (bool,
   default true), `refresh_ms` (int, default 1000), `render_interval_ms` (int, default 16).

2. **Implement the GenServer** with the tick/refresh/flush_render message handlers as
   described in Section 4.

3. **Wire `Orchestrator.snapshot/0`** as the data source. The snapshot shape is defined in
   SPEC.md Section 13.3. Handle `:unavailable` and `:timeout` gracefully.

4. **Add `notify_update/0`** to the StatusDashboard module. Call it from every Orchestrator
   state-change point (poll tick, task exit, worker update, codex update, retry processing).

5. **Add the StatusDashboard to the supervision tree** as the last child. Call
   `render_offline_status()` in the application `stop/1` callback.

6. **Implement the formatter** following the layout in Section 5. Use ANSI codes from
   Section 8. Compute column widths dynamically based on terminal width.

7. **Implement rolling TPS** per Section 6. Maintain a sample buffer of
   `(timestamp, cumulative_tokens)` pairs.

8. **Implement humanized event summaries** per Section 7. Use lenient multi-key lookup
   to handle string/atom and camelCase/snake_case variations in Codex protocol messages.

9. **Implement render rate limiting** per Section 4.2 — snapshot fingerprinting, content
   deduplication, and flush timer throttling.

10. **Add the CLI entrypoint** per Section 9, including the guardrails acknowledgement
    banner.
