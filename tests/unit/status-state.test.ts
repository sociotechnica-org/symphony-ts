import { describe, expect, it } from "vitest";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import {
  adjustTrackerIssueCounts,
  createRuntimeStatusState,
  setTrackerIssueCounts,
  upsertActiveIssue,
} from "../../src/orchestrator/status-state.js";

const issue: RuntimeIssue = {
  id: "issue-12",
  identifier: "sociotechnica-org/symphony-ts#12",
  number: 12,
  title: "Expose factory status",
  description: "desc",
  labels: ["symphony:running"],
  state: "open",
  url: "https://example.test/issues/12",
  createdAt: "2026-03-06T11:00:00.000Z",
  updatedAt: "2026-03-06T11:00:00.000Z",
};

describe("upsertActiveIssue", () => {
  it("reassigns tracker counts through the helper functions", () => {
    const state = createRuntimeStatusState();
    const firstCounts = state.trackerCounts;

    setTrackerIssueCounts(state, {
      ready: 3,
      running: 2,
      failed: 1,
    });
    const secondCounts = state.trackerCounts;
    adjustTrackerIssueCounts(state, {
      ready: -1,
      running: 1,
    });

    expect(firstCounts).not.toBe(secondCounts);
    expect(secondCounts).not.toBe(state.trackerCounts);
    expect(state.trackerCounts).toEqual({
      ready: 2,
      running: 3,
      failed: 1,
    });
  });

  it("resets nullable fields when an explicit null update is provided", () => {
    const state = createRuntimeStatusState();

    upsertActiveIssue(state, issue, {
      source: "running",
      runSequence: 1,
      branchName: "symphony/12",
      status: "running",
      summary: "Running issue",
      workspacePath: "/tmp/workspaces/12",
      runSessionId: "session-1",
      ownerPid: 111,
      runnerPid: 222,
      startedAt: "2026-03-06T11:01:00.000Z",
      pullRequest: {
        number: 12,
        url: "https://example.test/pulls/12",
        headSha: "head-sha-12",
        latestCommitAt: "2026-03-06T11:02:00.000Z",
      },
      blockedReason: "Waiting on review",
      runnerVisibility: {
        state: "waiting",
        phase: "awaiting-external",
        session: {
          provider: "codex",
          model: "gpt-5.4",
          transport: createRunnerTransportMetadata("local-stdio-session", {
            canTerminateLocalProcess: true,
          }),
          backendSessionId: null,
          backendThreadId: null,
          latestTurnId: null,
          latestTurnNumber: 1,
          logPointers: [],
        },
        lastHeartbeatAt: "2026-03-06T11:03:00.000Z",
        lastActionAt: "2026-03-06T11:03:00.000Z",
        lastActionSummary: "Waiting on review",
        waitingReason: "Waiting on review",
        stdoutSummary: null,
        stderrSummary: null,
        errorSummary: null,
        cancelledAt: null,
        timedOutAt: null,
      },
    });

    upsertActiveIssue(state, issue, {
      source: "running",
      runSequence: 2,
      branchName: "symphony/12",
      status: "preparing",
      summary: "Preparing rerun",
      workspacePath: null,
      runSessionId: null,
      ownerPid: null,
      runnerPid: null,
      startedAt: null,
      pullRequest: null,
      blockedReason: null,
      runnerVisibility: null,
    });

    expect(state.activeIssues.get(issue.number)).toMatchObject({
      workspacePath: null,
      runSessionId: null,
      ownerPid: null,
      runnerPid: null,
      startedAt: null,
      pullRequest: null,
      blockedReason: null,
      runnerVisibility: null,
    });
  });
});
