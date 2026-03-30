import { describe, expect, it } from "vitest";
import {
  type LivenessSnapshot,
  checkStall,
  classifyStallReason,
  canRecover,
  createWatchdogEntry,
  DEFAULT_WATCHDOG_CONFIG,
} from "../../src/orchestrator/stall-detector.js";
import type { WatchdogConfig } from "../../src/domain/workflow.js";

const config: WatchdogConfig = {
  enabled: true,
  checkIntervalMs: 1_000,
  stallThresholdMs: 5_000,
  maxRecoveryAttempts: 2,
};

const HEARTBEAT_AT = "2026-03-13T08:46:00.000Z";
const HEARTBEAT_ADVANCED_AT = "2026-03-13T08:46:03.000Z";
const ACTION_AT = "2026-03-13T08:46:01.000Z";
const ACTION_ADVANCED_AT = "2026-03-13T08:46:04.000Z";
const CAPTURED_AT = "2026-03-13T08:46:07.000Z";

function snapshot(overrides: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    logSizeBytes: null,
    workspaceDiffHash: null,
    prHeadSha: null,
    runStartedAt: null,
    runnerPhase: null,
    runnerHeartbeatAt: null,
    runnerActionAt: null,
    hasActionableFeedback: false,
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe("createWatchdogEntry", () => {
  it("creates an entry with zero recovery count", () => {
    const snap = snapshot({ capturedAt: 1000 });
    const entry = createWatchdogEntry(42, snap);
    expect(entry.issueNumber).toBe(42);
    expect(entry.lastObservableActivityAt).toBe(1000);
    expect(entry.lastObservableActivitySource).toBeNull();
    expect(entry.recoveryCount).toBe(0);
  });

  it("uses run start as the initial observable activity baseline", () => {
    const capturedAt = Date.parse(CAPTURED_AT);
    const entry = createWatchdogEntry(
      42,
      snapshot({
        capturedAt,
        runStartedAt: HEARTBEAT_AT,
      }),
    );
    expect(entry.lastObservableActivityAt).toBe(Date.parse(HEARTBEAT_AT));
    expect(entry.lastObservableActivitySource).toBe("run-start");
  });

  it("clamps future-dated run start activity to capturedAt", () => {
    const capturedAt = Date.parse(CAPTURED_AT);
    const entry = createWatchdogEntry(
      42,
      snapshot({
        capturedAt,
        runStartedAt: "2026-03-13T08:46:30.000Z",
      }),
    );
    expect(entry.lastObservableActivityAt).toBe(capturedAt);
    expect(entry.lastObservableActivitySource).toBe("run-start");

    const result = checkStall(
      entry,
      snapshot({
        capturedAt: capturedAt + config.stallThresholdMs + 1,
        runStartedAt: "2026-03-13T08:46:30.000Z",
      }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("log-stall");
  });

  it("clamps future-dated initial runner heartbeat activity to capturedAt", () => {
    const capturedAt = Date.parse(CAPTURED_AT);
    const entry = createWatchdogEntry(
      42,
      snapshot({
        capturedAt,
        runnerHeartbeatAt: "2026-03-13T08:46:30.000Z",
      }),
    );
    expect(entry.lastObservableActivityAt).toBe(capturedAt);
    expect(entry.lastObservableActivitySource).toBe("runner-heartbeat");

    const result = checkStall(
      entry,
      snapshot({
        capturedAt: capturedAt + config.stallThresholdMs + 1,
        runnerHeartbeatAt: "2026-03-13T08:46:30.000Z",
      }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("log-stall");
  });
});

describe("checkStall", () => {
  it("reports not stalled when log size changes", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ logSizeBytes: 200, capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("keeps a workspace-written run alive while the watchdog log keeps growing", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({
        logSizeBytes: 10,
        workspaceDiffHash: "diff-1",
        capturedAt: 1000,
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        logSizeBytes: 11,
        workspaceDiffHash: "diff-1",
        capturedAt: 7000,
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.lastObservableActivitySource).toBe("watchdog-log");
  });

  it("reports not stalled when workspace diff changes", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ workspaceDiffHash: "aaa", capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ workspaceDiffHash: "bbb", capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(false);
  });

  it("reports not stalled when PR head changes", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ prHeadSha: "sha1", capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ prHeadSha: "sha2", capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(false);
  });

  it("treats the first runner heartbeat signal as progress", () => {
    const entry = createWatchdogEntry(1, snapshot({ capturedAt: 1000 }));
    const result = checkStall(
      entry,
      snapshot({
        runnerHeartbeatAt: HEARTBEAT_AT,
        capturedAt: Date.parse(CAPTURED_AT),
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.stalledForMs).toBe(
      Date.parse(CAPTURED_AT) - Date.parse(HEARTBEAT_AT),
    );
    expect(entry.lastObservableActivityAt).toBe(Date.parse(HEARTBEAT_AT));
    expect(entry.lastObservableActivitySource).toBe("runner-heartbeat");
  });

  it("resets idle time when runner progress timestamps advance", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({
        runnerHeartbeatAt: HEARTBEAT_AT,
        runnerActionAt: HEARTBEAT_AT,
        capturedAt: 1000,
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        runnerHeartbeatAt: HEARTBEAT_ADVANCED_AT,
        runnerActionAt: ACTION_ADVANCED_AT,
        capturedAt: Date.parse(CAPTURED_AT),
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.reason).toBeNull();
    expect(entry.lastObservableActivityAt).toBe(Date.parse(ACTION_ADVANCED_AT));
    expect(entry.lastObservableActivitySource).toBe("runner-action");
  });

  it("clamps future-dated runner activity to the probe wall clock", () => {
    const entry = createWatchdogEntry(1, snapshot({ capturedAt: 1000 }));
    const result = checkStall(
      entry,
      snapshot({
        runnerHeartbeatAt: "2026-03-13T08:46:30.000Z",
        capturedAt: Date.parse(CAPTURED_AT),
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.stalledForMs).toBe(0);
    expect(result.lastObservableActivityAt).toBe(Date.parse(CAPTURED_AT));
    expect(entry.lastObservableActivityAt).toBe(Date.parse(CAPTURED_AT));
    expect(entry.lastObservableActivitySource).toBe("runner-heartbeat");
  });

  it("reports not stalled within threshold window", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ logSizeBytes: 100, capturedAt: 4000 }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.stalledForMs).toBe(3000);
  });

  it("uses run start as the stall baseline before later activity appears", () => {
    const runStartedAt = Date.parse(HEARTBEAT_AT);
    const entry = createWatchdogEntry(
      1,
      snapshot({
        capturedAt: runStartedAt,
        runStartedAt: HEARTBEAT_AT,
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        capturedAt: Date.parse("2026-03-13T08:46:06.000Z"),
        runStartedAt: HEARTBEAT_AT,
      }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("log-stall");
    expect(result.stalledForMs).toBe(6000);
    expect(result.lastObservableActivitySource).toBe("run-start");
  });

  it("treats the first observable signal as progress", () => {
    const entry = createWatchdogEntry(1, snapshot({ capturedAt: 1000 }));
    const result = checkStall(
      entry,
      snapshot({ logSizeBytes: 100, capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.reason).toBeNull();
    expect(entry.lastObservableActivityAt).toBe(7000);
    expect(entry.lastObservableActivitySource).toBe("watchdog-log");
  });

  it("classifies startup-phase action timestamps as runner-startup activity", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({
        capturedAt: 1000,
        runStartedAt: HEARTBEAT_AT,
        runnerPhase: "boot",
        runnerActionAt: HEARTBEAT_AT,
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        capturedAt: Date.parse(CAPTURED_AT),
        runStartedAt: HEARTBEAT_AT,
        runnerPhase: "session-start",
        runnerActionAt: HEARTBEAT_ADVANCED_AT,
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.lastObservableActivitySource).toBe("runner-startup");
    expect(result.lastObservableActivityAt).toBe(
      Date.parse(HEARTBEAT_ADVANCED_AT),
    );
  });

  it("preserves the first activity source when timestamps tie", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({
        logSizeBytes: 200,
        runnerActionAt: "2026-03-13T08:46:07.000Z",
        capturedAt: Date.parse("2026-03-13T08:46:07.000Z"),
      }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.lastObservableActivitySource).toBe("watchdog-log");
  });

  it("reports stalled after threshold with no changes", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ logSizeBytes: 100, capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("log-stall");
    expect(result.stalledForMs).toBe(6000);
  });

  it("stalls runner-progress-only runs after timestamps stop changing", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({
        runnerHeartbeatAt: HEARTBEAT_AT,
        runnerActionAt: ACTION_AT,
        capturedAt: Date.parse(ACTION_AT),
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        runnerHeartbeatAt: HEARTBEAT_AT,
        runnerActionAt: ACTION_AT,
        capturedAt: Date.parse(CAPTURED_AT),
      }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("log-stall");
    expect(result.stalledForMs).toBe(6000);
  });

  it("classifies PR stall when actionable feedback present", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({
        prHeadSha: "sha1",
        hasActionableFeedback: true,
        capturedAt: 1000,
      }),
    );
    const result = checkStall(
      entry,
      snapshot({
        prHeadSha: "sha1",
        hasActionableFeedback: true,
        capturedAt: 7000,
      }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("pr-stall");
  });

  it("classifies workspace stall when diff hash present but unchanged", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ workspaceDiffHash: "aaa", capturedAt: 1000 }),
    );
    const result = checkStall(
      entry,
      snapshot({ workspaceDiffHash: "aaa", capturedAt: 7000 }),
      config,
    );
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("workspace-stall");
  });

  it("resets the authoritative last observable activity when change detected", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    checkStall(
      entry,
      snapshot({ logSizeBytes: 200, capturedAt: 5000 }),
      config,
    );
    expect(entry.lastObservableActivityAt).toBe(5000);
    expect(entry.lastObservableActivitySource).toBe("watchdog-log");

    // Now no change for another period but within threshold
    const result = checkStall(
      entry,
      snapshot({ logSizeBytes: 200, capturedAt: 9000 }),
      config,
    );
    expect(result.stalled).toBe(false);
    expect(result.stalledForMs).toBe(4000);
  });
});

describe("classifyStallReason", () => {
  it("returns pr-stall for actionable feedback with PR head", () => {
    expect(
      classifyStallReason(
        snapshot({ hasActionableFeedback: true, prHeadSha: "sha1" }),
      ),
    ).toBe("pr-stall");
  });

  it("returns workspace-stall when diff hash present", () => {
    expect(classifyStallReason(snapshot({ workspaceDiffHash: "abc" }))).toBe(
      "workspace-stall",
    );
  });

  it("returns log-stall as default", () => {
    expect(classifyStallReason(snapshot())).toBe("log-stall");
  });
});

describe("canRecover", () => {
  it("allows recovery when under limit", () => {
    const entry = createWatchdogEntry(1, snapshot());
    expect(canRecover(entry, config)).toBe(true);
  });

  it("denies recovery when at limit", () => {
    const entry = createWatchdogEntry(1, snapshot());
    entry.recoveryCount = 2;
    expect(canRecover(entry, config)).toBe(false);
  });
});

describe("DEFAULT_WATCHDOG_CONFIG", () => {
  it("has watchdog disabled by default", () => {
    expect(DEFAULT_WATCHDOG_CONFIG.enabled).toBe(false);
  });

  it("has sensible defaults", () => {
    expect(DEFAULT_WATCHDOG_CONFIG.stallThresholdMs).toBe(300_000);
    expect(DEFAULT_WATCHDOG_CONFIG.maxRecoveryAttempts).toBe(2);
  });
});
