import type { RetryState } from "../domain/retry.js";
import {
  createFollowUpRuntimeState,
  type FollowUpRuntimeState,
} from "./follow-up-state.js";

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly retries: Map<number, RetryState>;
  readonly followUp: FollowUpRuntimeState;
}

export function createOrchestratorState(): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    retries: new Map<number, RetryState>(),
    followUp: createFollowUpRuntimeState(),
  };
}
