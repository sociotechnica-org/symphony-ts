import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceError } from "../domain/errors.js";
import type {
  PreparedWorkspace,
  WorkspaceCleanupResult,
  WorkspacePreparationRequest,
} from "../domain/workspace.js";
import type { WorkspaceConfig } from "../domain/workflow.js";
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

async function branchAheadCount(
  cwd: string,
  baseRef: string,
  branchName: string,
): Promise<number> {
  const result = await execFileAsync(
    "git",
    ["rev-list", "--count", `${baseRef}..${branchName}`],
    { cwd },
  );
  return Number(result.stdout.trim() || "0");
}

async function syncOriginHead(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["remote", "set-head", "origin", "--auto"], {
      cwd,
    });
  } catch {
    // Some remotes do not advertise HEAD; default-branch resolution handles
    // the explicit fallback/error path after fetch.
  }
}

async function remoteRefExists(cwd: string, refName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", refName], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultBranch(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd },
    );
    const branchRef = result.stdout.trim();
    if (branchRef.startsWith("origin/")) {
      return branchRef.slice("origin/".length);
    }
  } catch {
    // Fall through to explicit fallback refs below.
  }

  for (const branchName of ["main", "master"]) {
    if (await remoteRefExists(cwd, `refs/remotes/origin/${branchName}`)) {
      return branchName;
    }
  }

  throw new WorkspaceError(
    `Could not resolve the default branch for origin in ${cwd}. Expected refs/remotes/origin/HEAD or a known fallback branch.`,
  );
}

export class LocalWorkspaceManager implements WorkspaceManager {
  readonly #config: WorkspaceConfig;
  readonly #afterCreate: readonly string[];
  readonly #logger: Logger;

  constructor(
    config: WorkspaceConfig,
    afterCreate: readonly string[],
    logger: Logger,
  ) {
    this.#config = config;
    this.#afterCreate = afterCreate;
    this.#logger = logger;
  }

  async prepareWorkspace(
    request: WorkspacePreparationRequest,
  ): Promise<PreparedWorkspace> {
    const issue = request.issue;
    const workspacePath = this.#workspacePathForIssue(issue.identifier);
    const branchName = `${this.#config.branchPrefix}${issue.number}`;
    const exists = await fs
      .stat(workspacePath)
      .then(() => true)
      .catch(() => false);

    await fs.mkdir(this.#config.root, { recursive: true });

    if (!exists) {
      await execFileAsync("git", [
        "clone",
        this.#config.repoUrl,
        workspacePath,
      ]);
      for (const command of this.#afterCreate) {
        await runShell(command, workspacePath);
      }
    }

    await execFileAsync("git", ["fetch", "origin"], { cwd: workspacePath });
    await syncOriginHead(workspacePath);
    const defaultBranch = await resolveDefaultBranch(workspacePath);
    const defaultBranchRef = `origin/${defaultBranch}`;
    const hasBranch = await branchExists(workspacePath, branchName);
    const hasRemoteTrackingBranch = await remoteTrackingBranchExists(
      workspacePath,
      branchName,
    );

    if (hasRemoteTrackingBranch) {
      await execFileAsync("git", ["checkout", "-B", branchName], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["reset", "--hard", `origin/${branchName}`], {
        cwd: workspacePath,
      });
    } else {
      await execFileAsync(
        "git",
        ["checkout", "-B", defaultBranch, defaultBranchRef],
        {
          cwd: workspacePath,
        },
      );
      await execFileAsync("git", ["reset", "--hard", defaultBranchRef], {
        cwd: workspacePath,
      });

      if (hasBranch) {
        const aheadCount = await branchAheadCount(
          workspacePath,
          defaultBranchRef,
          branchName,
        );
        if (aheadCount > 0) {
          this.#logger.warn("Discarding local-only branch commits", {
            workspacePath,
            branchName,
            aheadCount,
          });
        }
        await execFileAsync("git", ["checkout", branchName], {
          cwd: workspacePath,
        });
        await execFileAsync("git", ["reset", "--hard", defaultBranchRef], {
          cwd: workspacePath,
        });
      } else {
        await execFileAsync("git", ["checkout", "-b", branchName], {
          cwd: workspacePath,
        });
      }
    }

    this.#logger.info("Workspace ready", {
      workspacePath,
      issueIdentifier: issue.identifier,
      branchName,
      repoUrl: this.#config.repoUrl,
      defaultBranch,
      createdNow: !exists,
    });

    return {
      key: sanitize(issue.identifier),
      path: workspacePath,
      branchName,
      createdNow: !exists,
    };
  }

  async cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<WorkspaceCleanupResult> {
    const existed = await fs
      .stat(workspace.path)
      .then(() => true)
      .catch(() => false);
    this.#logger.info("Cleaning workspace", {
      workspacePath: workspace.path,
      existed,
    });
    await fs.rm(workspace.path, { recursive: true, force: true });
    return {
      kind: existed ? "deleted" : "already-absent",
      workspacePath: workspace.path,
    };
  }

  async cleanupWorkspaceForIssue(
    request: WorkspacePreparationRequest,
  ): Promise<WorkspaceCleanupResult> {
    return await this.cleanupWorkspace({
      key: sanitize(request.issue.identifier),
      path: this.#workspacePathForIssue(request.issue.identifier),
      branchName: `${this.#config.branchPrefix}${request.issue.number}`,
      createdNow: false,
    });
  }

  #workspacePathForIssue(issueIdentifier: string): string {
    return path.join(this.#config.root, sanitize(issueIdentifier));
  }
}
