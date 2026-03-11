import { describe, expect, it } from "vitest";
import {
  type LivenessSnapshot,
  checkStall,
  classifyStallReason,
  canRecover,
  recordRecovery,
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

function snapshot(overrides: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    logSizeBytes: null,
    workspaceDiffHash: null,
    prHeadSha: null,
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
    expect(entry.lastChangeAt).toBe(1000);
    expect(entry.recoveryCount).toBe(0);
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

  it("resets lastChangeAt when change detected", () => {
    const entry = createWatchdogEntry(
      1,
      snapshot({ logSizeBytes: 100, capturedAt: 1000 }),
    );
    checkStall(
      entry,
      snapshot({ logSizeBytes: 200, capturedAt: 5000 }),
      config,
    );
    expect(entry.lastChangeAt).toBe(5000);

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

describe("recordRecovery", () => {
  it("increments recovery count", () => {
    const entry = createWatchdogEntry(1, snapshot());
    recordRecovery(entry);
    expect(entry.recoveryCount).toBe(1);
    recordRecovery(entry);
    expect(entry.recoveryCount).toBe(2);
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
