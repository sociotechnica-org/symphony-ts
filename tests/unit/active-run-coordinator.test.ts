import { describe, expect, it, vi } from "vitest";
import { runIssue } from "../../src/orchestrator/active-run-coordinator.js";
import { createIssue } from "../support/pull-request.js";
import {
  createRunSession,
  createRunnerSessionDescription,
  createRunnerVisibility,
  createTestConfig,
  createTestState,
  createWorkerHost,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

describe("active run coordinator", () => {
  it("blocks early when dispatch pressure is active", async () => {
    const config = createTestConfig("/tmp/active-run-pressure");
    const state = createTestState(config);
    state.status.factoryHalt = {
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    };
    state.dispatchPressure.current = {
      retryClass: "provider-rate-limit",
      reason: "provider paused",
      observedAt: "2026-04-09T00:00:00.000Z",
      resumeAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const issue = createIssue(71);
    const prepareWorkspace = vi.fn(async () => {
      throw new Error("prepareWorkspace should not run");
    });

    const result = await runIssue(
      {
        config,
        promptBuilder: {
          build: async () => "prompt",
          buildContinuation: async () => "prompt",
        },
        workspaceManager: {
          prepareWorkspace,
        } as never,
        runner: {
          describeSession: () => createRunnerSessionDescription(),
        } as never,
        tracker: {} as never,
        logger: new NullLogger(),
        state,
        instanceId: "test-instance",
        shutdownSignal: undefined,
        leaseManager: {} as never,
        notifyDashboard: () => {},
        persistStatusSnapshot: async () => {},
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        createRunSession: (runIssue, workspace, prompt, attempt) =>
          createRunSession(runIssue, workspace, attempt, prompt),
        createExecutionOwner: () => null,
        buildRunnerVisibility: (description) =>
          createRunnerVisibility(description),
        recordRunStartedObservation: async () => {},
        createRunTurn: async () => ({ prompt: "prompt", turnNumber: 1 }),
        runRunnerTurn: async () => {
          throw new Error("runRunnerTurn should not run");
        },
        captureLiveSessionState: (sessionState) => sessionState,
        warnIfContinuationSessionUnavailable: () => {},
        initWatchdogEntry: () => {},
        runWatchdogLoop: async () => {},
        setIssueRunnerVisibility: () => {},
        setIssueFailureVisibility: () => {},
        beginActiveRunShutdown: () => {},
        finalizeActiveRunShutdown: async () => {},
        handleFailure: async () => {},
        classifyFailure: (
          message,
          _signal,
          _observedAt,
          retryClass = "run-failure",
        ) => ({
          retryClass,
          message,
          dispatchPressure: null,
        }),
        resolveRunFailureMessage: (_issueNumber, error) => error.message,
        resolveRetryClass: () => "run-failure",
        completeIssue: async () => {},
        handleTurnLifecycleExit: async () => {},
      },
      issue,
      1,
      "/tmp/lease-71",
      "ready",
      null,
    );

    expect(result).toBe(false);
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });

  it("releases a reserved remote host when workspace preparation fails before session setup", async () => {
    const workerHost = createWorkerHost("host-z");
    const config = createTestConfig("/tmp/active-run-host-failure");
    const state = createTestState(config, [workerHost]);
    const issue = createIssue(72);

    await expect(
      runIssue(
        {
          config,
          promptBuilder: {
            build: async () => "prompt",
            buildContinuation: async () => "prompt",
          },
          workspaceManager: {
            prepareWorkspace: async () => {
              throw new Error("workspace exploded");
            },
          } as never,
          runner: {
            describeSession: () => createRunnerSessionDescription(),
          } as never,
          tracker: {} as never,
          logger: new NullLogger(),
          state,
          instanceId: "test-instance",
          shutdownSignal: undefined,
          leaseManager: {} as never,
          notifyDashboard: () => {},
          persistStatusSnapshot: async () => {},
          branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
          createRunSession: (runIssue, workspace, prompt, attempt) =>
            createRunSession(runIssue, workspace, attempt, prompt),
          createExecutionOwner: () => null,
          buildRunnerVisibility: (description) =>
            createRunnerVisibility(description),
          recordRunStartedObservation: async () => {},
          createRunTurn: async () => ({ prompt: "prompt", turnNumber: 1 }),
          runRunnerTurn: async () => {
            throw new Error("runRunnerTurn should not run");
          },
          captureLiveSessionState: (sessionState) => sessionState,
          warnIfContinuationSessionUnavailable: () => {},
          initWatchdogEntry: () => {},
          runWatchdogLoop: async () => {},
          setIssueRunnerVisibility: () => {},
          setIssueFailureVisibility: () => {},
          beginActiveRunShutdown: () => {},
          finalizeActiveRunShutdown: async () => {},
          handleFailure: async () => {},
          classifyFailure: (
            message,
            _signal,
            _observedAt,
            retryClass = "run-failure",
          ) => ({
            retryClass,
            message,
            dispatchPressure: null,
          }),
          resolveRunFailureMessage: (_issueNumber, error) => error.message,
          resolveRetryClass: () => "run-failure",
          completeIssue: async () => {},
          handleTurnLifecycleExit: async () => {},
        },
        issue,
        1,
        "/tmp/lease-72",
        "ready",
        null,
      ),
    ).rejects.toThrow("workspace exploded");

    expect(state.hostDispatch.occupancyByHost.size).toBe(0);
  });
});
