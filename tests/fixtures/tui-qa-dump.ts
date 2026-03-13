/**
 * TUI QA dump — renders TUI frames to plain text for visual inspection.
 *
 * Run from repo root:
 *   npx tsx tests/fixtures/tui-qa-dump.ts
 *
 * Produces ANSI-stripped frames for three scenarios:
 *   1. Active agents with Codex JSON-RPC events (multi-agent)
 *   2. Idle factory (no agents running)
 *   3. Offline (orchestrator snapshot unavailable)
 *
 * Also prints a table of event humanization samples to verify the
 * event → human-readable label pipeline.
 *
 * Use this to visually QA TUI changes without needing a live factory.
 * Compare output against the Elixir reference in issue #98.
 */

import {
  formatSnapshotContent,
  humanizeEvent,
} from "../../src/observability/tui.js";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const nowMs = Date.now();

// ─── Scenario 1: Active agents with Codex events ─────────────────────────────

const activeSnapshot = {
  running: [
    {
      issueNumber: 9,
      identifier: "#9",
      issueState: "running",
      startedAt: new Date(nowMs - 45_000),
      retryAttempt: 1,
      sessionId: "smoke-sess-001",
      turnCount: 0,
      codexTotalTokens: 6000,
      codexInputTokens: 4000,
      codexOutputTokens: 2000,
      codexAppServerPid: 12345,
      lastCodexEvent: "codex/event/reasoning",
      lastCodexMessage: {
        params: {
          msg: {
            payload: {
              type: "reasoning",
              text: "Analyzing the codebase step 5...",
            },
          },
        },
      },
      lastCodexTimestamp: new Date().toISOString(),
    },
    {
      issueNumber: 11,
      identifier: "#11",
      issueState: "running",
      startedAt: new Date(nowMs - 30_000),
      retryAttempt: 1,
      sessionId: "smoke-sess-002",
      turnCount: 1,
      codexTotalTokens: 3600,
      codexInputTokens: 2400,
      codexOutputTokens: 1200,
      codexAppServerPid: 12346,
      lastCodexEvent: "codex/event/exec_command_begin",
      lastCodexMessage: {
        params: {
          msg: {
            payload: { type: "exec_command_begin", command: "git status" },
          },
        },
      },
      lastCodexTimestamp: new Date().toISOString(),
    },
    {
      issueNumber: 13,
      identifier: "#13",
      issueState: "awaiting-landing",
      startedAt: new Date(nowMs - 120_000),
      retryAttempt: 1,
      sessionId: "sess-xyz-789",
      turnCount: 2,
      codexTotalTokens: 14400,
      codexInputTokens: 9600,
      codexOutputTokens: 4800,
      codexAppServerPid: null,
      lastCodexEvent: "codex/event/session.end",
      lastCodexMessage: {
        params: { msg: { payload: { type: "session.end" } } },
      },
      lastCodexTimestamp: new Date().toISOString(),
    },
  ],
  retrying: [
    {
      issueNumber: 7,
      identifier: "#7",
      nextAttempt: 2,
      dueInMs: 8_000,
      lastError: "Runner exited with 1",
    },
  ],
  codexTotals: {
    inputTokens: 16000,
    outputTokens: 8000,
    totalTokens: 24000,
    secondsRunning: 195,
  },
  rateLimits: {
    limitId: "core",
    primary: { used: 45, limit: 5000, resetInMs: 2400_000 },
    secondary: { used: 3, limit: 100, resetInMs: 60_000 },
    credits: "$4.32 / $50.00",
  },
  polling: {
    checkingNow: false,
    nextPollAtMs: nowMs + 12_000,
    intervalMs: 30_000,
  },
  maxConcurrentRuns: 5,
  projectUrl: "https://github.com/sociotechnica-org/symphony-ts-test",
};

console.log("=== SCENARIO 1: Active agents (120 cols) ===\n");
console.log(
  stripAnsi(
    formatSnapshotContent(
      activeSnapshot,
      342,
      120,
      "▁▁▂▃▃▄▅▆▆▇▇█▇▆▅▅▄▃▃▂▂▁▁▁",
      nowMs,
    ),
  ),
);

console.log("\n\n=== SCENARIO 1b: Active agents (80 cols, narrow) ===\n");
console.log(
  stripAnsi(formatSnapshotContent(activeSnapshot, 342, 80, "▁▂▃▄▅▆▇█", nowMs)),
);

// ─── Scenario 2: Idle factory ─────────────────────────────────────────────────

console.log("\n\n=== SCENARIO 2: Idle (no agents) ===\n");
const idleSnapshot = {
  running: [],
  retrying: [],
  codexTotals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  },
  rateLimits: null,
  polling: { checkingNow: true, nextPollAtMs: nowMs, intervalMs: 30_000 },
  maxConcurrentRuns: 3,
  projectUrl: null,
};
console.log(stripAnsi(formatSnapshotContent(idleSnapshot, 0, 120, "", nowMs)));

// ─── Scenario 3: Offline ─────────────────────────────────────────────────────

console.log("\n\n=== SCENARIO 3: Offline ===\n");
console.log(stripAnsi(formatSnapshotContent(null, 0, 120, "", nowMs)));

// ─── Event humanization table ─────────────────────────────────────────────────

console.log("\n\n=== EVENT HUMANIZATION SAMPLES ===\n");
const events: ReadonlyArray<readonly [string | null, unknown]> = [
  ["codex/event/session.start", {}],
  [
    "codex/event/reasoning",
    {
      params: {
        msg: { payload: { text: "Analyzing the codebase..." } },
      },
    },
  ],
  [
    "codex/event/exec_command_begin",
    { params: { msg: { payload: { command: "git diff HEAD~1" } } } },
  ],
  [
    "codex/event/exec_command_end",
    { params: { msg: { payload: { exit_code: 0 } } } },
  ],
  ["codex/event/session.end", {}],
  [
    "turn/completed",
    {
      method: "turn/completed",
      params: {
        usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
      },
    },
  ],
  [
    "turn/failed",
    {
      method: "turn/failed",
      params: { error: { message: "context window exceeded" } },
    },
  ],
  [
    "codex/event/token_count",
    {
      params: {
        tokenUsage: {
          total: {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
          },
        },
      },
    },
  ],
  [null, null],
];

for (const [eventType, msg] of events) {
  console.log(
    `  ${String(eventType).padEnd(40)} → ${humanizeEvent(msg, eventType)}`,
  );
}
