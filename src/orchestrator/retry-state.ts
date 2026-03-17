import type { RetryClass, RetryState } from "../domain/retry.js";
import type { RuntimeIssue } from "../domain/issue.js";

export interface RetryRuntimeState {
  readonly queueByIssueNumber: Map<number, RetryState>;
  readonly nextFailureRetryAttemptByIssueNumber: Map<number, number>;
}

export function createRetryRuntimeState(): RetryRuntimeState {
  return {
    queueByIssueNumber: new Map<number, RetryState>(),
    nextFailureRetryAttemptByIssueNumber: new Map<number, number>(),
  };
}

export function resolveFailureRetryAttempt(
  state: RetryRuntimeState,
  issueNumber: number,
): number {
  return state.nextFailureRetryAttemptByIssueNumber.get(issueNumber) ?? 1;
}

export function hasQueuedRetry(
  state: RetryRuntimeState,
  issueNumber: number,
): boolean {
  return state.queueByIssueNumber.has(issueNumber);
}

export function clearRetryState(
  state: RetryRuntimeState,
  issueNumber: number,
): void {
  state.queueByIssueNumber.delete(issueNumber);
  state.nextFailureRetryAttemptByIssueNumber.delete(issueNumber);
}

export function listQueuedRetries(
  state: RetryRuntimeState,
): readonly RetryState[] {
  return [...state.queueByIssueNumber.values()];
}

export function collectDueRetries(
  state: RetryRuntimeState,
  now = Date.now(),
): readonly RetryState[] {
  const due: RetryState[] = [];
  for (const [issueNumber, entry] of state.queueByIssueNumber.entries()) {
    if (entry.dueAt <= now) {
      due.push(entry);
      state.queueByIssueNumber.delete(issueNumber);
    }
  }
  return due;
}

export function listDueRetries(
  state: RetryRuntimeState,
  now = Date.now(),
): readonly RetryState[] {
  return [...state.queueByIssueNumber.values()].filter(
    (entry) => entry.dueAt <= now,
  );
}

export function scheduleRetry(
  state: RetryRuntimeState,
  options: {
    readonly issue: RuntimeIssue;
    readonly runSequence: number;
    readonly retryClass: RetryClass;
    readonly backoffMs: number;
    readonly message: string;
    readonly now?: number;
  },
): RetryState {
  const scheduledAt = options.now ?? Date.now();
  const failureRetryAttempt = resolveFailureRetryAttempt(
    state,
    options.issue.number,
  );
  const entry: RetryState = {
    issue: options.issue,
    runSequence: options.runSequence,
    failureRetryAttempt,
    nextAttempt: options.runSequence + 1,
    retryClass: options.retryClass,
    scheduledAt,
    backoffMs: options.backoffMs,
    dueAt: scheduledAt + options.backoffMs,
    lastError: options.message,
  };
  state.queueByIssueNumber.set(options.issue.number, entry);
  state.nextFailureRetryAttemptByIssueNumber.set(
    options.issue.number,
    failureRetryAttempt + 1,
  );
  return entry;
}
