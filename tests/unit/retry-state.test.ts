import { describe, expect, it } from "vitest";
import { createIssue } from "../support/pull-request.js";
import {
  clearRetryState,
  collectDueRetries,
  createRetryRuntimeState,
  hasQueuedRetry,
  resolveFailureRetryAttempt,
  scheduleRetry,
} from "../../src/orchestrator/retry-state.js";

describe("retry-state", () => {
  it("schedules a retry with explicit class and due-time metadata", () => {
    const state = createRetryRuntimeState();
    const issue = createIssue(18);

    const retry = scheduleRetry(state, {
      issue,
      runSequence: 3,
      retryClass: "run-failure",
      backoffMs: 5_000,
      message: "Runner exited with 1",
      now: 1_000,
    });

    expect(retry.nextAttempt).toBe(4);
    expect(retry.failureRetryAttempt).toBe(1);
    expect(retry.retryClass).toBe("run-failure");
    expect(retry.scheduledAt).toBe(1_000);
    expect(retry.dueAt).toBe(6_000);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(2);
    expect(hasQueuedRetry(state, issue.number)).toBe(true);
  });

  it("collects and removes only due retries", () => {
    const state = createRetryRuntimeState();
    const dueIssue = createIssue(19);
    const laterIssue = createIssue(20);

    scheduleRetry(state, {
      issue: dueIssue,
      runSequence: 1,
      retryClass: "missing-target",
      backoffMs: 0,
      message: "missing",
      now: 500,
    });
    scheduleRetry(state, {
      issue: laterIssue,
      runSequence: 1,
      retryClass: "run-failure",
      backoffMs: 5_000,
      message: "boom",
      now: 1_000,
    });

    const due = collectDueRetries(state, 750);

    expect(due).toHaveLength(1);
    expect(due[0]?.issue.number).toBe(19);
    expect(hasQueuedRetry(state, 19)).toBe(false);
    expect(hasQueuedRetry(state, 20)).toBe(true);
  });

  it("clears queued retry state and retry-attempt counters together", () => {
    const state = createRetryRuntimeState();
    const issue = createIssue(21);

    scheduleRetry(state, {
      issue,
      runSequence: 2,
      retryClass: "watchdog-abort",
      backoffMs: 1_000,
      message: "stalled",
    });

    clearRetryState(state, issue.number);

    expect(hasQueuedRetry(state, issue.number)).toBe(false);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(1);
  });
});
