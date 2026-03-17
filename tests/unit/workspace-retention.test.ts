import { describe, expect, it } from "vitest";
import {
  classifyWorkspaceCleanupFailure,
  classifyWorkspaceCleanupSuccess,
  decideRetryWorkspaceRetention,
  decideTerminalWorkspaceRetention,
  finalizeRetainedWorkspace,
} from "../../src/orchestrator/workspace-retention.js";

describe("workspace retention policy", () => {
  it("defaults retries to bounded workspace retention", () => {
    expect(finalizeRetainedWorkspace(decideRetryWorkspaceRetention())).toEqual({
      reason: "retry",
      state: "retry-retained",
      action: "retain",
    });
  });

  it("retains failed workspaces by policy when configured", () => {
    const decision = decideTerminalWorkspaceRetention(
      {
        onSuccess: "delete",
        onFailure: "retain",
      },
      "failure",
    );

    expect(decision.action).toBe("retain");
    if (decision.action !== "retain") {
      throw new Error("expected retain decision");
    }

    expect(finalizeRetainedWorkspace(decision)).toEqual({
      reason: "failure",
      state: "terminal-retained",
      action: "retain",
    });
  });

  it("classifies successful cleanup including already-absent paths", () => {
    const decision = decideTerminalWorkspaceRetention(
      {
        onSuccess: "delete",
        onFailure: "retain",
      },
      "success",
    );

    expect(decision.action).toBe("cleanup");
    if (decision.action !== "cleanup") {
      throw new Error("expected cleanup decision");
    }

    expect(
      classifyWorkspaceCleanupSuccess(decision, {
        kind: "already-absent",
        workspacePath: "/tmp/workspaces/12",
      }),
    ).toEqual({
      reason: "success",
      state: "cleanup-succeeded",
      action: "cleanup",
      cleanupResult: {
        kind: "already-absent",
        workspacePath: "/tmp/workspaces/12",
      },
    });
  });

  it("classifies cleanup failures without changing the terminal decision", () => {
    const decision = decideTerminalWorkspaceRetention(
      {
        onSuccess: "delete",
        onFailure: "delete",
      },
      "failure",
    );

    expect(decision.action).toBe("cleanup");
    if (decision.action !== "cleanup") {
      throw new Error("expected cleanup decision");
    }

    expect(
      classifyWorkspaceCleanupFailure(decision, "rm failed"),
    ).toMatchObject({
      reason: "failure",
      state: "cleanup-failed",
      action: "cleanup",
      cleanupError: "rm failed",
    });
  });
});
