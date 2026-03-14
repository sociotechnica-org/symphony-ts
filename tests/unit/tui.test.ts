import { describe, expect, it } from "vitest";
import {
  formatSnapshotContent,
  humanizeEvent,
  rollingTps,
  StatusDashboard,
  throttledTps,
  tpsSparkline,
} from "../../src/observability/tui.js";
import type { TuiSnapshot } from "../../src/orchestrator/service.js";
import type { ObservabilityConfig } from "../../src/domain/workflow.js";
import type { RunnerVisibilitySnapshot } from "../../src/runner/service.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
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
    lastAction: null,
    polling: {
      checkingNow: false,
      nextPollAtMs: Date.now() + 30_000,
      intervalMs: 30_000,
    },
    maxConcurrentRuns: 5,
    maxTurns: 3,
    projectUrl: null,
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ObservabilityConfig> = {},
): ObservabilityConfig {
  return {
    dashboardEnabled: true,
    refreshMs: 1000,
    renderIntervalMs: 16,
    ...overrides,
  };
}

function makeRunnerVisibility(
  overrides: Partial<RunnerVisibilitySnapshot> = {},
): RunnerVisibilitySnapshot {
  return {
    state: "running",
    phase: "turn-execution",
    session: {
      provider: "codex",
      model: "gpt-5.4",
      backendSessionId: "thread-abc-turn-1",
      backendThreadId: "thread-abc",
      latestTurnId: "turn-1",
      appServerPid: 12345,
      latestTurnNumber: 1,
      logPointers: [],
    },
    lastHeartbeatAt: "2026-03-13T10:00:05.000Z",
    lastActionAt: "2026-03-13T10:00:05.000Z",
    lastActionSummary: "Codex app-server stdout activity",
    waitingReason: null,
    stdoutSummary: null,
    stderrSummary: null,
    errorSummary: null,
    cancelledAt: null,
    timedOutAt: null,
    ...overrides,
  };
}

// ─── formatSnapshotContent ────────────────────────────────────────────────────

