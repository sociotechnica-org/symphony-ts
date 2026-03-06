import type { RunResult, RunSession } from "../domain/run.js";

export interface Runner {
  run(session: RunSession): Promise<RunResult>;
}
