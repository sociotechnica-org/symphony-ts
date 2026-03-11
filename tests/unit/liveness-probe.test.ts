import { describe, expect, it } from "vitest";
import { NullLivenessProbe } from "../../src/orchestrator/liveness-probe.js";

describe("NullLivenessProbe", () => {
  it("returns null log and diff with passthrough fields", async () => {
    const probe = new NullLivenessProbe();
    const result = await probe.capture({
      issueNumber: 42,
      workspacePath: "/tmp/workspaces/42",
      runSessionId: "session-42",
      prHeadSha: "abc123",
      hasActionableFeedback: true,
    });
    expect(result.logSizeBytes).toBeNull();
    expect(result.workspaceDiffHash).toBeNull();
    expect(result.prHeadSha).toBe("abc123");
    expect(result.hasActionableFeedback).toBe(true);
    expect(result.capturedAt).toBeGreaterThan(0);
  });
});
