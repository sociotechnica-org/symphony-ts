import type { RetryState } from "../domain/retry.js";
import {
  createFollowUpRuntimeState,
  type FollowUpRuntimeState,
} from "./follow-up-state.js";
import {
  createRuntimeStatusState,
  type RuntimeStatusState,
} from "./status-state.js";
import {
  createWatchdogRuntimeState,
  type WatchdogRuntimeState,
} from "./watchdog-state.js";

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly runAbortControllers: Map<number, AbortController>;
  readonly retries: Map<number, RetryState>;
  readonly followUp: FollowUpRuntimeState;
  readonly status: RuntimeStatusState;
  readonly artifactWriteQueues: Map<number, Promise<void>>;
  readonly watchdog: WatchdogRuntimeState;
}

export function createOrchestratorState(): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    runAbortControllers: new Map<number, AbortController>(),
    retries: new Map<number, RetryState>(),
    followUp: createFollowUpRuntimeState(),
    status: createRuntimeStatusState(),
    artifactWriteQueues: new Map<number, Promise<void>>(),
    watchdog: createWatchdogRuntimeState(),
  };
}
