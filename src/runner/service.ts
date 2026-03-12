import type { RunSession, RunTurn } from "../domain/run.js";

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

export type RunnerEvent = RunnerSpawnedEvent;
export interface RunnerLogPointer {
  readonly name: string;
  readonly location: string | null;
  readonly archiveLocation: string | null;
}

export interface RunnerSessionDescription {
  readonly provider: string;
  readonly model: string | null;
  readonly backendSessionId: string | null;
  readonly latestTurnNumber: number | null;
  readonly logPointers: readonly RunnerLogPointer[];
}

export interface RunnerSessionDescriber {
  describeSession(session: RunSession): RunnerSessionDescription;
}

export interface RunnerRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunnerEvent) => void | Promise<void>;
}

export interface RunnerTurnResult extends RunnerExecutionResult {
  readonly session: RunnerSessionDescription;
}

export interface LiveRunnerSession {
  describe(): RunnerSessionDescription;
  runTurn(turn: RunTurn, options?: RunnerRunOptions): Promise<RunnerTurnResult>;
}

export interface Runner extends RunnerSessionDescriber {
  run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunnerExecutionResult>;
  startSession?(session: RunSession): Promise<LiveRunnerSession>;
}
