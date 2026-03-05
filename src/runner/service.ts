import type { AgentConfig, RunContext, RunResult } from "../domain/types.js";

export interface Runner {
  run(context: RunContext, config: AgentConfig): Promise<RunResult>;
}
