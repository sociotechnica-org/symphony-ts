import { describe, expect, it, vi } from "vitest";
import { processClaimedIssue } from "../../src/orchestrator/claimed-issue-coordinator.js";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  createTestConfig,
  createTestState,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

function createContext() {
  const config = createTestConfig("/tmp/claimed-issue");
  const state = createTestState(config);
  return {
    state,
    persistStatusSnapshot: vi.fn(async () => {}),
    completeIssue: vi.fn(async () => {}),
    recordLifecycleObservation: vi.fn(async () => {}),
    handleLandingLifecycle: vi.fn(async () => {}),
    runIssue: vi.fn(async () => false),
  };
}

describe("claimed issue coordinator", () => {
  it("completes the issue immediately when lifecycle is handoff-ready", async () => {
    const issue = createIssue(31, "symphony:running");
    const {
      state,
      persistStatusSnapshot,
      completeIssue,
      recordLifecycleObservation,
      handleLandingLifecycle,
      runIssue,
    } = createContext();

    await processClaimedIssue(
      {
        logger: new NullLogger(),
        tracker: {} as never,
        leaseManager: {} as never,
        state,
        recoveredRunningLifecycles: new Map(),
        persistStatusSnapshot,
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        missingLifecycle: (issueNumber) =>
          createLifecycle(
            "missing-target",
            `symphony/${issueNumber.toString()}`,
          ),
        handleUnexpectedFailure: async () => {},
        recordClaimedArtifact: async () => {},
        recordRunningInspectionArtifact: async () => {},
        recordLifecycleObservation,
        completeIssue,
        handleLandingLifecycle,
        runIssue,
        refreshLifecycle: async () => {
          throw new Error("refreshLifecycle should not be called");
        },
      },
      issue,
      2,
      "/tmp/lease-31",
      createLifecycle("handoff-ready", "symphony/31"),
      "running",
    );

    expect(completeIssue).toHaveBeenCalledOnce();
    expect(recordLifecycleObservation).not.toHaveBeenCalled();
    expect(handleLandingLifecycle).not.toHaveBeenCalled();
    expect(runIssue).not.toHaveBeenCalled();
  });

  it("records review-wait lifecycle observations without launching a run", async () => {
    const issue = createIssue(32);
    const {
      state,
      persistStatusSnapshot,
      completeIssue,
      recordLifecycleObservation,
      handleLandingLifecycle,
      runIssue,
    } = createContext();
    const lifecycle = createLifecycle("awaiting-human-review", "symphony/32", {
      summary: "Waiting for review",
    });

    await processClaimedIssue(
      {
        logger: new NullLogger(),
        tracker: {} as never,
        leaseManager: {} as never,
        state,
        recoveredRunningLifecycles: new Map(),
        persistStatusSnapshot,
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        missingLifecycle: (issueNumber) =>
          createLifecycle(
            "missing-target",
            `symphony/${issueNumber.toString()}`,
          ),
        handleUnexpectedFailure: async () => {},
        recordClaimedArtifact: async () => {},
        recordRunningInspectionArtifact: async () => {},
        recordLifecycleObservation,
        completeIssue,
        handleLandingLifecycle,
        runIssue,
        refreshLifecycle: async () => lifecycle,
      },
      issue,
      1,
      "/tmp/lease-32",
      undefined,
      "ready",
    );

    expect(recordLifecycleObservation).toHaveBeenCalledWith(
      issue,
      1,
      "symphony/32",
      lifecycle,
    );
    expect(state.status.activeIssues.get(issue.number)?.status).toBe(
      "awaiting-human-review",
    );
    expect(runIssue).not.toHaveBeenCalled();
    expect(completeIssue).not.toHaveBeenCalled();
  });

  it("routes awaiting-landing lifecycles through the landing coordinator", async () => {
    const issue = createIssue(33, "symphony:running");
    const {
      state,
      persistStatusSnapshot,
      completeIssue,
      recordLifecycleObservation,
      handleLandingLifecycle,
      runIssue,
    } = createContext();
    const lifecycle = createLifecycle("awaiting-landing", "symphony/33");

    await processClaimedIssue(
      {
        logger: new NullLogger(),
        tracker: {} as never,
        leaseManager: {} as never,
        state,
        recoveredRunningLifecycles: new Map(),
        persistStatusSnapshot,
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        missingLifecycle: (issueNumber) =>
          createLifecycle(
            "missing-target",
            `symphony/${issueNumber.toString()}`,
          ),
        handleUnexpectedFailure: async () => {},
        recordClaimedArtifact: async () => {},
        recordRunningInspectionArtifact: async () => {},
        recordLifecycleObservation,
        completeIssue,
        handleLandingLifecycle,
        runIssue,
        refreshLifecycle: async () => lifecycle,
      },
      issue,
      4,
      "/tmp/lease-33",
      undefined,
      "running",
    );

    expect(handleLandingLifecycle).toHaveBeenCalledWith(
      issue,
      4,
      "running",
      "symphony/33",
      lifecycle,
    );
    expect(runIssue).not.toHaveBeenCalled();
    expect(completeIssue).not.toHaveBeenCalled();
  });
});
