import type { RunnerSessionDescription } from "./service.js";
import { describeLocalRunnerBackend } from "./local-command.js";

export function describeLocalRunnerSession(
  command: string,
): RunnerSessionDescription {
  const backend = describeLocalRunnerBackend(command);
  return {
    provider: backend.provider,
    model: backend.model,
    backendSessionId: null,
    latestTurnNumber: null,
    logPointers: [],
  };
}
