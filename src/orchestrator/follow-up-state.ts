import type { RuntimeIssue } from "../domain/issue.js";
import type { PullRequestLifecycle } from "../domain/pull-request.js";
import type { RetryState } from "../domain/retry.js";

export interface FollowUpRuntimeState {
  readonly nextRunSequenceByIssueNumber: Map<number, number>;
  readonly followUpAttemptsByIssueNumber: Map<number, number>;
  readonly nextFailureRetryAttemptByIssueNumber: Map<number, number>;
}

export interface FollowUpBudgetDecision {
  readonly kind: "continue" | "exhausted";
  readonly nextRunSequence: number;
  readonly followUpAttempt: number | null;
}

export function createFollowUpRuntimeState(): FollowUpRuntimeState {
  return {
    nextRunSequenceByIssueNumber: new Map<number, number>(),
    followUpAttemptsByIssueNumber: new Map<number, number>(),
    nextFailureRetryAttemptByIssueNumber: new Map<number, number>(),
  };
}

export function resolveRunSequence(
  state: FollowUpRuntimeState,
  issueNumber: number,
  retryAttempts: ReadonlyMap<number, number>,
): number {
  return (
    retryAttempts.get(issueNumber) ??
    state.nextRunSequenceByIssueNumber.get(issueNumber) ??
    1
  );
}

export function clearFollowUpRuntimeState(
  state: FollowUpRuntimeState,
  issueNumber: number,
): void {
  state.nextRunSequenceByIssueNumber.delete(issueNumber);
  state.followUpAttemptsByIssueNumber.delete(issueNumber);
  state.nextFailureRetryAttemptByIssueNumber.delete(issueNumber);
}

export function resolveFailureRetryAttempt(
  state: FollowUpRuntimeState,
  issueNumber: number,
): number {
  return state.nextFailureRetryAttemptByIssueNumber.get(issueNumber) ?? 1;
}

export function noteRetryScheduled(
  state: FollowUpRuntimeState,
  issue: RuntimeIssue,
  runSequence: number,
  failureRetryAttempt: number,
  backoffMs: number,
  message: string,
): RetryState {
  const nextAttempt = runSequence + 1;
  state.nextRunSequenceByIssueNumber.set(issue.number, nextAttempt);
  state.followUpAttemptsByIssueNumber.delete(issue.number);
  state.nextFailureRetryAttemptByIssueNumber.set(
    issue.number,
    failureRetryAttempt + 1,
  );
  return {
    issue,
    nextAttempt,
    dueAt: Date.now() + backoffMs,
    lastError: message,
  };
}

export function noteLifecycleObservation(
  state: FollowUpRuntimeState,
  issueNumber: number,
  attempt: number,
  lifecycle: PullRequestLifecycle,
  maxFollowUpAttempts: number,
): FollowUpBudgetDecision {
  const nextRunSequence = attempt + 1;
  state.nextRunSequenceByIssueNumber.set(issueNumber, nextRunSequence);

  if (lifecycle.kind !== "needs-follow-up") {
    return {
      kind: "continue",
      nextRunSequence,
      followUpAttempt: null,
    };
  }

  const nextFollowUpAttempt =
    (state.followUpAttemptsByIssueNumber.get(issueNumber) ?? 0) + 1;
  state.followUpAttemptsByIssueNumber.set(issueNumber, nextFollowUpAttempt);
  if (nextFollowUpAttempt >= maxFollowUpAttempts) {
    return {
      kind: "exhausted",
      nextRunSequence,
      followUpAttempt: nextFollowUpAttempt,
    };
  }
  return {
    kind: "continue",
    nextRunSequence,
    followUpAttempt: nextFollowUpAttempt,
  };
}
