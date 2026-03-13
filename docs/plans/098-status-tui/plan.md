# Plan: Status TUI for the Factory (#98)

Status: implemented

## Summary

Port the Elixir `StatusDashboard` GenServer to TypeScript as a `StatusDashboard`
class in `src/observability/tui.ts`. The TUI is a pull-based terminal renderer that
periodically calls `Orchestrator.snapshot()` and writes a full-screen ANSI display
showing running agents, the backoff queue, token throughput, and poll state.

Spec: `.context/attachments/TUI_SPEC.md`
Reference: `../symphony/elixir/lib/symphony_elixir/status_dashboard.ex`

## Scope

- Add `ObservabilityConfig` to workflow domain and config loader
- Add `onUpdate` callback to runner interface; implement line-by-line JSON event
  streaming in `LocalRunner`
- Add `RunningEntry` state to orchestrator (per-issue Codex state: tokens, turns,
  last event)
- Add `snapshot()` method to `BootstrapOrchestrator`
- Add `notifyUpdate()` calls at all state-change points in the orchestrator
- Implement `StatusDashboard` with tick loop, push-refresh, rate-limited rendering,
  TPS calculation, event humanizer, and ANSI formatter
- Wire TUI startup into the `run` CLI command

## Non-goals

- Web/HTTP dashboard
- PubSub infrastructure
- Remote runner support

## Symphony Abstraction Layer Mapping

| Layer         | Work in this PR                                          |
| ------------- | -------------------------------------------------------- |
| Configuration | Add `observability` section to `ResolvedConfig`          |
| Integration   | Add `onUpdate` hook to Runner; parse Codex stdout events |
| Coordination  | Add `RunningEntry` map, `snapshot()`, polling flags      |
| Execution     | No changes                                               |
| Observability | New `StatusDashboard` (TUI renderer), file-based log redirection |

## Current Gaps

The following are missing from the TypeScript factory and must be added:

1. **Runner `onUpdate` hook** — `LocalRunner` collects stdout as a buffer. It needs
   to stream line-by-line and try to parse each line as a JSON Codex event, calling
   `onUpdate` per event. This is the TS equivalent of Elixir's
   `codex_message_handler` / `:codex_worker_update` pattern.

2. **`RunningEntry` state** — `OrchestratorState` has `runningIssueNumbers:
Set<number>` but no per-issue Codex state. Needs a `runningEntries: Map<number,
RunningEntry>` with `sessionId`, `turnCount`, `codexTotalTokens`, `lastCodexEvent`,
   `lastCodexMessage`, `codexAppServerPid`.

3. **Orchestrator `snapshot()` method** — no equivalent exists in TypeScript.

4. **Aggregate `codexTotals`** — `{inputTokens, outputTokens, totalTokens,
secondsRunning}` accumulated across all running agents, reset on poll cycle.

5. **`rateLimits` state** — extracted from Codex update events; not tracked yet.

6. **Polling state flags** — `checkingNow: boolean` and `nextPollInMs: number`
   not currently exposed.

7. **`ObservabilityConfig` in workflow config** — `ResolvedConfig` has no
   `observability` section (`dashboardEnabled`, `refreshMs`, `renderIntervalMs`).

## Architecture Boundaries

```
LocalRunner
  └── onUpdate(event) ──────────────────────────────────┐
                                                        ▼
BootstrapOrchestrator                          OrchestratorState
  ├── runningEntries: Map<id, RunningEntry>    (RunningEntry per issue)
  ├── codexTotals: CodexTotals
  ├── rateLimits: RateLimits | null
  ├── pollingState: PollingState
  ├── snapshot(): TuiSnapshot | "unavailable"
  └── notifyUpdate() ──────────────────────────────────┐
                                                       ▼
                                             StatusDashboard
                                               └── renders to stdout (ANSI)
```

- The TUI reads orchestrator state but never mutates it.
- The orchestrator snapshot is synchronous in Elixir (GenServer.call); in TS it is
  a direct method call on the same object (synchronous, no timeout needed).