describe("formatSnapshotContent", () => {
  it("renders offline frame when snapshot is null", () => {
    const output = formatSnapshotContent(null, 0);
    expect(output).toContain("SYMPHONY STATUS");
    expect(output).toContain("Orchestrator snapshot unavailable");
    expect(output).toContain("╰─");
  });

  it("renders header with agent count and tokens", () => {
    const snapshot = makeSnapshot({
      codexTotals: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        pendingRunCount: 0,
        secondsRunning: 125,
      },
    });
    const output = formatSnapshotContent(snapshot, 250);
    expect(output).toContain("Agents:");
    expect(output).toContain("Throughput:");
    expect(output).toContain("250"); // tps
    expect(output).toContain("Runtime:");
    expect(output).toContain("2m 5s");
    expect(output).toContain("Tokens:");
    expect(output).toContain("1,500"); // total
  });

  it("renders header last-action details when present", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        lastAction: {
          kind: "watchdog-recovery",
          issueNumber: 133,
          summary: "Recovered a stalled runner",
          at: "2026-03-14T10:00:00.000Z",
        },
      }),
      0,
      undefined,
      undefined,
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("Last action:");
    expect(output).toContain("watchdog-recovery #133");
    expect(output).toContain("Recovered a stalled runner");
    expect(output).toContain("(3m 0s ago)");
  });

  it("omits duplicated last-action detail when summary is blank", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        lastAction: {
          kind: "watchdog-recovery",
          issueNumber: 133,
          summary: "   ",
          at: "2026-03-14T10:00:00.000Z",
        },
      }),
      0,
      undefined,
      undefined,
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("Last action:");
    expect(output).toContain("watchdog-recovery #133");
    expect(output).not.toContain("watchdog-recovery #133 | watchdog-recovery");
    expect(output).toContain("(3m 0s ago)");
  });

  it("renders Running section with no active agents message", () => {
    const output = formatSnapshotContent(makeSnapshot(), 0);
    expect(output).toContain("Running");
    expect(output).toContain("No active agents");
  });

  it("renders running agent row", () => {
    const snapshot = makeSnapshot({
      running: [
        {
          issueNumber: 1,
          identifier: "MT-101",
          issueState: "In Progress",
          startedAt: new Date(Date.now() - 75_000), // 1m 15s ago
          retryAttempt: 1,
          sessionId: "abcdef1234567890",
          turnCount: 3,
          codexTokenState: "observed",
          codexTotalTokens: 4521,
          codexInputTokens: 2000,
          codexOutputTokens: 2521,
          codexAppServerPid: 12345,
          lastCodexEvent: "turn/completed",
          lastCodexMessage: {
            method: "turn_completed",
            params: {
              usage: {
                inputTokens: 2000,
                outputTokens: 2521,
                totalTokens: 4521,
              },
            },
          },
          lastCodexTimestamp: null,
          runnerVisibility: null,
        },
      ],
    });
    const output = formatSnapshotContent(snapshot, 0, 200);
    expect(output).toContain("MT-101");
    expect(output).toContain("In Progress");
    expect(output).toContain("12345");
    expect(output).toContain("4,521");
    expect(output).toContain("abcd...567890");
  });

  it("renders pending token semantics for live Codex activity before token-bearing events", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: "thread/started",
            lastCodexMessage: {
              method: "thread/started",
              params: { thread: { id: "thread-live-123" } },
            },
            lastCodexTimestamp: "2026-03-14T10:00:05.000Z",
            runnerVisibility: makeRunnerVisibility({
              stdoutSummary: JSON.stringify({
                method: "thread/started",
                params: { thread: { id: "thread-live-123" } },
              }),
            }),
          },
        ],
        codexTotals: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          pendingRunCount: 1,
          secondsRunning: 30,
        },
      }),
      0,
      220,
      "",
      new Date("2026-03-14T10:00:30.000Z").getTime(),
    );

    expect(output).toContain("in pending");
    expect(output).toContain("out pending");
    expect(output).toContain("total pending");
    expect(output).toContain("thread started (thread-live-123)");
    expect(output).toContain("pending");
    expect(output).not.toContain(" total 0");
  });

  it("renders observed totals plus pending aggregate context when another live run is still pending", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "observed",
            codexTotalTokens: 700,
            codexInputTokens: 500,
            codexOutputTokens: 200,
            codexAppServerPid: 12345,
            lastCodexEvent: "codex/event/token_count",
            lastCodexMessage: {
              params: {
                tokenUsage: {
                  total: {
                    input_tokens: 500,
                    output_tokens: 200,
                    total_tokens: 700,
                  },
                },
              },
            },
            lastCodexTimestamp: "2026-03-14T10:00:10.000Z",
            runnerVisibility: null,
          },
          {
            issueNumber: 134,
            identifier: "#134",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12346,
            lastCodexEvent: "thread/started",
            lastCodexMessage: {
              method: "thread/started",
              params: { thread: { id: "thread-live-124" } },
            },
            lastCodexTimestamp: "2026-03-14T10:00:05.000Z",
            runnerVisibility: null,
          },
        ],
        codexTotals: {
          inputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
          pendingRunCount: 1,
          secondsRunning: 30,
        },
      }),
      0,
    );

    expect(output).toContain("in 500");
    expect(output).toContain("out 200");
    expect(output).toContain("total 700");
    expect(output).toContain("1 pending");
  });

  it("renders final totals numerically without a pending marker", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "completed",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: "session-123",
            turnCount: 1,
            codexTokenState: "final",
            codexTotalTokens: 1500,
            codexInputTokens: 1000,
            codexOutputTokens: 500,
            codexAppServerPid: null,
            lastCodexEvent: "turn/completed",
            lastCodexMessage: { method: "turn/completed" },
            lastCodexTimestamp: "2026-03-14T10:00:10.000Z",
            runnerVisibility: makeRunnerVisibility({
              state: "completed",
              phase: "turn-finished",
            }),
          },
        ],
        codexTotals: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          pendingRunCount: 0,
          secondsRunning: 30,
        },
      }),
      0,
    );

    expect(output).toContain("1,500");
    expect(output).not.toContain("pending");
  });

  it("renders lifecycle stage from normalized active-issue status", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            lifecycle: {
              status: "awaiting-system-checks",
              summary: "Waiting for required checks",
              pullRequest: {
                number: 412,
                url: "https://github.com/sociotechnica-org/symphony-ts/pull/412",
                headSha: "abcdef123456",
                latestCommitAt: "2026-03-14T10:00:00.000Z",
              },
              checks: {
                pendingNames: ["build", "test"],
                failingNames: [],
              },
              review: {
                actionableCount: 0,
                unresolvedThreadCount: 0,
              },
            },
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "observed",
            codexTotalTokens: 2200,
            codexInputTokens: 1100,
            codexOutputTokens: 1100,
            codexAppServerPid: null,
            lastCodexEvent: "turn/completed",
            lastCodexMessage: { method: "turn/completed" },
            lastCodexTimestamp: "2026-03-14T10:02:00.000Z",
            runnerVisibility: makeRunnerVisibility({
              state: "waiting",
              phase: "awaiting-external",
              session: {
                ...makeRunnerVisibility().session,
                provider: "claude-code",
                model: "sonnet",
                backendSessionId: "claude-session-1",
                backendThreadId: null,
                latestTurnNumber: 1,
              },
              waitingReason: "Waiting for CI",
              lastActionSummary: "Waiting for required checks",
            }),
          },
        ],
      }),
      0,
      200,
      "",
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("system-checks");
    expect(output).toContain("PR #412");
    expect(output).toContain("checks p2 f0");
  });

  it("renders turn budget as turn n/N", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        maxTurns: 3,
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 2,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: "turn/completed",
            lastCodexMessage: { method: "turn/completed" },
            lastCodexTimestamp: "2026-03-14T10:02:00.000Z",
            runnerVisibility: makeRunnerVisibility({
              session: {
                ...makeRunnerVisibility().session,
                latestTurnNumber: 2,
              },
            }),
          },
        ],
      }),
      0,
      200,
      "",
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("turn 2/3");
  });

  it("shows provider-model context and backend session identity", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: makeRunnerVisibility({
              session: {
                ...makeRunnerVisibility().session,
                provider: "codex",
                model: "gpt-5.4",
                backendSessionId: "thread-live-123-turn-2",
                backendThreadId: "thread-live-123",
                latestTurnNumber: 2,
              },
              stdoutSummary: JSON.stringify({
                method: "thread/started",
                params: { thread: { id: "thread-live-123" } },
              }),
            }),
          },
        ],
      }),
      0,
      220,
      "",
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("codex/gpt-5.4");
    expect(output).toContain("thre...turn-2");
    expect(output).toContain("thread started (thread-live-123)");
  });

  it("does not append running lifecycle summary to live runner activity", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            lifecycle: {
              status: "running",
              summary: "Runner is actively working",
              pullRequest: null,
              checks: {
                pendingNames: [],
                failingNames: [],
              },
              review: {
                actionableCount: 0,
                unresolvedThreadCount: 0,
              },
            },
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: makeRunnerVisibility({
              lastActionSummary: "Executing turn 2",
              session: {
                ...makeRunnerVisibility().session,
                provider: "codex",
                model: "sonnet",
                latestTurnNumber: 2,
              },
            }),
          },
        ],
      }),
      0,
      220,
      "",
      new Date("2026-03-14T10:03:00.000Z").getTime(),
    );

    expect(output).toContain("codex/sonnet");
    expect(output).toContain("Executing turn 2");
    expect(output).not.toContain("Runner is actively working");
  });

  it("omits heuristic turn display when only pid or legacy event exists", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        maxTurns: 2,
        running: [
          {
            issueNumber: 133,
            identifier: "#133",
            issueState: "running",
            startedAt: new Date("2026-03-14T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 0,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: "thread/started",
            lastCodexMessage: { method: "thread/started" },
            lastCodexTimestamp: "2026-03-14T10:00:01.000Z",
            runnerVisibility: null,
          },
        ],
      }),
      0,
      220,
      "",
      new Date("2026-03-14T10:00:02.000Z").getTime(),
    );

    expect(output).not.toContain("turn 1/2");
  });

  it("renders agents count with max", () => {
    const snapshot = makeSnapshot({ maxConcurrentRuns: 5 });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("0");
    expect(output).toMatch(/Agents:.*\/.*5/);
  });

  it("renders project URL when present", () => {
    const snapshot = makeSnapshot({
      projectUrl: "https://linear.app/project/PROJ/issues",
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("Project:");
    expect(output).toContain("https://linear.app/project/PROJ/issues");
  });

  it("omits project line when projectUrl is null", () => {
    const output = formatSnapshotContent(makeSnapshot({ projectUrl: null }), 0);
    expect(output).not.toContain("Project:");
  });

  it("renders Backoff queue with no retries message", () => {
    const output = formatSnapshotContent(makeSnapshot(), 0);
    expect(output).toContain("Backoff queue");
    expect(output).toContain("No queued retries");
  });

  it("renders retry entry with error", () => {
    const snapshot = makeSnapshot({
      retrying: [
        {
          issueNumber: 2,
          identifier: "MT-102",
          nextAttempt: 3,
          dueInMs: 12_500,
          lastError: "rate limited",
        },
      ],
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("MT-102");
    expect(output).toContain("attempt=3");
    expect(output).toContain("13s");
    expect(output).toContain("error=rate limited");
  });

  it("rounds retry countdown to nearest second", () => {
    const snapshot = makeSnapshot({
      retrying: [
        {
          issueNumber: 2,
          identifier: "MT-102",
          nextAttempt: 3,
          dueInMs: 12_567,
          lastError: "rate limited",
        },
      ],
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("13s");
  });

  it("renders retry entry with null error without crashing", () => {
    const snapshot = makeSnapshot({
      retrying: [
        {
          issueNumber: 2,
          identifier: "MT-102",
          nextAttempt: 1,
          dueInMs: 2_000,
          lastError: "",
        },
      ],
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("MT-102");
    expect(output).toContain("attempt=1");
  });

  it("renders polling as checking now", () => {
    const snapshot = makeSnapshot({
      polling: {
        checkingNow: true,
        nextPollAtMs: Date.now(),
        intervalMs: 30_000,
      },
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("checking now");
  });

  it("renders Next refresh countdown", () => {
    const snapshot = makeSnapshot({
      polling: {
        checkingNow: false,
        nextPollAtMs: Date.now() + 42_000,
        intervalMs: 30_000,
      },
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toMatch(/Next refresh:.*42s/);
  });

  it("renders fallback when snapshot is null", () => {
    const output = formatSnapshotContent(null, 0);
    expect(output).toContain("Orchestrator snapshot unavailable");
  });

  it("renders a realistic multi-agent frame with all TUI sections", () => {
    const nowMs = Date.now();
    const snapshot = makeSnapshot({
      running: [
        {
          issueNumber: 9,
          identifier: "#9",
          issueState: "running",
          startedAt: new Date(nowMs - 45_000), // 45s ago
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
          startedAt: new Date(nowMs - 30_000), // 30s ago
          retryAttempt: 1,
          sessionId: "smoke-sess-002",
          turnCount: 1,
          codexTokenState: "observed",
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
          runnerVisibility: null,
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
        inputTokens: 6400,
        outputTokens: 3200,
        totalTokens: 9600,
        pendingRunCount: 0,
        secondsRunning: 75,
      },
      maxConcurrentRuns: 3,
      projectUrl: "https://github.com/sociotechnica-org/symphony-ts-test",
    });

    const output = formatSnapshotContent(snapshot, 150.5, 120, "▁▂▃▄▅▆", nowMs);

    // Strip ANSI codes for easier inspection
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = plain.split("\n");

    // --- Header section ---
    expect(plain).toContain("SYMPHONY STATUS");
    expect(plain).toContain("Agents:");
    expect(plain).toMatch(/2.*\/.*3/); // 2 running / 3 max
    expect(plain).toContain("150 tps"); // formatTps floors the value
    expect(plain).toContain("▁▂▃▄▅▆"); // sparkline
    expect(plain).toContain("1m 15s"); // 75s runtime
    expect(plain).toContain("Tokens:");
    expect(plain).toContain("6,400"); // input tokens
    expect(plain).toContain("3,200"); // output tokens
    expect(plain).toContain("9,600"); // total tokens
    expect(plain).toContain("Project:");
    expect(plain).toContain("symphony-ts-test");
    expect(plain).toContain("Next refresh:");

    // --- Running table ---
    expect(plain).toContain("Running");
    // Table headers
    expect(plain).toContain("ID");
    expect(plain).toContain("STAGE");
    expect(plain).toContain("PID");
    expect(plain).toContain("AGE / TURN");
    expect(plain).toContain("TOKENS");
    expect(plain).toContain("SESSION");
    expect(plain).toContain("EVENT");

    // Agent #9 row
    expect(plain).toContain("#9");
    expect(plain).toContain("12345"); // PID
    expect(plain).toContain("6,000"); // tokens
    expect(plain).toContain("smok...ss-001"); // compacted session ID

    // Agent #11 row
    expect(plain).toContain("#11");
    expect(plain).toContain("12346");
    expect(plain).toContain("3,600");

    // --- Running rows show event column content ---
    // Find the line containing #9 - it should have reasoning update
    const agent9Line = lines.find(
      (l) => l.includes("#9") && l.includes("12345"),
    );
    expect(agent9Line).toBeDefined();
    expect(agent9Line).toContain("reasoning");

    // Find the line containing #11 - it should show the command
    const agent11Line = lines.find(
      (l) => l.includes("#11") && l.includes("12346"),
    );
    expect(agent11Line).toBeDefined();
    expect(agent11Line).toContain("git status");

    // --- Backoff queue ---
    expect(plain).toContain("Backoff queue");
    expect(plain).toContain("#7");
    expect(plain).toContain("attempt=2");
    expect(plain).toContain("8s");
    expect(plain).toContain("error=Runner exited with 1");

    // --- Structure ---
    expect(lines[0]).toContain("SYMPHONY STATUS");
    expect(lines[lines.length - 1]).toContain("╰─");
  });
});

// ─── humanizeEvent ────────────────────────────────────────────────────────────

describe("humanizeEvent", () => {
  it("returns no codex message yet when message is null", () => {
    expect(humanizeEvent(null, null)).toBe("no codex message yet");
  });

  it("humanizes task_started wrapper event", () => {
    expect(
      humanizeEvent(
        { event: "codex/event/task_started" },
        "codex/event/task_started",
      ),
    ).toBe("task started");
  });

  it("humanizes user_message wrapper event", () => {
    expect(humanizeEvent({}, "codex/event/user_message")).toBe(
      "user message received",
    );
  });

  it("humanizes mcp_startup_complete wrapper event", () => {
    expect(humanizeEvent({}, "codex/event/mcp_startup_complete")).toBe(
      "mcp startup complete",
    );
  });

  it("humanizes exec_command_output_delta wrapper event", () => {
    expect(humanizeEvent({}, "codex/event/exec_command_output_delta")).toBe(
      "command output streaming",
    );
  });

  it("humanizes exec_command_begin with command text", () => {
    const msg = { params: { msg: { command: "git status" } } };
    expect(humanizeEvent(msg, "codex/event/exec_command_begin")).toBe(
      "git status",
    );
  });

  it("humanizes exec_command_end with exit code", () => {
    const msg = { params: { msg: { exit_code: 0 } } };
    expect(humanizeEvent(msg, "codex/event/exec_command_end")).toBe(
      "command completed (exit 0)",
    );
  });

  it("humanizes token_count wrapper event with counts", () => {
    const msg = {
      params: {
        tokenUsage: {
          total: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
      },
    };
    expect(humanizeEvent(msg, "codex/event/token_count")).toContain(
      "token count update",
    );
  });

  it("humanizes thread/started method", () => {
    const msg = {
      method: "thread/started",
      params: { thread: { id: "thread-abc" } },
    };
    expect(humanizeEvent(msg, null)).toBe("thread started (thread-abc)");
  });

  it("humanizes turn/completed method with usage", () => {
    const msg = {
      method: "turn/completed",
      params: {
        turn: { status: "completed" },
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    };
    const result = humanizeEvent(msg, null);
    expect(result).toContain("turn completed");
    expect(result).toContain("in 100");
  });

  it("humanizes turn_completed method with usage", () => {
    const msg = {
      method: "turn_completed",
      params: {
        turn: { status: "completed" },
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    };
    const result = humanizeEvent(msg, null);
    expect(result).toContain("turn completed");
    expect(result).toContain("in 100");
  });

  it("humanizes turn/failed method with error message", () => {
    const msg = {
      method: "turn/failed",
      params: { error: { message: "context too long" } },
    };
    expect(humanizeEvent(msg, null)).toBe("turn failed: context too long");
  });

  it("humanizes turn/cancelled method", () => {
    const msg = { method: "turn/cancelled" };
    expect(humanizeEvent(msg, null)).toBe("turn cancelled");
  });

  it("humanizes item/commandExecution/requestApproval with command", () => {
    const msg = {
      method: "item/commandExecution/requestApproval",
      params: { parsedCmd: "rm -rf /" },
    };
    expect(humanizeEvent(msg, null)).toBe(
      "command approval requested (rm -rf /)",
    );
  });

  it("humanizes item/agentMessage/delta with preview", () => {
    const msg = {
      method: "item/agentMessage/delta",
      params: { delta: "Hello, I'm working on" },
    };
    const result = humanizeEvent(msg, null);
    expect(result).toContain("agent message streaming");
    expect(result).toContain("Hello");
  });

  it("humanizes session_started event", () => {
    expect(humanizeEvent({ session_id: "sess-1" }, "session/started")).toBe(
      "session started (sess-1)",
    );
  });

  it("humanizes codex/event/session.start wrapper event", () => {
    expect(humanizeEvent({}, "codex/event/session.start")).toBe(
      "session started",
    );
  });

  it("humanizes codex/event/session.end wrapper event", () => {
    expect(humanizeEvent({}, "codex/event/session.end")).toBe("session ended");
  });

  it("humanizes codex/event/reasoning wrapper event", () => {
    const msg = {
      params: { msg: { payload: { text: "Analyzing the code..." } } },
    };
    const result = humanizeEvent(msg, "codex/event/reasoning");
    expect(result).toContain("reasoning");
  });

  it("humanizes codex/event/exec_command_begin wrapper event", () => {
    const msg = { params: { msg: { command: "git diff" } } };
    expect(humanizeEvent(msg, "codex/event/exec_command_begin")).toBe(
      "git diff",
    );
  });

  it("humanizes codex/event/exec_command_end wrapper event", () => {
    const msg = { params: { msg: { exit_code: 0 } } };
    expect(humanizeEvent(msg, "codex/event/exec_command_end")).toBe(
      "command completed (exit 0)",
    );
  });

  it("truncates long events to 140 characters", () => {
    const longText = "x".repeat(200);
    const msg = {
      method: "turn/failed",
      params: { error: { message: longText } },
    };
    const result = humanizeEvent(msg, null);
    expect(result.length).toBeLessThanOrEqual(143); // 140 + "..."
  });

  it("renders no codex message yet for truly silent runs", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 138,
            identifier: "#138",
            issueState: "running",
            startedAt: new Date("2026-03-13T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: null,
          },
        ],
      }),
      0,
      140,
      "",
      new Date("2026-03-13T10:00:30.000Z").getTime(),
    );

    expect(output).toContain("no codex message yet");
  });

  it("prefers runner visibility stdout over the silent fallback", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 138,
            identifier: "#138",
            issueState: "running",
            startedAt: new Date("2026-03-13T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: makeRunnerVisibility({
              stdoutSummary: JSON.stringify({
                method: "thread/started",
                params: { thread: { id: "thread-live-123" } },
              }),
            }),
          },
        ],
      }),
      0,
      160,
      "",
      new Date("2026-03-13T10:00:30.000Z").getTime(),
    );

    expect(output).not.toContain("no codex message yet");
    expect(output).toContain("thread started (thread-live-123)");
    expect(output).toContain("thre...turn-1");
  });

  it("falls back to runner action text when visibility has no stdout preview", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 138,
            identifier: "#138",
            issueState: "running",
            startedAt: new Date("2026-03-13T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: makeRunnerVisibility({
              lastActionSummary: "Planning step 2",
            }),
          },
        ],
      }),
      0,
      160,
      "",
      new Date("2026-03-13T10:00:30.000Z").getTime(),
    );

    expect(output).toContain("Planning step 2");
    expect(output).not.toContain("no codex message yet");
  });

  it("omits runner label when the provider is blank", () => {
    const output = formatSnapshotContent(
      makeSnapshot({
        running: [
          {
            issueNumber: 138,
            identifier: "#138",
            issueState: "running",
            startedAt: new Date("2026-03-13T10:00:00.000Z"),
            retryAttempt: 1,
            sessionId: null,
            turnCount: 1,
            codexTokenState: "pending",
            codexTotalTokens: 0,
            codexInputTokens: 0,
            codexOutputTokens: 0,
            codexAppServerPid: 12345,
            lastCodexEvent: null,
            lastCodexMessage: null,
            lastCodexTimestamp: null,
            runnerVisibility: makeRunnerVisibility({
              session: {
                ...makeRunnerVisibility().session,
                provider: "  ",
                model: "sonnet",
              },
              lastActionSummary: "Planning step 2",
            }),
          },
        ],
      }),
      0,
      160,
      "",
      new Date("2026-03-13T10:00:30.000Z").getTime(),
    );

    expect(output).toContain("Planning step 2");
    expect(output).not.toContain("/sonnet");
  });
});

