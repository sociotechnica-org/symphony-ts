import type {
  RunnerSessionDescription,
  RunnerTransportKind,
} from "./service.js";
import { describeLocalRunnerBackend } from "./local-command.js";
import { createRunnerTransportMetadata } from "./service.js";

export function describeLocalRunnerSession(
  command: string,
  transportKind: RunnerTransportKind = "local-process",
): RunnerSessionDescription {
  const backend = describeLocalRunnerBackend(command);
  return {
    provider: backend.provider,
    model: backend.model,
    transport: createRunnerTransportMetadata(transportKind, {
      canTerminateLocalProcess: true,
    }),
    backendSessionId: null,
    backendThreadId: null,
    latestTurnId: null,
    latestTurnNumber: null,
    logPointers: [],
  };
}
