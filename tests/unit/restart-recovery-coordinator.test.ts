import { describe, expect, it, vi } from "vitest";
import { reconcileRunningIssueOwnership } from "../../src/orchestrator/restart-recovery-coordinator.js";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  createTestConfig,
  createTestState,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

describe("restart recovery coordinator", () => {
  it("requeues stale inherited ownership and preserves the refreshed lifecycle", async () => {
    const config = createTestConfig("/tmp/restart-recovery");
    const state = createTestState(config);
    const issue = createIssue(51, "symphony:running");
    const lifecycle = createLifecycle("missing-target", "symphony/51");
    const inspect = vi.fn(async () => ({
      kind: "stale-owner" as const,
      issueNumber: issue.number,
      lockDir: "/tmp/lease-51",
      executionOwner: null,
      ownerPid: 1001,
      ownerAlive: false,
      runnerPid: null,
      runnerAlive: null,
      record: {
        issueNumber: issue.number,
        issueIdentifier: issue.identifier,
        branchName: "symphony/51",
        runSessionId: "session-51",
        attempt: 1,
        executionOwner: null,
        ownerPid: 1001,
        runnerPid: null,
        runRecordedAt: "2026-04-09T00:00:00.000Z",
        runnerStartedAt: null,
        shutdown: null,
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
    }));
    const reconcile = vi.fn(async () => {});
    let startupRecoveryCompleted = false;
    const recoveredRunningLifecycles = new Map<number, typeof lifecycle>();

    const runnable = await reconcileRunningIssueOwnership(
      {
        logger: new NullLogger(),
        state,
        leaseManager: {
          inspect,
          reconcile,
        } as never,
        startupRecoveryCompleted: () => startupRecoveryCompleted,
        markStartupRecoveryCompleted: () => {
          startupRecoveryCompleted = true;
        },
        recoveredRunningLifecycles,
        persistStatusSnapshot: async () => {},
        refreshLifecycle: async () => lifecycle,
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        asRecoveredShutdownLease: () => null,
        consumeRecoveredShutdownLease: async () => {},
      },
      [issue],
    );

    expect(runnable).toEqual([issue]);
    expect(reconcile).toHaveBeenCalledWith(issue.number, {
      preserveShutdown: false,
    });
    expect(recoveredRunningLifecycles.get(issue.number)).toEqual(lifecycle);
    expect(state.status.restartRecovery.state).toBe("ready");
  });
});