// ─── rollingTps ───────────────────────────────────────────────────────────────

describe("rollingTps", () => {
  it("returns 0 with empty samples", () => {
    expect(rollingTps([], 1000, 0)).toBe(0);
  });

  it("computes TPS with single prior sample within window", () => {
    // samples=[[500,100]], now=1000, current=200 → 100 tokens over 500ms = 200 TPS
    expect(rollingTps([[500, 100]], 1000, 200)).toBeCloseTo(200);
  });

  it("calculates TPS correctly over 1 second", () => {
    const now = 2000;
    const samples: [number, number][] = [[1000, 0]]; // 1s ago, 0 tokens
    const tps = rollingTps(samples, now, 1000); // 1000 tokens in 1 second
    expect(tps).toBeCloseTo(1000);
  });

  it("prunes samples older than 5 seconds", () => {
    const now = 10_000;
    // Old sample outside window
    const samples: [number, number][] = [[4000, 0]]; // 6s ago
    const tps = rollingTps(samples, now, 1000);
    // Only 1 sample left after pruning + current => 0
    expect(tps).toBe(0);
  });

  it("uses only samples within the 5-second window", () => {
    const now = 10_000;
    const samples: [number, number][] = [
      [5500, 100], // 4.5s ago - within window
      [4000, 0], // 6s ago - outside window
    ];
    const tps = rollingTps(samples, now, 1600);
    // Delta = 1600-100=1500 tokens over 4500ms = 333 tps
    expect(tps).toBeCloseTo(333, 0);
  });
});

