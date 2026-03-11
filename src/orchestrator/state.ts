import type { RetryState } from "../domain/retry.js";
import {
  createFollowUpRuntimeState,
  type FollowUpRuntimeState,
} from "./follow-up-state.js";
import type { RunningEntry } from "./running-entry.js";
import {
  createRuntimeStatusState,
  type RuntimeStatusState,
} from "./status-state.js";
import {
  createWatchdogRuntimeState,
  type WatchdogRuntimeState,
} from "./watchdog-state.js";

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RateLimits {
  readonly limitId: string | null;
  readonly primary: { readonly used: number; readonly limit: number; readonly resetInMs: number } | null;
  readonly secondary: { readonly used: number; readonly limit: number; readonly resetInMs: number } | null;
  readonly credits: string | null;
}

export interface PollingState {
  checkingNow: boolean;
  nextPollAtMs: number;
  intervalMs: number;
}

export interface OrchestratorState {
  readonly runningIssueNumbers: Set<number>;
  readonly runAbortControllers: Map<number, AbortController>;
  readonly retries: Map<number, RetryState>;
  readonly followUp: FollowUpRuntimeState;
  readonly status: RuntimeStatusState;
  readonly artifactWriteQueues: Map<number, Promise<void>>;
  readonly watchdog: WatchdogRuntimeState;
  readonly runningEntries: Map<number, RunningEntry>;
  readonly codexTotals: CodexTotals;
  rateLimits: RateLimits | null;
  readonly polling: PollingState;
}

export function createOrchestratorState(pollingIntervalMs: number): OrchestratorState {
  return {
    runningIssueNumbers: new Set<number>(),
    runAbortControllers: new Map<number, AbortController>(),
    retries: new Map<number, RetryState>(),
    followUp: createFollowUpRuntimeState(),
    status: createRuntimeStatusState(),
    artifactWriteQueues: new Map<number, Promise<void>>(),
    watchdog: createWatchdogRuntimeState(),
    runningEntries: new Map<number, RunningEntry>(),
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    rateLimits: null,
    polling: {
      checkingNow: false,
      nextPollAtMs: Date.now(),
      intervalMs: pollingIntervalMs,
    },
  };
}
