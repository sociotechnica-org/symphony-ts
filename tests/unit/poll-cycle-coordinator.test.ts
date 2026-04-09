import { describe, expect, it, vi } from "vitest";
import type { DispatchPressureStateSnapshot } from "../../src/domain/transient-failure.js";
import { runPollCycle } from "../../src/orchestrator/poll-cycle-coordinator.js";
import { scheduleRetry } from "../../src/orchestrator/retry-state.js";
import { createIssue } from "../support/pull-request.js";
import {
  createTestConfig,
  createTestState,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

function createTracker(
  readyIssues: ReturnType<typeof createIssue>[],
  runningIssues: ReturnType<typeof createIssue>[],
) {
  return {
    ensureLabels: vi.fn(async () => {}),
    fetchReadyIssues: vi.fn(async () => readyIssues),
    fetchRunningIssues: vi.fn(async () => runningIssues),
  };
}

function createDispatchPressure(): DispatchPressureStateSnapshot {
  return {
    retryClass: "provider-rate-limit",
    reason: "provider paused",
    observedAt: "2026-04-09T00:00:00.000Z",
    resumeAt: "2026-04-09T00:05:00.000Z",
  };
}

describe("poll cycle coordinator", () => {
  it("keeps due retries queued while dispatch pressure blocks new ready work", async () => {
    const config = createTestConfig("/tmp/poll-cycle-pressure");
    const state = createTestState(config);
    const readyIssue = createIssue(11);
    const runningIssue = createIssue(12, "symphony:running");
    scheduleRetry(state.retries, {
      issue: runningIssue,
      runSequence: 1,
      retryClass: "run-failure",
      backoffMs: 0,
      message: "retry later",
      now: 0,
    });
    const tracker = createTracker([readyIssue], [runningIssue]);
    const started: number[] = [];

    await Promise.all(
      await runPollCycle({
        config,
        logger: new NullLogger(),
        tracker: tracker as never,
        state,
        recoveredRunningLifecycles: new Map(),
        notifyDashboard: () => {},
        persistStatusSnapshot: async () => {},
        fetchFailedCandidatesForStatus: async () => [],
        pruneStaleActiveIssues: () => {},
        reconcileRunningIssueOwnership: async (issues) => issues,
        releaseExpiredDispatchPressure: () => createDispatchPressure(),
        resolveAttemptNumber: (issueNumber, retryAttempts) =>
          retryAttempts.get(issueNumber) ?? 1,
        startDispatchTask: (entry) => {
          started.push(entry.issue.number);
          return Promise.resolve();
        },
        reconcileTerminalIssueReporting: async () => {},
      }),
    );

    expect(started).toEqual([12]);
    expect(state.retries.queueByIssueNumber.has(runningIssue.number)).toBe(
      true,
    );
    expect(tracker.fetchReadyIssues).toHaveBeenCalledOnce();
  });

  it("consumes due retries and dispatches running work ahead of ready work", async () => {
    const config = createTestConfig("/tmp/poll-cycle-clear");
    const state = createTestState(config);
    const readyIssue = createIssue(21);
    const runningIssue = createIssue(22, "symphony:running");
    scheduleRetry(state.retries, {
      issue: runningIssue,
      runSequence: 1,
      retryClass: "run-failure",
      backoffMs: 0,
      message: "retry now",
      now: 0,
    });
    const started: Array<{ issueNumber: number; attempt: number }> = [];

    await Promise.all(
      await runPollCycle({
        config,
        logger: new NullLogger(),
        tracker: createTracker([readyIssue], [runningIssue]) as never,
        state,
        recoveredRunningLifecycles: new Map(),
        notifyDashboard: () => {},
        persistStatusSnapshot: async () => {},
        fetchFailedCandidatesForStatus: async () => [],
        pruneStaleActiveIssues: () => {},
        reconcileRunningIssueOwnership: async (issues) => issues,
        releaseExpiredDispatchPressure: () => null,
        resolveAttemptNumber: (issueNumber, retryAttempts) =>
          retryAttempts.get(issueNumber) ?? 1,
        startDispatchTask: (entry) => {
          started.push({
            issueNumber: entry.issue.number,
            attempt: entry.attempt,
          });
          return Promise.resolve();
        },
        reconcileTerminalIssueReporting: async () => {},
      }),
    );

    expect(started).toEqual([
      { issueNumber: 22, attempt: 2 },
      { issueNumber: 21, attempt: 1 },
    ]);
    expect(state.retries.queueByIssueNumber.has(runningIssue.number)).toBe(
      false,
    );
  });
});
