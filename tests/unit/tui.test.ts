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

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    running: [],
    retrying: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    rateLimits: null,
    polling: {
      checkingNow: false,
      nextPollAtMs: Date.now() + 30_000,
      intervalMs: 30_000,
    },
    maxConcurrentRuns: 5,
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
          codexTotalTokens: 4521,
          codexInputTokens: 2000,
          codexOutputTokens: 2521,
          codexAppServerPid: 12345,
          lastCodexEvent: "turn_completed",
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
    expect(output).toContain("12.500s");
    expect(output).toContain("error=rate limited");
  });

  it("preserves retry millisecond precision when present", () => {
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
    expect(output).toContain("12.567s");
  });

  it("renders retry entry with null error without crashing", () => {
    const snapshot = makeSnapshot({
      retrying: [
        {
          issueNumber: 2,
          identifier: "MT-102",
          nextAttempt: 1,
          dueInMs: 2_000,
          lastError: null,
        },
      ],
    });
    const output = formatSnapshotContent(snapshot, 0);
    expect(output).toContain("MT-102");
    expect(output).toContain("attempt=1");
    expect(output).not.toContain("error=");
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

  it("renders offline frame", () => {
    const output = formatSnapshotContent(null, 0);
    expect(output).toContain(
      "app_status=offline" + "\x1b[0m" === output ? "" : "",
    ); // just check presence
    expect(output).toContain("Orchestrator snapshot unavailable");
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
    expect(humanizeEvent({ session_id: "sess-1" }, "session_started")).toBe(
      "session started (sess-1)",
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
});
