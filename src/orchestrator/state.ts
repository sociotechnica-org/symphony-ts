import type { PullRequestLifecycle } from "../domain/pull-request.js";
import type { RetryState } from "../domain/retry.js";

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly retries: Map<number, RetryState>;
  readonly nextAttemptByIssueNumber: Map<number, number>;
  readonly pullRequestLifecycles: Map<number, PullRequestLifecycle>;
}

export function createOrchestratorState(): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    retries: new Map<number, RetryState>(),
    nextAttemptByIssueNumber: new Map<number, number>(),
    pullRequestLifecycles: new Map<number, PullRequestLifecycle>(),
  };
}
