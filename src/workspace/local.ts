import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceError } from "../domain/errors.js";
import type {
  IssueRef,
  WorkspaceConfig,
  WorkspaceInfo,
} from "../domain/types.js";
import type { Logger } from "../observability/logger.js";
import type { WorkspaceManager } from "./service.js";

const execFileAsync = promisify(execFile);

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function runShell(command: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("bash", ["-lc", command], { cwd });
  } catch (error) {
    throw new WorkspaceError(`Command failed in workspace: ${command}`, {
      cause: error as Error,
    });
  }
}

async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  const result = await execFileAsync("git", ["branch", "--list", branchName], {
    cwd,
  });
  return result.stdout.trim() !== "";
}

async function remoteTrackingBranchExists(
  cwd: string,
  branchName: string,
): Promise<boolean> {
  const result = await execFileAsync(
    "git",
    ["branch", "--remotes", "--list", `origin/${branchName}`],
    { cwd },
  );
  return result.stdout.trim() !== "";
}

export class LocalWorkspaceManager implements WorkspaceManager {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async ensureWorkspace(
    issue: IssueRef,
    config: WorkspaceConfig,
    afterCreate: readonly string[],
  ): Promise<WorkspaceInfo> {
    const workspaceKey = sanitize(issue.identifier);
    const workspacePath = path.join(config.root, workspaceKey);
    const branchName = `${config.branchPrefix}${issue.number}`;
    const exists = await fs
      .stat(workspacePath)
      .then(() => true)
      .catch(() => false);

    await fs.mkdir(config.root, { recursive: true });

    if (!exists) {
      await execFileAsync("git", ["clone", config.repoUrl, workspacePath]);
      for (const command of afterCreate) {
        await runShell(command, workspacePath);
      }
    }

    await execFileAsync("git", ["fetch", "origin"], { cwd: workspacePath });
    const hasBranch = await branchExists(workspacePath, branchName);
    const hasRemoteTrackingBranch = await remoteTrackingBranchExists(
      workspacePath,
      branchName,
    );

    if (hasBranch && hasRemoteTrackingBranch) {
      this.#logger.info("Deleting existing remote issue branch", {
        workspacePath,
        branchName,
        issueIdentifier: issue.identifier,
      });
      await execFileAsync("git", ["push", "origin", "--delete", branchName], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["fetch", "origin", "--prune"], {
        cwd: workspacePath,
      });
    }

    await execFileAsync("git", ["checkout", "main"], { cwd: workspacePath });
    await execFileAsync("git", ["reset", "--hard", "origin/main"], {
      cwd: workspacePath,
    });

    if (hasBranch) {
      await execFileAsync("git", ["checkout", branchName], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["reset", "--hard", "origin/main"], {
        cwd: workspacePath,
      });
    } else {
      await execFileAsync("git", ["checkout", "-b", branchName], {
        cwd: workspacePath,
      });
    }

    this.#logger.info("Workspace ready", {
      workspacePath,
      issueIdentifier: issue.identifier,
      branchName,
      createdNow: !exists,
    });

    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      path: workspacePath,
      branchName,
      createdNow: !exists,
    };
  }

  async cleanupWorkspace(workspace: WorkspaceInfo): Promise<void> {
    this.#logger.info("Cleaning workspace", { workspacePath: workspace.path });
    await fs.rm(workspace.path, { recursive: true, force: true });
  }
}
