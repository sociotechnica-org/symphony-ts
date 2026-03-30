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
        checkoutPath: "/tmp/repo",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
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
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: "runtime-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
    });

    expect(result.kind).toBe("fresh");
    expect(result.shouldRestart).toBe(false);
  });

  it("requests restart when runtime is stale and idle", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: "engine-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-idle");
    expect(result.shouldRestart).toBe(true);
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
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: "engine-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
    });

    expect(result.kind).toBe("stale-busy");
    expect(result.shouldRestart).toBe(false);
    expect(result.activeIssueCount).toBe(1);
  });

  it("reports stopped when factory control is not running", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        controlState: "stopped",
      }),
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: "engine-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
    });

    expect(result.kind).toBe("stopped");
    expect(result.shouldRestart).toBe(false);
  });

  it("reports engine-head-unavailable when the operator checkout head is unavailable", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus(),
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: null,
        committedAt: null,
        isDirty: null,
        source: "git-error",
        detail: "git unavailable",
      },
    });

    expect(result.kind).toBe("engine-head-unavailable");
    expect(result.shouldRestart).toBe(false);
  });

  it("reports runtime-head-unavailable when the running factory head is unavailable", () => {
    const result = assessOperatorRuntimeFreshness({
      status: buildStatus({
        startup: {
          ...buildStatus().startup!,
          runtimeIdentity: {
            checkoutPath: "/tmp/repo",
            headSha: null,
            committedAt: null,
            isDirty: null,
            source: "git-error",
            detail: "runtime git unavailable",
          },
        },
      }),
      engineRuntimeIdentity: {
        checkoutPath: "/tmp/repo",
        headSha: "engine-sha",
        committedAt: "2026-03-30T00:00:00Z",
        isDirty: false,
        source: "git",
        detail: null,
      },
    });

    expect(result.kind).toBe("runtime-head-unavailable");
    expect(result.shouldRestart).toBe(false);
  });
});
