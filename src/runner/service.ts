import type { RunResult, RunSession, RunSpawnEvent } from "../domain/run.js";

export interface RunnerRunOptions {
  readonly signal?: AbortSignal;
  readonly onSpawn?: (event: RunSpawnEvent) => void | Promise<void>;
}

export interface Runner {
  run(session: RunSession, options?: RunnerRunOptions): Promise<RunResult>;
}
