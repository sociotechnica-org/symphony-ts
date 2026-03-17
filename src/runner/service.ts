import type { RunSession, RunTurn, RunUpdateEvent } from "../domain/run.js";

// Give local runners a real chance to flush/exit cleanly before escalation.
export const RUNNER_SHUTDOWN_GRACE_MS = 2_000;

export interface RunnerExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface RunnerSpawnedEvent {
  readonly kind: "spawned";
  readonly pid: number;
  readonly spawnedAt: string;
}

export type RunnerVisibilityState =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

export type RunnerVisibilityPhase =
  | "boot"
  | "session-start"
  | "turn-execution"
  | "turn-finished"
  | "handoff-reconciliation"
  | "awaiting-external"
  | "shutdown";

export interface RunnerLogPointer {
  readonly name: string;
  readonly location: string | null;
  readonly archiveLocation: string | null;
}

export interface RunnerSessionDescription {
  readonly provider: string;
  readonly model: string | null;
  readonly backendSessionId: string | null;
  readonly backendThreadId: string | null;
  readonly latestTurnId: string | null;
  readonly appServerPid: number | null;
  readonly latestTurnNumber: number | null;
  readonly logPointers: readonly RunnerLogPointer[];
}

export interface RunnerVisibilitySnapshot {
  readonly state: RunnerVisibilityState;
  readonly phase: RunnerVisibilityPhase;
  readonly session: RunnerSessionDescription;
  readonly lastHeartbeatAt: string | null;
  readonly lastActionAt: string | null;
  readonly lastActionSummary: string | null;
  readonly waitingReason: string | null;
  readonly stdoutSummary: string | null;
  readonly stderrSummary: string | null;
  readonly errorSummary: string | null;
  readonly cancelledAt: string | null;
  readonly timedOutAt: string | null;
}

export interface RunnerVisibilityEvent {
  readonly kind: "visibility";
  readonly visibility: RunnerVisibilitySnapshot;
}

export type RunnerEvent = RunnerSpawnedEvent | RunnerVisibilityEvent;

export interface RunnerSessionDescriber {
  describeSession(session: RunSession): RunnerSessionDescription;
}

export interface RunnerRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunnerEvent) => void | Promise<void>;
  readonly onUpdate?: (event: RunUpdateEvent) => void;
}

export interface RunnerTurnResult extends RunnerExecutionResult {
  readonly session: RunnerSessionDescription;
}

export interface LiveRunnerSession {
  describe(): RunnerSessionDescription;
  runTurn(turn: RunTurn, options?: RunnerRunOptions): Promise<RunnerTurnResult>;
  close(): Promise<void>;
}

export interface Runner extends RunnerSessionDescriber {
  run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunnerExecutionResult>;
  startSession?(session: RunSession): Promise<LiveRunnerSession>;
}

const SUMMARY_LIMIT = 160;

export function summarizeRunnerText(text: string): string | null {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  if (collapsed.length <= SUMMARY_LIMIT) {
    return collapsed;
  }
  return `${collapsed.slice(0, SUMMARY_LIMIT - 3)}...`;
}
