import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const STALE_COORDINATION_RETRY_DELAY_MS = 100;

export type CoordinationArtifactState = "absent" | "held-live" | "held-stale";

export interface CoordinationOwnerRecord {
  readonly pid: number | null;
  readonly values: Readonly<Record<string, string>>;
}

export interface CoordinationArtifactInspection {
  readonly state: CoordinationArtifactState;
  readonly owner: CoordinationOwnerRecord | null;
}

export interface OwnedCoordinationArtifact {
  readonly lockDir: string;
  readonly ownerFile: string;
  readonly ownerPid: number;
}

export async function inspectCoordinationArtifact(args: {
  readonly lockDir: string;
  readonly ownerFile: string;
}): Promise<CoordinationArtifactInspection> {
  try {
    await fs.access(args.lockDir);
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT") {
      return {
        state: "absent",
        owner: null,
      };
    }
    throw error;
  }

  const owner = await readCoordinationOwner(args.ownerFile);
  if (owner === null || !pidIsLive(owner.pid)) {
    return {
      state: "held-stale",
      owner,
    };
  }

  return {
    state: "held-live",
    owner,
  };
}

export async function rejectLaunchDuringActiveWakeUpLease(args: {
  readonly lockDir: string;
  readonly ownerFile: string;
  readonly requestedInstanceKey: string;
  readonly requestedWorkflowPath: string | null;
  readonly reporter: (message: string) => void;
}): Promise<void> {
  while (true) {
    const inspection = await inspectCoordinationArtifact(args);
    if (inspection.state === "absent") {
      return;
    }
    if (inspection.state === "held-stale") {
      args.reporter(
        `operator-loop: clearing stale active wake-up lease for pid ${renderPid(
          inspection.owner?.pid,
        )}`,
      );
      await clearCoordinationArtifact(args.lockDir);
      await delay(STALE_COORDINATION_RETRY_DELAY_MS);
      continue;
    }

    const owner = inspection.owner;
    let message =
      "operator-loop: operator loop launch rejected while another wake-up cycle is active for this instance; " +
      `reason=live-active-wake-up-lease; owner_pid=${renderPid(owner?.pid)}`;
    const ownerRepoRoot = owner?.values["operator_repo_root"];
    if (ownerRepoRoot) {
      message = `${message}; owner_repo_root=${ownerRepoRoot}`;
    }
    const ownerInstanceRoot = owner?.values["selected_instance_root"];
    if (ownerInstanceRoot) {
      message = `${message}; owner_selected_instance_root=${ownerInstanceRoot}`;
    }
    const ownerWorkflow = owner?.values["workflow_path"];
    if (ownerWorkflow) {
      message = `${message}; owner_workflow=${ownerWorkflow}`;
    }
    message = `${message}; requested_instance=${args.requestedInstanceKey}`;
    if (args.requestedWorkflowPath !== null) {
      message = `${message}; requested_workflow=${args.requestedWorkflowPath}`;
    }

    throw new Error(message);
  }
}

export async function acquireLoopLock(args: {
  readonly lockDir: string;
  readonly ownerFile: string;
  readonly ownerPid: number;
  readonly repoRoot: string;
  readonly startedAt: string;
  readonly reporter: (message: string) => void;
}): Promise<OwnedCoordinationArtifact> {
  while (true) {
    try {
      await fs.mkdir(args.lockDir);
      await writeCoordinationOwner(args.ownerFile, {
        pid: args.ownerPid.toString(),
        started_at: args.startedAt,
        repo_root: args.repoRoot,
      });
      return {
        lockDir: args.lockDir,
        ownerFile: args.ownerFile,
        ownerPid: args.ownerPid,
      };
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code !== "EEXIST") {
        throw error;
      }
    }

    const inspection = await inspectCoordinationArtifact(args);
    if (inspection.state === "held-live") {
      throw new Error(
        `operator-loop: another loop is already running with pid ${renderPid(
          inspection.owner?.pid,
        )}`,
      );
    }

    args.reporter(
      `operator-loop: clearing stale lock for pid ${renderPid(
        inspection.owner?.pid,
      )}`,
    );
    await clearCoordinationArtifact(args.lockDir);
    await delay(STALE_COORDINATION_RETRY_DELAY_MS);
  }
}

export async function acquireActiveWakeUpLease(args: {
  readonly coordinationRoot: string;
  readonly lockDir: string;
  readonly ownerFile: string;
  readonly ownerPid: number;
  readonly selectedInstanceRoot: string;
  readonly operatorRepoRoot: string;
  readonly workflowPath: string;
  readonly instanceKey: string;
  readonly startedAt: string;
  readonly reporter: (message: string) => void;
}): Promise<
  | {
      readonly ok: true;
      readonly artifact: OwnedCoordinationArtifact;
    }
  | {
      readonly ok: false;
    }
> {
  await fs.mkdir(args.coordinationRoot, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(args.lockDir);
      await writeCoordinationOwner(args.ownerFile, {
        pid: args.ownerPid.toString(),
        started_at: args.startedAt,
        selected_instance_root: args.selectedInstanceRoot,
        operator_repo_root: args.operatorRepoRoot,
        workflow_path: args.workflowPath,
        instance_key: args.instanceKey,
      });
      return {
        ok: true,
        artifact: {
          lockDir: args.lockDir,
          ownerFile: args.ownerFile,
          ownerPid: args.ownerPid,
        },
      };
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code !== "EEXIST") {
        throw error;
      }
    }

    const inspection = await inspectCoordinationArtifact(args);
    if (inspection.state === "absent") {
      await delay(STALE_COORDINATION_RETRY_DELAY_MS);
      continue;
    }
    if (inspection.state === "held-stale") {
      args.reporter(
        `operator-loop: clearing stale active wake-up lease for pid ${renderPid(
          inspection.owner?.pid,
        )}`,
      );
      await clearCoordinationArtifact(args.lockDir);
      await delay(STALE_COORDINATION_RETRY_DELAY_MS);
      continue;
    }

    const owner = inspection.owner;
    args.reporter(
      "operator-loop: active wake-up lease already held for this instance; " +
        `owner_pid=${renderPid(owner?.pid)}; ` +
        `owner_repo_root=${owner?.values["operator_repo_root"] ?? "unknown"}; ` +
        "owner_selected_instance_root=" +
        `${owner?.values["selected_instance_root"] ?? "unknown"}; ` +
        `owner_workflow=${owner?.values["workflow_path"] ?? "unknown"}`,
    );
    return {
      ok: false,
    };
  }
}

export async function releaseOwnedCoordinationArtifact(
  artifact: OwnedCoordinationArtifact | null,
): Promise<void> {
  if (artifact === null) {
    return;
  }

  const inspection = await inspectCoordinationArtifact(artifact);
  if (inspection.state === "absent") {
    return;
  }
  if (inspection.owner?.pid !== artifact.ownerPid) {
    return;
  }

  await clearCoordinationArtifact(artifact.lockDir);
}

async function readCoordinationOwner(
  filePath: string,
): Promise<CoordinationOwnerRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const values: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/u)) {
      if (line.length === 0) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator === -1) {
        continue;
      }
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }

    return {
      pid: parsePid(values["pid"]),
      values,
    };
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCoordinationOwner(
  filePath: string,
  values: Record<string, string>,
): Promise<void> {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function clearCoordinationArtifact(lockDir: string): Promise<void> {
  await fs.rm(lockDir, { recursive: true, force: true });
}

function parsePid(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function pidIsLive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function renderPid(pid: number | null | undefined): string {
  return pid === null || pid === undefined ? "unknown" : pid.toString();
}
