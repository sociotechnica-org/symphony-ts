import type {
  RunResult,
  RunSession,
  RunSpawnEvent,
  RunTurn,
} from "../domain/run.js";
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
  readonly onSpawn?: (event: RunSpawnEvent) => void | Promise<void>;
}

export interface RunnerTurnResult extends RunResult {
  readonly session: RunnerSessionDescription;
}

export interface LiveRunnerSession {
  describe(): RunnerSessionDescription;
  runTurn(turn: RunTurn, options?: RunnerRunOptions): Promise<RunnerTurnResult>;
}

export interface Runner extends RunnerSessionDescriber {
  run(session: RunSession, options?: RunnerRunOptions): Promise<RunResult>;
  startSession?(session: RunSession): Promise<LiveRunnerSession>;
}