// ─── tpsSparkline ─────────────────────────────────────────────────────────────

describe("tpsSparkline", () => {
  it("returns empty string with fewer than 2 samples", () => {
    expect(tpsSparkline([], 10_000)).toBe("");
    expect(tpsSparkline([[5_000, 100]], 10_000)).toBe("");
  });

  it("returns 24-character string with sufficient samples", () => {
    const now = 600_000;
    const samples: [number, number][] = [
      [0, 0],
      [300_000, 5000],
      [600_000, 10_000],
    ];
    const result = tpsSparkline(samples, now);
    expect(result).toHaveLength(24);
  });

  it("only uses block chars and spaces", () => {
    const now = 600_000;
    const samples: [number, number][] = [
      [0, 0],
      [300_000, 5000],
      [600_000, 10_000],
    ];
    const result = tpsSparkline(samples, now);
    expect([...result].every((c) => " ▁▂▃▄▅▆▇█".includes(c))).toBe(true);
  });

  it("renders inline on Throughput line when provided", () => {
    const snapshot = makeSnapshot();
    const output = formatSnapshotContent(snapshot, 100, undefined, "▁▂▃▄▅▆▇█");
    expect(output).toContain("100 tps");
    expect(output).toContain("▁▂▃▄▅▆▇█");
    // sparkline appears on the Throughput line (same line as tps)
    const throughputLine =
      output.split("\n").find((l) => l.includes("Throughput:")) ?? "";
    expect(throughputLine).toContain("▁▂▃▄▅▆▇█");
  });
});

