import type { RetryState } from "../domain/retry.js";

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly retries: Map<number, RetryState>;
}

export function createOrchestratorState(): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    retries: new Map<number, RetryState>(),
  };
}
