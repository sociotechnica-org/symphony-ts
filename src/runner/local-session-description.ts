import type { RunSession } from "../domain/run.js";
import type { RunnerSessionDescription, RunnerTransportKind } from "./service.js";
import { describeLocalRunnerBackend } from "./local-command.js";
import { createRunnerTransportMetadata } from "./service.js";
import { createLocalProcessWatchdogLogPointers } from "./watchdog-log-pointer.js";

export function describeLocalRunnerSession(
  command: string,
  session?: RunSession,
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
    logPointers:
      transportKind === "local-process" && session !== undefined
        ? createLocalProcessWatchdogLogPointers(session)
        : [],
  };
}