// ─── throttledTps ─────────────────────────────────────────────────────────────

describe("throttledTps", () => {
  it("returns cached value within the same second", () => {
    const nowMs = 5500; // second = 5
    const result = throttledTps(5, 99.5, nowMs, [], 0);
    expect(result.tps).toBe(99.5);
    expect(result.second).toBe(5);
  });

  it("recalculates when second changes", () => {
    const nowMs = 6100; // second = 6
    const samples: [number, number][] = [[5100, 0]]; // 1s ago
    const result = throttledTps(5, 99.5, nowMs, samples, 1000);
    expect(result.second).toBe(6);
    expect(result.tps).toBeCloseTo(1000, 0);
  });

  it("recalculates when no cached value exists", () => {
    const nowMs = 3000;
    const samples: [number, number][] = [[2000, 0]];
    const result = throttledTps(null, 0, nowMs, samples, 500);
    expect(result.second).toBe(3);
    expect(result.tps).toBeCloseTo(500, 0);
  });
});

// ─── StatusDashboard ─────────────────────────────────────────────────────────

describe("StatusDashboard", () => {
  it("does not render when dashboardEnabled is false", () => {
    const rendered: string[] = [];
    const dashboard = new StatusDashboard(
      () => makeSnapshot(),
      () => makeConfig({ dashboardEnabled: false }),
      { renderFn: (c) => rendered.push(c), enabled: false },
    );
    dashboard.start();
    expect(rendered).toHaveLength(0);
    dashboard.stop();
  });

  it("captures rendered output via renderFn", async () => {
    const rendered: string[] = [];
    const snapshot = makeSnapshot();
    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (c) => rendered.push(c),
        enabled: true,
        refreshMs: 10,
        renderIntervalMs: 1,
      },
    );
    dashboard.start();
    await new Promise((r) => setTimeout(r, 30));
    dashboard.stop();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered[0]).toContain("SYMPHONY STATUS");
  });

  it("renders offline frame on stop", () => {
    let offlineOutput = "";
    const dashboard = new StatusDashboard(
      () => makeSnapshot(),
      () => makeConfig(),
      {
        renderFn: (c) => {
          offlineOutput = c;
        },
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 1,
      },
    );
    dashboard.stop();
    expect(offlineOutput).toContain("app_status=offline");
  });

  it("stop() is idempotent — calling twice does not render offline frame twice", () => {
    const renders: string[] = [];
    const dashboard = new StatusDashboard(
      () => makeSnapshot(),
      () => makeConfig(),
      {
        renderFn: (c) => renders.push(c),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 1,
      },
    );
    dashboard.stop();
    dashboard.stop();
    const offlineCount = renders.filter((r) =>
      r.includes("app_status=offline"),
    ).length;
    expect(offlineCount).toBe(1);
  });

  it("refresh() triggers immediate render", () => {
    const rendered: string[] = [];
    const dashboard = new StatusDashboard(
      () => makeSnapshot(),
      () => makeConfig(),
      {
        renderFn: (c) => rendered.push(c),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 1,
      },
    );
    dashboard.refresh();
    expect(rendered.length).toBeGreaterThan(0);
    dashboard.stop();
  });

  it("content deduplication skips re-render for identical snapshot", async () => {
    const rendered: string[] = [];
    const snapshot = makeSnapshot();
    const dashboard = new StatusDashboard(
      () => snapshot, // same object, same fingerprint
      () => makeConfig(),
      {
        renderFn: (c) => rendered.push(c),
        enabled: true,
        refreshMs: 5,
        renderIntervalMs: 1,
      },
    );
    dashboard.start();
    await new Promise((r) => setTimeout(r, 30));
    dashboard.stop();
    // Deduplicated: should be 1 render (initial) + possibly 1 periodic rerender per second
    expect(rendered.length).toBeLessThanOrEqual(3);
  });

  it("ignores runner visibility heartbeat-only timestamp churn in the fingerprint", () => {
    const rendered: string[] = [];
    let snapshot = makeSnapshot({
      running: [
        {
          issueNumber: 138,
          identifier: "#138",
          issueState: "running",
          startedAt: new Date("2026-03-13T10:00:00.000Z"),
          retryAttempt: 1,
          sessionId: null,
          turnCount: 1,
          codexTokenState: "pending",
          codexTotalTokens: 0,
          codexInputTokens: 0,
          codexOutputTokens: 0,
          codexAppServerPid: 12345,
          lastCodexEvent: null,
          lastCodexMessage: null,
          lastCodexTimestamp: null,
          runnerVisibility: makeRunnerVisibility({
            lastHeartbeatAt: "2026-03-13T10:00:05.000Z",
            lastActionAt: "2026-03-13T10:00:05.000Z",
            lastActionSummary: "Codex app-server stdout activity",
          }),
        },
      ],
    });

    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (content) => rendered.push(content),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 0,
      },
    );

    dashboard.refresh();
    snapshot = makeSnapshot({
      running: [
        {
          ...snapshot.running[0]!,
          runnerVisibility: makeRunnerVisibility({
            lastHeartbeatAt: "2026-03-13T10:00:06.000Z",
            lastActionAt: "2026-03-13T10:00:06.000Z",
            lastActionSummary: "Codex app-server stdout activity",
          }),
        },
      ],
    });
    dashboard.refresh();
    dashboard.stop();

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain("codex/gpt-5.4");
    expect(rendered[1]).toContain("app_status=offline");
  });

  it("re-renders immediately when last-action elapsed time resets", () => {
    const rendered: string[] = [];
    const firstAt = new Date(Date.now() - 20_000).toISOString();
    const secondAt = new Date(Date.now() - 10_000).toISOString();
    let snapshot = makeSnapshot({
      lastAction: {
        kind: "poll-started",
        issueNumber: null,
        summary: "Checking for ready work",
        at: firstAt,
      },
    });

    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (content) => rendered.push(content),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 0,
      },
    );

    dashboard.refresh();
    snapshot = makeSnapshot({
      lastAction: {
        ...snapshot.lastAction!,
        at: secondAt,
      },
    });
    dashboard.refresh();
    dashboard.stop();

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("Checking for ready work");
    expect(rendered[1]).toContain("Checking for ready work");
    expect(rendered[0]).not.toBe(rendered[1]);
    expect(rendered[2]).toContain("app_status=offline");
  });

  it("ignores runner visibility stderr-only churn in the fingerprint", () => {
    const rendered: string[] = [];
    let snapshot = makeSnapshot({
      running: [
        {
          issueNumber: 138,
          identifier: "#138",
          issueState: "running",
          startedAt: new Date("2026-03-13T10:00:00.000Z"),
          retryAttempt: 1,
          sessionId: null,
          turnCount: 1,
          codexTokenState: "pending",
          codexTotalTokens: 0,
          codexInputTokens: 0,
          codexOutputTokens: 0,
          codexAppServerPid: 12345,
          lastCodexEvent: null,
          lastCodexMessage: null,
          lastCodexTimestamp: null,
          runnerVisibility: makeRunnerVisibility({
            lastActionSummary: "Codex app-server stdout activity",
            stdoutSummary: JSON.stringify({
              method: "thread/started",
              params: { thread: { id: "thread-live-123" } },
            }),
            stderrSummary: "warning: first diagnostic",
          }),
        },
      ],
    });

    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (content) => rendered.push(content),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 1,
      },
    );

    dashboard.refresh();
    snapshot = makeSnapshot({
      running: [
        {
          ...snapshot.running[0]!,
          runnerVisibility: makeRunnerVisibility({
            lastActionSummary: "Codex app-server stdout activity",
            stdoutSummary: JSON.stringify({
              method: "thread/started",
              params: { thread: { id: "thread-live-123" } },
            }),
            stderrSummary: "warning: second diagnostic",
          }),
        },
      ],
    });
    dashboard.refresh();
    dashboard.stop();

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain("thread sta");
    expect(rendered[1]).toContain("app_status=offline");
  });

  it("ignores non-rendered runner visibility phase and session churn in the fingerprint", () => {
    const rendered: string[] = [];
    let snapshot = makeSnapshot({
      running: [
        {
          issueNumber: 138,
          identifier: "#138",
          issueState: "running",
          startedAt: new Date("2026-03-13T10:00:00.000Z"),
          retryAttempt: 1,
          sessionId: null,
          turnCount: 1,
          codexTokenState: "pending",
          codexTotalTokens: 0,
          codexInputTokens: 0,
          codexOutputTokens: 0,
          codexAppServerPid: 12345,
          lastCodexEvent: null,
          lastCodexMessage: null,
          lastCodexTimestamp: null,
          runnerVisibility: makeRunnerVisibility({
            phase: "turn-execution",
            session: {
              ...makeRunnerVisibility().session,
              model: "gpt-5.4",
              appServerPid: 12345,
              latestTurnNumber: 1,
            },
            stdoutSummary: JSON.stringify({
              method: "thread/started",
              params: { thread: { id: "thread-live-123" } },
            }),
          }),
        },
      ],
    });

    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (content) => rendered.push(content),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 1,
      },
    );

    dashboard.refresh();
    snapshot = makeSnapshot({
      running: [
        {
          ...snapshot.running[0]!,
          runnerVisibility: makeRunnerVisibility({
            phase: "awaiting-external",
            session: {
              ...makeRunnerVisibility().session,
              model: "gpt-5.4",
              appServerPid: 54321,
              latestTurnNumber: 1,
            },
            stdoutSummary: JSON.stringify({
              method: "thread/started",
              params: { thread: { id: "thread-live-123" } },
            }),
          }),
        },
      ],
    });
    dashboard.refresh();
    dashboard.stop();

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain("thread sta");
    expect(rendered[1]).toContain("app_status=offline");
  });

  it("re-renders when latestTurnNumber changes even before turnCount catches up", () => {
    const rendered: string[] = [];
    const startedAt = new Date(Date.now() - 1_000);
    let snapshot = makeSnapshot({
      maxTurns: 3,
      running: [
        {
          issueNumber: 138,
          identifier: "#138",
          issueState: "running",
          startedAt,
          retryAttempt: 1,
          sessionId: null,
          turnCount: 1,
          codexTokenState: "pending",
          codexTotalTokens: 0,
          codexInputTokens: 0,
          codexOutputTokens: 0,
          codexAppServerPid: 12345,
          lastCodexEvent: null,
          lastCodexMessage: null,
          lastCodexTimestamp: null,
          runnerVisibility: makeRunnerVisibility({
            session: {
              ...makeRunnerVisibility().session,
              latestTurnNumber: 1,
            },
          }),
        },
      ],
    });

    const dashboard = new StatusDashboard(
      () => snapshot,
      () => makeConfig(),
      {
        renderFn: (content) => rendered.push(content),
        enabled: true,
        refreshMs: 10_000,
        renderIntervalMs: 0,
      },
    );

    dashboard.refresh();
    snapshot = makeSnapshot({
      maxTurns: 3,
      running: [
        {
          ...snapshot.running[0]!,
          startedAt,
          turnCount: 1,
          runnerVisibility: makeRunnerVisibility({
            session: {
              ...makeRunnerVisibility().session,
              latestTurnNumber: 2,
            },
          }),
        },
      ],
    });
    dashboard.refresh();
    dashboard.stop();

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("turn 1/3");
    expect(rendered[1]).toContain("turn 2/3");
    expect(rendered[2]).toContain("app_status=offline");
  });
});
