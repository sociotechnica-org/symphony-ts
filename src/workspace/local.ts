import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceError } from "../domain/errors.js";
import type {
  PreparedWorkspace,
  WorkspaceSource,
  WorkspaceCleanupResult,
  WorkspacePreparationRequest,
} from "../domain/workspace.js";
import {
  createConfiguredWorkspaceSource,
  getPreparedWorkspacePath,
  getWorkspaceSourceLocation,
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

async function readWorktreeStatus(
  cwd: string,
  options?: {
    readonly includeUntracked?: boolean;
  },
): Promise<readonly string[]> {
  const includeUntracked = options?.includeUntracked ?? true;
  const result = await execFileAsync(
    "git",
    [
      "status",
      "--porcelain",
      includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    ],
    {
      cwd,
    },
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function stashDirtyWorkspaceForReuse(cwd: string): Promise<{
  readonly stashed: boolean;
  readonly entryName: string | null;
  readonly changedPaths: readonly string[];
}> {
  const statusLines = await readWorktreeStatus(cwd, {
    includeUntracked: true,
  });
  if (statusLines.length === 0) {
    return {
      stashed: false,
      entryName: null,
      changedPaths: [],
    };
  }

  const entryName = `symphony-retained-workspace-${new Date().toISOString()}`;
  await execFileAsync(
    "git",
    ["stash", "push", "--include-untracked", "--message", entryName],
    { cwd },
  );
  return {
    stashed: true,
    entryName,
    changedPaths: statusLines.map((line) => line.slice(3)),
  };
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

async function configureOriginRemote(
  cwd: string,
  source: WorkspaceSource,
  configuredRepoUrl: string,
): Promise<void> {
  if (source.kind !== "local-path") {
    return;
  }

  if (source.path === configuredRepoUrl) {
    return;
  }

  await execFileAsync(
    "git",
    ["remote", "set-url", "origin", configuredRepoUrl],
    {
      cwd,
    },
  );
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
  readonly #sourceOverride: WorkspaceSource | null;

  constructor(
    config: WorkspaceConfig,
    afterCreate: readonly string[],
    logger: Logger,
    sourceOverride?: WorkspaceSource | null,
  ) {
    this.#config = config;
    this.#afterCreate = afterCreate;
    this.#logger = logger;
    this.#sourceOverride = sourceOverride ?? null;
  }

  async prepareWorkspace(
    request: WorkspacePreparationRequest,
  ): Promise<PreparedWorkspace> {
    const issue = request.issue;
    const workspacePath = this.#workspacePathForIssue(issue.identifier);
    const branchName = `${this.#config.branchPrefix}${issue.number}`;
    const source =
      request.sourceOverride ??
      this.#sourceOverride ??
      createConfiguredWorkspaceSource(this.#config.repoUrl);
    const sourceLocation = getWorkspaceSourceLocation(source);
    const exists = await fs
      .stat(workspacePath)
      .then(() => true)
      .catch(() => false);

    await fs.mkdir(this.#config.root, { recursive: true });

    if (!exists) {
      await execFileAsync("git", ["clone", sourceLocation, workspacePath]);
      await configureOriginRemote(workspacePath, source, this.#config.repoUrl);
      for (const command of this.#afterCreate) {
        await runShell(command, workspacePath);
      }
    } else {
      await configureOriginRemote(workspacePath, source, this.#config.repoUrl);
      const sanitized = await stashDirtyWorkspaceForReuse(workspacePath);
      if (sanitized.stashed) {
        this.#logger.warn("Sanitized dirty retained workspace before reuse", {
          workspacePath,
          issueIdentifier: issue.identifier,
          branchName,
          stashEntryName: sanitized.entryName,
          changedPaths: sanitized.changedPaths,
        });
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
      workspaceSourceKind: source.kind,
      workspaceSourceLocation: sourceLocation,
      defaultBranch,
      createdNow: !exists,
    });

    return {
      key: sanitize(issue.identifier),
      branchName,
      createdNow: !exists,
      source,
      target: {
        kind: "local",
        path: workspacePath,
      },
    };
  }

  async cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<WorkspaceCleanupResult> {
    const workspacePath = getPreparedWorkspacePath(workspace);
    if (workspacePath === null) {
      throw new WorkspaceError(
        "Local workspace cleanup requires a local workspace target",
      );
    }
    const existed = await fs
      .stat(workspacePath)
      .then(() => true)
      .catch(() => false);
    this.#logger.info("Cleaning workspace", {
      workspacePath,
      existed,
    });
    await fs.rm(workspacePath, { recursive: true, force: true });
    return {
      kind: existed ? "deleted" : "already-absent",
      workspacePath,
    };
  }

  async cleanupWorkspaceForIssue(
    request: WorkspacePreparationRequest,
  ): Promise<WorkspaceCleanupResult> {
    return await this.cleanupWorkspace({
      key: sanitize(request.issue.identifier),
      branchName: `${this.#config.branchPrefix}${request.issue.number}`,
      createdNow: false,
      source:
        request.sourceOverride ??
        this.#sourceOverride ??
        createConfiguredWorkspaceSource(this.#config.repoUrl),
      target: {
        kind: "local",
        path: this.#workspacePathForIssue(request.issue.identifier),
      },
    });
  }

  #workspacePathForIssue(issueIdentifier: string): string {
    return path.join(this.#config.root, sanitize(issueIdentifier));
  }
}
