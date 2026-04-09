import { describe, expect, it } from "vitest";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RetryState } from "../../src/domain/retry.js";
import {
  mergeDispatchQueue,
  orderReadyCandidates,
} from "../../src/orchestrator/dispatch-queue.js";

function createIssue(
  number: number,
  options: {
    readonly queuePriority?: RuntimeIssue["queuePriority"];
  } = {},
): RuntimeIssue {
  return {
    id: `issue-${number}`,
    identifier: `#${number}`,
    number,
    title: `Issue ${number}`,
    description: "",
    labels: [],
    state: "open",
    url: `https://example.test/issues/${number}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    queuePriority: options.queuePriority ?? null,
  };
}

function createRetryState(
  issue: RuntimeIssue,
  options: {
    readonly nextAttempt: number;
  },
): RetryState {
  return {
    issue,
    runSequence: options.nextAttempt - 1,
    failureRetryAttempt: options.nextAttempt - 1,
    nextAttempt: options.nextAttempt,
    preferredHost: null,
    retryClass: "run-failure",
    scheduledAt: 0,
    backoffMs: 0,
    dueAt: 0,
    lastError: "failed",
  };
}

describe("dispatch queue helpers", () => {
  it("orders ready issues by queue priority while excluding running and non-due queued retries", () => {
    const running = createIssue(2);
    const dueRetry = createIssue(3, {
      queuePriority: { rank: 1, label: "P1" },
    });
    const highestPriority = createIssue(4, {
      queuePriority: { rank: 0, label: "P0" },
    });
    const suppressedQueuedRetry = createIssue(5, {
      queuePriority: { rank: 2, label: "P2" },
    });

    const ordered = orderReadyCandidates(
      [running, suppressedQueuedRetry, dueRetry, highestPriority],
      [running],
      [createRetryState(dueRetry, { nextAttempt: 2 })],
      {
        hasQueuedRetry: (issueNumber) =>
          issueNumber === suppressedQueuedRetry.number,
      },
    );

    expect(ordered.map((issue) => issue.number)).toEqual([4, 3]);
  });

  it("merges running work ahead of ready work and applies retry attempt numbers", () => {
    const running = createIssue(10);
    const ready = createIssue(11);
    const retry = createRetryState(running, { nextAttempt: 4 });

    const queue = mergeDispatchQueue([ready], [running], [retry], {
      hasQueuedRetry: () => false,
      resolveAttemptNumber: (issueNumber, retryAttempts) =>
        retryAttempts.get(issueNumber) ?? 1,
    });

    expect(queue).toEqual([
      {
        issue: running,
        attempt: 4,
        source: "running",
      },
      {
        issue: ready,
        attempt: 1,
        source: "ready",
      },
    ]);
  });
});
