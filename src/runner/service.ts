import type { RunResult, RunSession, RunSpawnEvent } from "../domain/run.js";
export interface RunnerLogPointer {
  readonly name: string;
  readonly location: string | null;
  readonly archiveLocation: string | null;
}

export interface RunnerSessionDescription {
  readonly provider: string;
  readonly model: string | null;
  readonly logPointers: readonly RunnerLogPointer[];
}

export interface RunnerSessionDescriber {
  describeSession(session: RunSession): RunnerSessionDescription;
}

export interface RunnerRunOptions {
  readonly signal?: AbortSignal;
  readonly onSpawn?: (event: RunSpawnEvent) => void | Promise<void>;
}

export interface Runner extends RunnerSessionDescriber {
  run(session: RunSession, options?: RunnerRunOptions): Promise<RunResult>;
}
