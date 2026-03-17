import type { HandoffLifecycle } from "../domain/handoff.js";

export interface FollowUpRuntimeState {
  readonly nextRunSequenceByIssueNumber: Map<number, number>;
}

export function createFollowUpRuntimeState(): FollowUpRuntimeState {
  return {
    nextRunSequenceByIssueNumber: new Map<number, number>(),
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
}

export function noteLifecycleObservation(
  state: FollowUpRuntimeState,
  issueNumber: number,
  attempt: number,
  _lifecycle: HandoffLifecycle,
): void {
  const nextRunSequence = attempt + 1;
  state.nextRunSequenceByIssueNumber.set(issueNumber, nextRunSequence);
}
