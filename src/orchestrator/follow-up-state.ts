import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryState } from "../domain/retry.js";

export type ContinuationReason =
  | "implementation"
  | "rework"
  | "waiting-plan-review"
  | "waiting-human-review"
  | "waiting-system-checks"
  | "landing";

export interface FollowUpRuntimeState {
  readonly nextRunSequenceByIssueNumber: Map<number, number>;
  readonly activeContinuationByIssueNumber: Map<number, ContinuationReason>;
  readonly nextFailureRetryAttemptByIssueNumber: Map<number, number>;
}

export interface LifecycleObservationDecision {
  readonly nextRunSequence: number;
  readonly continuationReason: ContinuationReason | null;
}

export function createFollowUpRuntimeState(): FollowUpRuntimeState {
  return {
    nextRunSequenceByIssueNumber: new Map<number, number>(),
    activeContinuationByIssueNumber: new Map<number, ContinuationReason>(),
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
  state.activeContinuationByIssueNumber.delete(issueNumber);
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
  state.activeContinuationByIssueNumber.delete(issue.number);
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
  lifecycle: HandoffLifecycle,
): LifecycleObservationDecision {
  const nextRunSequence = attempt + 1;
  state.nextRunSequenceByIssueNumber.set(issueNumber, nextRunSequence);
  const continuationReason = resolveContinuationReason(lifecycle);
  if (continuationReason === null) {
    state.activeContinuationByIssueNumber.delete(issueNumber);
  } else {
    state.activeContinuationByIssueNumber.set(issueNumber, continuationReason);
  }
  return {
    nextRunSequence,
    continuationReason,
  };
}

function resolveContinuationReason(
  lifecycle: HandoffLifecycle,
): ContinuationReason | null {
  switch (lifecycle.kind) {
    case "missing-target":
      return "implementation";
    case "awaiting-human-handoff":
      return "waiting-plan-review";
    case "awaiting-human-review":
      return "waiting-human-review";
    case "awaiting-system-checks":
      return "waiting-system-checks";
    case "awaiting-landing-command":
    case "awaiting-landing":
      return "landing";
    case "rework-required":
      return "rework";
    case "handoff-ready":
      return null;
  }
}
