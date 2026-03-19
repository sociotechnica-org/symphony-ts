import os from "node:os";
import type { RunSession } from "./run.js";
import type { PreparedWorkspace } from "./workspace.js";
import type {
  RunnerSessionDescription,
  RunnerTransportMetadata,
} from "../runner/service.js";

export interface ActiveRunOwnerFactoryIdentity {
  readonly host: string;
  readonly instanceId: string;
  readonly pid: number | null;
}

export interface ActiveRunLocalControlIdentity {
  readonly host: string;
  readonly pid: number | null;
  readonly canTerminate: boolean;
}

export interface ActiveRunEndpointIdentity {
  readonly workspaceTargetKind: PreparedWorkspace["target"]["kind"];
  readonly workspaceHost: string | null;
  readonly workspacePath: string | null;
  readonly workspaceId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly backendSessionId: string | null;
  readonly backendThreadId: string | null;
}

export interface ActiveRunExecutionOwner {
  readonly factory: ActiveRunOwnerFactoryIdentity;
  readonly runSessionId: string;
  readonly transport: RunnerTransportMetadata;
  readonly localControl: ActiveRunLocalControlIdentity | null;
  readonly endpoint: ActiveRunEndpointIdentity;
}

export function currentHostName(): string {
  return os.hostname();
}

export function createActiveRunExecutionOwner(input: {
  readonly session: RunSession;
  readonly description: RunnerSessionDescription;
  readonly factoryHost: string;
  readonly factoryInstanceId: string;
  readonly factoryPid?: number | null;
}): ActiveRunExecutionOwner {
  const workspaceTarget = input.session.workspace.target;
  return {
    factory: {
      host: input.factoryHost,
      instanceId: input.factoryInstanceId,
      pid: input.factoryPid ?? process.pid,
    },
    runSessionId: input.session.id,
    transport: input.description.transport,
    localControl:
      input.description.transport.localProcess === null
        ? null
        : {
            host: input.factoryHost,
            pid: input.description.transport.localProcess.pid,
            canTerminate: input.description.transport.localProcess.canTerminate,
          },
    endpoint: {
      workspaceTargetKind: workspaceTarget.kind,
      workspaceHost:
        workspaceTarget.kind === "remote" ? workspaceTarget.host : null,
      workspacePath:
        workspaceTarget.kind === "local" ? workspaceTarget.path : null,
      workspaceId:
        workspaceTarget.kind === "remote" ? workspaceTarget.workspaceId : null,
      provider: input.description.provider,
      model: input.description.model,
      backendSessionId: input.description.backendSessionId,
      backendThreadId: input.description.backendThreadId,
    },
  };
}

export function withExecutionOwnerTransport(
  owner: ActiveRunExecutionOwner,
  transport: RunnerTransportMetadata,
): ActiveRunExecutionOwner {
  return {
    ...owner,
    transport,
    localControl:
      transport.localProcess === null
        ? null
        : {
            host: owner.factory.host,
            pid: transport.localProcess.pid,
            canTerminate: transport.localProcess.canTerminate,
          },
  };
}

export function deriveExecutionOwnerOwnerPid(
  owner: ActiveRunExecutionOwner | null | undefined,
): number | null {
  return owner?.factory.pid ?? null;
}

export function deriveExecutionOwnerRunnerPid(
  owner: ActiveRunExecutionOwner | null | undefined,
): number | null {
  if (owner?.localControl?.canTerminate !== true) {
    return null;
  }
  return owner.localControl.pid ?? null;
}

export function canControlExecutionOwnerLocally(
  owner: ActiveRunExecutionOwner | null | undefined,
  host: string,
): boolean {
  return (
    owner?.localControl !== null &&
    owner?.localControl !== undefined &&
    owner.localControl.canTerminate &&
    owner.localControl.host === host &&
    owner.localControl.pid !== null
  );
}

export function normalizeExecutionOwner(input: {
  readonly executionOwner?: ActiveRunExecutionOwner | null | undefined;
  readonly legacyOwnerPid?: number | null | undefined;
  readonly legacyRunnerPid?: number | null | undefined;
  readonly runSessionId?: string | null | undefined;
  readonly defaultHost: string;
}): ActiveRunExecutionOwner | null {
  if (input.executionOwner !== undefined) {
    return input.executionOwner;
  }
  const ownerPid = input.legacyOwnerPid ?? null;
  const runnerPid = input.legacyRunnerPid ?? null;
  if (ownerPid === null && runnerPid === null) {
    return null;
  }
  return {
    factory: {
      host: input.defaultHost,
      instanceId: "legacy-local",
      pid: ownerPid,
    },
    runSessionId: input.runSessionId ?? "legacy-local",
    transport: {
      kind: "local-process",
      localProcess:
        runnerPid === null
          ? null
          : {
              pid: runnerPid,
              canTerminate: true,
            },
      remoteSessionId: null,
      remoteTaskId: null,
    },
    localControl:
      runnerPid === null
        ? null
        : {
            host: input.defaultHost,
            pid: runnerPid,
            canTerminate: true,
          },
    endpoint: {
      workspaceTargetKind: "local",
      workspaceHost: null,
      workspacePath: null,
      workspaceId: null,
      provider: null,
      model: null,
      backendSessionId: null,
      backendThreadId: null,
    },
  };
}