- The TUI runs as a `setInterval`-based tick loop in the same Node.js process,
  started after the orchestrator is created.

## Implementation Steps

### Step 1 — Config: Add `ObservabilityConfig`

`src/domain/workflow.ts`:

```ts
export interface ObservabilityConfig {
  readonly dashboardEnabled: boolean;
  readonly refreshMs: number;
  readonly renderIntervalMs: number;
}

// Add to ResolvedConfig:
readonly observability: ObservabilityConfig;
```

`src/config/workflow.ts`: parse `observability:` YAML section with defaults
(dashboardEnabled=true, refreshMs=1000, renderIntervalMs=16).

### Step 2 — Runner: Add `onUpdate` callback and `RunUpdateEvent`

`src/domain/run.ts`:

```ts
export interface RunUpdateEvent {
  readonly event: string; // event type from Codex JSON
  readonly payload: unknown; // raw parsed JSON message
  readonly timestamp: string;
}
```

`src/runner/service.ts`:

```ts
export interface RunnerRunOptions {
  readonly signal?: AbortSignal;
  readonly onSpawn?: (event: RunSpawnEvent) => void | Promise<void>;
  readonly onUpdate?: (event: RunUpdateEvent) => void; // NEW
}
```

`src/runner/local.ts`: Replace `stdout += chunk.toString()` with a line buffer.
On each newline, attempt `JSON.parse`. If successful, call `onUpdate` with the
parsed event. Also accumulate raw stdout for `RunResult` as before.

### Step 3 — Orchestrator: `RunningEntry` and state extensions

New file `src/orchestrator/running-entry.ts`:

```ts
export interface RunningEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly startedAt: Date;
  readonly retryAttempt: number;
  sessionId: string | null;
  turnCount: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  codexLastReportedInputTokens: number;
  codexLastReportedOutputTokens: number;
  codexLastReportedTotalTokens: number;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexMessage: unknown | null;
  lastCodexTimestamp: string | null;
}
```

`src/orchestrator/state.ts`:

- Add `runningEntries: Map<number, RunningEntry>`
- Add `codexTotals: CodexTotals` (aggregated tokens + secondsRunning)
- Add `rateLimits: RateLimits | null`
- Add `pollingState: PollingState` (checkingNow, nextPollAtMs, intervalMs)

### Step 4 — Orchestrator: `snapshot()` and `notifyUpdate()`

`src/orchestrator/service.ts`:

- Add `snapshot(): TuiSnapshot | "unavailable"` — returns running entries,
  retries, codexTotals, rateLimits, pollingState
- Add `notifyUpdate(dashboard: StatusDashboard | null): void` — calls
  `dashboard.refresh()` if set
- Call `notifyUpdate` at: poll tick start, poll tick end, agent spawn, agent exit,
  `onUpdate` events, retry scheduling

### Step 5 — TUI: `StatusDashboard`

New file `src/observability/tui.ts`:

State:

- `refreshMs`, `enabled`, `renderIntervalMs` (from config + overrides)
- `renderFn: (content: string) => void` (injectable for tests)
- `tokenSamples: Array<[timestampMs, totalTokens]>` (rolling 5s TPS window)
- `lastTpsSecond: number | null`, `lastTpsValue: number`
- `lastRenderedContent: string | null`, `lastRenderedAtMs: number | null`
- `pendingContent: string | null`, `flushTimerRef: NodeJS.Timeout | null`
- `lastSnapshotFingerprint: string | null`

Public API:

- `start(): void` — schedule first tick
- `stop(): void` — clear timers, render offline frame
- `refresh(): void` — push-triggered re-render (rate-limited)
- `renderOfflineStatus(): void` — render final offline frame on shutdown

Internal:

