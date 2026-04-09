import { describe, expect, it, vi } from "vitest";
import { noteLandingAttempt } from "../../src/orchestrator/landing-state.js";
import {
  executeLanding,
  handleLandingLifecycle,
} from "../../src/orchestrator/landing-coordinator.js";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  createTestConfig,
  createTestState,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

function createContext() {
  const config = createTestConfig("/tmp/landing-coordinator");
  const state = createTestState(config);
  return {
    state,
    tracker: {
      executeLanding: vi.fn(async () => ({
        kind: "requested" as const,
        summary: "Landing requested",
      })),
    },
    persistStatusSnapshot: vi.fn(async () => {}),
    recordLifecycleObservation: vi.fn(async () => {}),
    recordLandingObservation: vi.fn(async () => {}),
    completeIssue: vi.fn(async () => {}),
  };
}

describe("landing coordinator", () => {
  it("suppresses duplicate landing attempts for the same head sha", async () => {
    const issue = createIssue(41, "symphony:running");
    const lifecycle = createLifecycle("awaiting-landing", "symphony/41");
    const {
      state,
      tracker,
      persistStatusSnapshot,
      recordLifecycleObservation,
      recordLandingObservation,
      completeIssue,
    } = createContext();
    noteLandingAttempt(
      state.landing,
      issue.number,
      lifecycle.pullRequest?.headSha ?? null,
    );

    await handleLandingLifecycle(
      {
        logger: new NullLogger(),
        tracker: tracker as never,
        state,
        normalizeFailure: (error) => error.message,
        persistStatusSnapshot,
        recordLifecycleObservation,
        recordLandingObservation,
        refreshLifecycle: async () => lifecycle,
        completeIssue,
      },
      issue,
      1,
      "running",
      "symphony/41",
      lifecycle,
    );

    expect(tracker.executeLanding).not.toHaveBeenCalled();
    expect(recordLifecycleObservation).toHaveBeenCalledOnce();
    expect(recordLandingObservation).not.toHaveBeenCalled();
  });

  it("completes the issue when refreshed lifecycle becomes handoff-ready", async () => {
    const issue = createIssue(42, "symphony:running");
    const lifecycle = createLifecycle("awaiting-landing", "symphony/42");
    const refreshedLifecycle = createLifecycle("handoff-ready", "symphony/42");
    const {
      state,
      tracker,
      persistStatusSnapshot,
      recordLifecycleObservation,
      recordLandingObservation,
      completeIssue,
    } = createContext();

    await executeLanding(
      {
        logger: new NullLogger(),
        tracker: tracker as never,
        state,
        normalizeFailure: (error) => error.message,
        persistStatusSnapshot,
        recordLifecycleObservation,
        recordLandingObservation,
        refreshLifecycle: async () => refreshedLifecycle,
        completeIssue,
      },
      issue,
      2,
      "running",
      "symphony/42",
      lifecycle,
    );

    expect(tracker.executeLanding).toHaveBeenCalledOnce();
    expect(recordLandingObservation).toHaveBeenCalledOnce();
    expect(completeIssue).toHaveBeenCalledOnce();
    expect(state.landing.attemptedHeadShaByIssueNumber.has(issue.number)).toBe(
      false,
    );
  });
});
