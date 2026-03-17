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
import type { TuiSnapshot } from "../../src/orchestrator/service.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const nowMs = Date.now();

// ─── Scenario 1: Active agents with Codex events ─────────────────────────────

const activeSnapshot: TuiSnapshot = {
  running: [
    {
      issueNumber: 9,
      identifier: "#9",
      issueState: "running",
      lifecycle: {
        status: "running",
        summary: "Runner is actively working",
        pullRequest: null,
        checks: { pendingNames: [], failingNames: [] },
        review: { actionableCount: 0, unresolvedThreadCount: 0 },
      },
      startedAt: new Date(nowMs - 45_000),
      retryAttempt: 1,
      sessionId: "smoke-sess-001",
      turnCount: 0,
      codexTokenState: "observed",
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
      runnerVisibility: null,
    },
    {
      issueNumber: 11,
      identifier: "#11",
      issueState: "running",
      lifecycle: {
        status: "awaiting-system-checks",
        summary: "Waiting for required checks",
        pullRequest: {
          number: 412,
          url: "https://github.com/sociotechnica-org/symphony-ts/pull/412",
          headSha: "abcdef123456",
          latestCommitAt: new Date().toISOString(),
        },
        checks: { pendingNames: ["build", "test"], failingNames: [] },
        review: { actionableCount: 0, unresolvedThreadCount: 0 },
      },
      startedAt: new Date(nowMs - 30_000),
      retryAttempt: 1,
      sessionId: "smoke-sess-002",
      turnCount: 1,
      codexTokenState: "pending",
      codexTotalTokens: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
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
      runnerVisibility: {
        state: "running",
        phase: "turn-execution",
        session: {
          provider: "codex",
          model: "gpt-5.4",
          backendSessionId: "thread-live-123-turn-1",
          backendThreadId: "thread-live-123",
          latestTurnId: "turn-1",
          appServerPid: 12346,
          latestTurnNumber: 1,
          logPointers: [],
        },
        lastHeartbeatAt: new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        lastActionSummary: "Codex app-server stdout activity",
        waitingReason: null,
        stdoutSummary:
          '{"method":"thread/started","params":{"thread":{"id":"thread-live-123"}}}',
        stderrSummary: null,
        errorSummary: null,
        cancelledAt: null,
        timedOutAt: null,
      },
    },
    {
      issueNumber: 13,
      identifier: "#13",
      issueState: "awaiting-landing",
      lifecycle: {
        status: "awaiting-landing",
        summary: "Waiting for a human merge",
        pullRequest: {
          number: 413,
          url: "https://github.com/sociotechnica-org/symphony-ts/pull/413",
          headSha: "fedcba654321",
          latestCommitAt: new Date().toISOString(),
        },
        checks: { pendingNames: [], failingNames: [] },
        review: { actionableCount: 1, unresolvedThreadCount: 2 },
      },
      startedAt: new Date(nowMs - 120_000),
      retryAttempt: 1,
      sessionId: "sess-xyz-789",
      turnCount: 2,
      codexTokenState: "observed",
      codexTotalTokens: 14400,
      codexInputTokens: 9600,
      codexOutputTokens: 4800,
      codexAppServerPid: null,
      lastCodexEvent: "codex/event/session.end",
      lastCodexMessage: {
        params: { msg: { payload: { type: "session.end" } } },
      },
      lastCodexTimestamp: new Date().toISOString(),
      runnerVisibility: null,
    },
  ],
  retrying: [
    {
      issueNumber: 7,
      identifier: "#7",
      nextAttempt: 2,
      retryClass: "run-failure",
      dueInMs: 8_000,
      lastError: "Runner exited with 1",
    },
  ],
  codexTotals: {
    inputTokens: 13600,
    outputTokens: 6800,
    totalTokens: 20400,
    pendingRunCount: 1,
    secondsRunning: 195,
  },
  rateLimits: {
    limitId: "core",
    primary: { used: 45, limit: 5000, resetInMs: 2400_000 },
    secondary: { used: 3, limit: 100, resetInMs: 60_000 },
    credits: "$4.32 / $50.00",
  },
  recoveryPosture: {
    summary: {
      family: "watchdog-recovery",
      summary:
        "2 issues currently reflect watchdog recovery or watchdog-driven retry posture.",
      issueCount: 2,
    },
    entries: [
      {
        family: "waiting-expected",
        issueNumber: 11,
        issueIdentifier: "sociotechnica-org/symphony-ts#11",
        title: "Wait for checks",
        source: "active-issue",
        summary: "Waiting for required checks",
        observedAt: new Date().toISOString(),
      },
      {
        family: "watchdog-recovery",
        issueNumber: 14,
        issueIdentifier: "sociotechnica-org/symphony-ts#14",
        title: "Recover a stalled runner",
        source: "retry-queue",
        summary:
          "Watchdog scheduled retry attempt 3 for sociotechnica-org/symphony-ts#14.",
        observedAt: new Date().toISOString(),
      },
    ],
  },
  lastAction: {
    kind: "awaiting-system-checks",
    summary: "PR #412 is waiting for required checks",
    at: new Date().toISOString(),
    issueNumber: 11,
  },
  polling: {
    checkingNow: false,
    nextPollAtMs: nowMs + 12_000,
    intervalMs: 30_000,
  },
  maxConcurrentRuns: 5,
  maxTurns: 3,
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
const idleSnapshot: TuiSnapshot = {
  running: [],
  retrying: [],
  codexTotals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    pendingRunCount: 0,
    secondsRunning: 0,
  },
  rateLimits: null,
  recoveryPosture: {
    summary: {
      family: "healthy",
      summary: "No active recovery posture is present.",
      issueCount: 0,
    },
    entries: [],
  },
  lastAction: null,
  polling: { checkingNow: true, nextPollAtMs: nowMs, intervalMs: 30_000 },
  maxConcurrentRuns: 3,
  maxTurns: 3,
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