- `tick()` — re-read config, maybe render, schedule next tick
- `maybeRender()` — snapshot → format → rate-limit → output
- `renderNow(content: string)` — write ANSI to terminal
- `formatSnapshot(snapshot)` — full formatter (see Section 5 of spec)
- `formatRunningRows(running, terminalCols)` — table rows
- `formatRetryRows(retrying)` — backoff queue rows
- `humanizeEvent(message)` — event taxonomy (Section 7 of spec)
- `rollingTps(samples, nowMs, currentTokens)` — Section 6.1
- `throttledTps(samples, nowMs, currentTokens, lastSecond, lastValue)` — Section 6.2

ANSI helpers:

- Inline constants: `RED`, `GREEN`, `YELLOW`, `BLUE`, `MAGENTA`, `CYAN`, `GRAY`,
  `BOLD`, `DIM`, `RESET` using raw escape codes from spec Section 8.
- `GRAY` uses `\x1b[2;37m` (dim white) instead of `\x1b[90m` (bright black) to
  remain visible on dark terminal themes.
- No external terminal library.

### Log Redirection

When the TUI is active, all logger output is redirected to a file to prevent
JSON log lines from flashing between TUI frames:

- `src/observability/logger.ts` exposes `setLogFile(path)` / `getLogFilePath()`
- `StatusDashboard.start()` calls `setLogFile(<workspace_root>/symphony.log)`
- `StatusDashboard.stop()` calls `setLogFile(null)` and prints the log file path
- This matches the Elixir reference which removes the console log handler at
  startup and writes exclusively to disk

### Sparkline

Implemented as a rolling bucket sparkline using Unicode block characters
(`▁▂▃▄▅▆▇█`). TPS samples are bucketed into 25 time slots and rendered inline
in the header next to the throughput value.

### Step 6 — CLI: Wire TUI startup

`src/cli/index.ts`: After creating the orchestrator, create `StatusDashboard` with
the orchestrator's `snapshot` bound as the data source. Pass the dashboard to the
orchestrator so it can call `notifyUpdate`. Call `dashboard.stop()` on shutdown.

## Tests

Unit tests (`tests/unit/tui.test.ts`):

- `formatSnapshotContent` with sample data → expected content (pure function, no IO)
- `humanizeEvent` for each event type in taxonomy including Codex JSON-RPC wrapper
  events (`codex/event/session.start`, `session.end`, `reasoning`,
  `exec_command_begin`, `exec_command_end`)
- `rollingTps` edge cases (empty, single sample, window prune)
- `throttledTps` — same-second caching
- Snapshot fingerprinting — no re-render on identical data
- Content deduplication — no IO on identical formatted string
- Flush timer throttling — pending content flushed after `renderIntervalMs`
- Offline frame renders "app_status=offline"
- Multi-agent realistic scenario with all TUI sections exercised

Unit tests (`tests/unit/running-entry.test.ts`):

- Nested Codex JSON-RPC token extraction (`params.msg.payload.total_token_usage.*`)
- Session ID extraction from nested JSON-RPC payload

Visual QA (`tests/fixtures/tui-qa-dump.ts`):

- Renders three scenarios (active agents, idle, offline) at 120 and 80 col widths
- Strips ANSI for plain-text inspection
- Prints event humanization table
- Run with: `npx tsx tests/fixtures/tui-qa-dump.ts`

Live smoke test (`tests/fixtures/fake-agent-codex-events.sh`):

- Emits realistic Codex JSON-RPC event stream over ~20 seconds
- Exercises session start/end, reasoning, exec commands, token usage
- Can be used as the agent command in a real factory run

See `src/observability/README.md` for the full testing approach.

## Acceptance Criteria

- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes (including new unit + integration tests)
- Factory runs with TUI enabled show the box-drawing frame with running agents table
  and backoff queue on the terminal
- Factory runs with TUI disabled (or in test mode via `enabled: false`) produce no
  terminal output from the TUI
- `stop()` renders an offline frame

## Exit Criteria

- All tests pass
- PR opened against `main`
- CI green

## Deferred

- Web dashboard / PubSub (Section 2.3 broadcast path) — separate issue
- Remote runner TUI integration — local only for now
