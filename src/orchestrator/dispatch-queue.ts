import type { RuntimeIssue } from "../domain/issue.js";
import { compareRuntimeIssuesByQueuePriority } from "../domain/queue-priority.js";
import type { RetryState } from "../domain/retry.js";

export interface QueueEntry {
  readonly issue: RuntimeIssue;
  readonly attempt: number;
  readonly source: "ready" | "running";
}

export function orderReadyCandidates(
  readyCandidates: readonly RuntimeIssue[],
  runningCandidates: readonly RuntimeIssue[],
  dueRetries: readonly RetryState[],
  options: {
    readonly hasQueuedRetry: (issueNumber: number) => boolean;
  },
): readonly RuntimeIssue[] {
  const dueRetryIssueNumbers = new Set(
    dueRetries.map((retry) => retry.issue.number),
  );
  const runningIssueNumbers = new Set(
    runningCandidates.map((issue) => issue.number),
  );

  return [...readyCandidates]
    .filter((issue) => {
      if (runningIssueNumbers.has(issue.number)) {
        return false;
      }
      if (
        !dueRetryIssueNumbers.has(issue.number) &&
        options.hasQueuedRetry(issue.number)
      ) {
        return false;
      }
      return true;
    })
    .sort(compareRuntimeIssuesByQueuePriority);
}

export function mergeDispatchQueue(
  readyCandidates: readonly RuntimeIssue[],
  runningCandidates: readonly RuntimeIssue[],
  dueRetries: readonly RetryState[],
  options: {
    readonly hasQueuedRetry: (issueNumber: number) => boolean;
    readonly resolveAttemptNumber: (
      issueNumber: number,
      retryAttempts: ReadonlyMap<number, number>,
    ) => number;
  },
): readonly QueueEntry[] {
  const retryAttempts = new Map<number, number>();
  for (const retry of dueRetries) {
    retryAttempts.set(retry.issue.number, retry.nextAttempt);
  }

  const running: QueueEntry[] = [];
  for (const issue of [...runningCandidates].sort(
    (left, right) => left.number - right.number,
  )) {
    if (
      !retryAttempts.has(issue.number) &&
      options.hasQueuedRetry(issue.number)
    ) {
      continue;
    }
    running.push({
      issue,
      attempt: options.resolveAttemptNumber(issue.number, retryAttempts),
      source: "running",
    });
  }

  const runningIssueNumbers = new Set(
    running.map((entry) => entry.issue.number),
  );
  const ready: QueueEntry[] = [];
  for (const issue of readyCandidates) {
    if (runningIssueNumbers.has(issue.number)) {
      continue;
    }
    ready.push({
      issue,
      attempt: options.resolveAttemptNumber(issue.number, retryAttempts),
      source: "ready",
    });
  }

  return [...running, ...ready];
}
