import type { RunSession } from "../domain/run.js";
import type { RetryState } from "../domain/retry.js";

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly activeRuns: Map<number, RunSession>;
  readonly retries: Map<number, RetryState>;
}

export function createOrchestratorState(): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    activeRuns: new Map<number, RunSession>(),
    retries: new Map<number, RetryState>(),
  };
}
