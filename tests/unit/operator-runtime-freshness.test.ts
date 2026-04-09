import { describe, expect, it } from "vitest";
import type { FactoryControlStatusSnapshot } from "../../src/cli/factory-control.js";
import { assessOperatorRuntimeFreshness } from "../../src/observability/operator-runtime-freshness.js";

function buildStatus(
  overrides: Partial<FactoryControlStatusSnapshot> = {},
): FactoryControlStatusSnapshot {
  return {
    controlState: "running",
    paths: {
      repoRoot: "/tmp/repo",
      runtimeRoot: "/tmp/repo/.tmp/factory-main",
      workflowPath: "/tmp/repo/WORKFLOW.md",
      statusFilePath: "/tmp/repo/.tmp/status.json",
      startupFilePath: "/tmp/repo/.tmp/startup.json",
    },
    sessionName: "test-session",
    factoryHalt: {
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    },
    sessions: [],
    workerAlive: true,
    startup: {
      state: "ready",
      provider: "github-bootstrap/local-mirror",
      summary: "ready",
      updatedAt: "2026-03-30T00:00:00Z",
      workerPid: 123,
      workerAlive: true,
      stale: false,
      runtimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      workflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    },
    snapshotFreshness: {
      freshness: "fresh",
      reason: "current-snapshot",
      summary: "fresh",
      workerAlive: true,
      publicationState: "current",
    },
    statusSnapshot: {
      version: 1,
      generatedAt: "2026-03-30T00:00:00Z",
      runtimeIdentity: null,
      publication: { state: "current", detail: null },
      factoryHalt: {
        state: "clear",
        reason: null,
        haltedAt: null,
        source: null,
        actor: null,
        detail: null,
      },
      dispatchPressure: null,
      hostDispatch: null,
      restartRecovery: {
        state: "idle",
        startedAt: null,
        completedAt: null,
        summary: null,
        issues: [],
      },
      recoveryPosture: {
        summary: { family: "healthy", summary: "healthy", issueCount: 0 },
        entries: [],
      },
      factoryState: "idle",
      worker: {
        instanceId: "instance",
        pid: 123,
        startedAt: "2026-03-30T00:00:00Z",
        pollIntervalMs: 30000,
        maxConcurrentRuns: 1,
      },
      counts: {
        ready: 0,
        running: 0,
        failed: 0,
        activeLocalRuns: 0,
        retries: 0,
      },
      lastAction: {
        kind: "poll-started",
        summary: "polling",
        at: "2026-03-30T00:00:00Z",
        issueNumber: null,
      },
      activeIssues: [],
      readyQueue: [],
      retries: [],
    },
    processIds: [],
    problems: [],
    ...overrides,
  };
}

describe("assessOperatorRuntimeFreshness", () => {
  it("reports fresh when runtime and engine heads match", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("fresh");
    expect(result.shouldRestart).toBe(false);
    expect(result.engineHeadSha).toBe("runtime-sha");
  });

  it("requests restart when runtime is stale and idle", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "current-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-runtime-idle");
    expect(result.shouldRestart).toBe(true);
    expect(result.runtimeChanged).toBe(true);
    expect(result.workflowChanged).toBe(false);
  });

  it("defers restart when runtime is stale and busy", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        statusSnapshot: {
          ...buildStatus().statusSnapshot!,
          factoryState: "running",
          activeIssues: [
            {
              issueNumber: 1,
              issueIdentifier: "repo#1",
              title: "active",
              source: "running",
              runSequence: 1,
              status: "running",
              summary: "running",
              workspacePath: null,
              branchName: "branch",
              runSessionId: null,
              executionOwner: null,
              ownerPid: 123,
              runnerPid: null,
              startedAt: null,
              updatedAt: "2026-03-30T00:00:00Z",
              pullRequest: null,
              checks: { pendingNames: [], failingNames: [] },
              review: { actionableCount: 0, unresolvedThreadCount: 0 },
              blockedReason: null,
              runnerVisibility: null,
            },
          ],
        },
      }),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "current-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-runtime-busy");
    expect(result.shouldRestart).toBe(false);
    expect(result.activeIssueCount).toBe(1);
  });

  it("requests restart when only the workflow contract changed and the instance is idle", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "0e14f3b03df8b0a6b946fdd8f0aac546f85d6d58b7615476a8ad5f5d6d6292af",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-workflow-idle");
    expect(result.shouldRestart).toBe(true);
    expect(result.runtimeChanged).toBe(false);
    expect(result.workflowChanged).toBe(true);
  });

  it("defers restart when both runtime and workflow are stale but the instance is busy", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        statusSnapshot: {
          ...buildStatus().statusSnapshot!,
          factoryState: "running",
          activeIssues: [
            {
              issueNumber: 1,
              issueIdentifier: "repo#1",
              title: "active",
              source: "running",
              runSequence: 1,
              status: "running",
              summary: "running",
              workspacePath: null,
              branchName: "branch",
              runSessionId: null,
              executionOwner: null,
              ownerPid: 123,
              runnerPid: null,
              startedAt: null,
              updatedAt: "2026-03-30T00:00:00Z",
              pullRequest: null,
              checks: { pendingNames: [], failingNames: [] },
              review: { actionableCount: 0, unresolvedThreadCount: 0 },
              blockedReason: null,
              runnerVisibility: null,
            },
          ],
        },
      }),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "current-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "0e14f3b03df8b0a6b946fdd8f0aac546f85d6d58b7615476a8ad5f5d6d6292af",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-runtime-and-workflow-busy");
    expect(result.shouldRestart).toBe(false);
  });

  it("reports stopped when factory control is not running", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        controlState: "stopped",
      }),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "current-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("stopped");
    expect(result.shouldRestart).toBe(false);
  });

  it("reports unavailable when the operator checkout head is unavailable", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: null,
        committedAt: null,
        isDirty: null,
        source: "git-error",
        detail: "git unavailable",
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("unavailable");
    expect(result.shouldRestart).toBe(false);
    expect(result.unavailableReasons).toContain(
      "current runtime checkout head is unavailable; inspect the selected instance runtime checkout",
    );
  });

  it("reports unavailable when the running factory head is unavailable", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        startup: {
          ...buildStatus().startup!,
          runtimeIdentity: {
            checkoutPath: "/tmp/repo/.tmp/factory-main",
            headSha: null,
            committedAt: null,
            isDirty: null,
            source: "git-error",
            detail: "runtime git unavailable",
          },
        },
      }),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "current-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash:
          "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
        source: "file",
        detail: null,
      },
    });

    expect(result.kind).toBe("unavailable");
    expect(result.shouldRestart).toBe(false);
    expect(result.unavailableReasons).toContain(
      "running factory runtime head is unavailable; inspect the startup snapshot",
    );
  });

  it("reports unavailable instead of guessing when the current workflow cannot be read", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      currentRuntimeIdentity: {
        checkoutPath: "/tmp/repo/.tmp/factory-main",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
      currentWorkflowIdentity: {
        workflowPath: "/tmp/repo/WORKFLOW.md",
        contentHash: null,
        source: "missing",
        detail: "workflow file does not exist",
      },
    });

    expect(result.kind).toBe("unavailable");
    expect(result.shouldRestart).toBe(false);
    expect(result.unavailableReasons).toContain(
      "current workflow identity is unavailable for /tmp/repo/WORKFLOW.md (missing: workflow file does not exist)",
    );
  });
});
