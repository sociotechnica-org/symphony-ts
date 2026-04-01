import type { RateLimits } from "../domain/transient-failure.js";
import type { SshWorkerHostConfig } from "../domain/workflow.js";
import {
  createFollowUpRuntimeState,
  type FollowUpRuntimeState,
} from "./follow-up-state.js";
import {
  createDispatchPressureState,
  type DispatchPressureRuntimeState,
} from "./dispatch-pressure-state.js";
import {
  createRetryRuntimeState,
  type RetryRuntimeState,
} from "./retry-state.js";
import {
  createHostDispatchState,
  type HostDispatchRuntimeState,
} from "./host-dispatch-state.js";
import {
  createLocalDispatchRuntimeState,
  type LocalDispatchRuntimeState,
} from "./local-dispatch-state.js";
import type { RunningEntry } from "./running-entry.js";
import {
  createLandingRuntimeState,
  type LandingRuntimeState,
} from "./landing-state.js";
import {
  createRuntimeStatusState,
  type RuntimeStatusState,
} from "./status-state.js";
import {
  createWatchdogRuntimeState,
  type WatchdogRuntimeState,
} from "./watchdog-state.js";
import {
  createTerminalIssueReportingRuntimeState,
  type TerminalIssueReportingRuntimeState,
} from "./terminal-reporting-state.js";

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PollingState {
  checkingNow: boolean;
  nextPollAtMs: number;
  intervalMs: number;
}

export interface OrchestratorState {
  readonly localDispatch: LocalDispatchRuntimeState;
  readonly terminalIssueReporting: TerminalIssueReportingRuntimeState;
  readonly runAbortControllers: Map<number, AbortController>;
  readonly retries: RetryRuntimeState;
  readonly hostDispatch: HostDispatchRuntimeState;
  readonly dispatchPressure: DispatchPressureRuntimeState;
  readonly followUp: FollowUpRuntimeState;
  readonly landing: LandingRuntimeState;
  readonly status: RuntimeStatusState;
  readonly artifactWriteQueues: Map<number, Promise<void>>;
  readonly watchdog: WatchdogRuntimeState;
  readonly runningEntries: Map<number, RunningEntry>;
  readonly codexTotals: CodexTotals;
  rateLimits: RateLimits | null;
  readonly polling: PollingState;
}

export function createOrchestratorState(
  pollingIntervalMs: number,
  hostDispatchWorkerHosts: readonly SshWorkerHostConfig[] = [],
): OrchestratorState {
  return {
    localDispatch: createLocalDispatchRuntimeState(),
    terminalIssueReporting: createTerminalIssueReportingRuntimeState(),
    runAbortControllers: new Map<number, AbortController>(),
    retries: createRetryRuntimeState(),
    hostDispatch: createHostDispatchState(hostDispatchWorkerHosts),
    dispatchPressure: createDispatchPressureState(),
    followUp: createFollowUpRuntimeState(),
    landing: createLandingRuntimeState(),
    status: createRuntimeStatusState(),
    artifactWriteQueues: new Map<number, Promise<void>>(),
    watchdog: createWatchdogRuntimeState(),
    runningEntries: new Map<number, RunningEntry>(),
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    rateLimits: null,
    polling: {
      checkingNow: false,
      nextPollAtMs: Date.now(),
      intervalMs: pollingIntervalMs,
    },
  };
}
