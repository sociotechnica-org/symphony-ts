import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { LocalPathWorkspaceSource } from "../domain/workspace.js";
import type { ResolvedConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { StartupPreparationResult, StartupPreparer } from "./service.js";

const execFile = promisify(execFileCallback);

function formatExecError(error: unknown): string {
  const err = error as NodeJS.ErrnoException & {
    readonly stderr?: string;
    readonly stdout?: string;
  };
  const details = [err.stderr, err.stdout, err.message]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value.length > 0);
  return details ?? "git command failed";
}

async function execGit(
  args: readonly string[],
  options: {
    readonly cwd?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFile("git", [...args], {
    cwd: options.cwd,
    signal: options.signal,
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureBareMirror(
  mirrorPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await execGit(["rev-parse", "--is-bare-repository"], {
    cwd: mirrorPath,
    signal,
  });
  if (result.stdout.trim() !== "true") {
    throw new Error(`${mirrorPath} is not a bare git repository.`);
  }
}

async function resolveSourceDefaultBranch(
  sourceRepoUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execGit(
    ["ls-remote", "--symref", sourceRepoUrl, "HEAD"],
    {
      signal,
    },
  );
  const match = result.stdout.match(/^ref:\s+refs\/heads\/([^\t\n]+)\tHEAD$/m);
  if (match?.[1] === undefined || match[1].trim() === "") {
    throw new Error(
      `Could not resolve the source default branch from HEAD for ${sourceRepoUrl}.`,
    );
  }
  return match[1].trim();
}

export function deriveGitHubMirrorPath(workspaceRoot: string): string {
  return path.join(path.dirname(workspaceRoot), "github", "upstream");
}

function createMirrorWorkspaceSource(mirrorPath: string): LocalPathWorkspaceSource {
  return {
    kind: "local-path",
    path: mirrorPath,
  };
}

export class GitHubMirrorStartupPreparer implements StartupPreparer {
  readonly id = "github-bootstrap/local-mirror";

  async prepare(context: {
    readonly config: ResolvedConfig;
    readonly logger: Logger;
    readonly signal?: AbortSignal | undefined;
  }): Promise<StartupPreparationResult> {
    const sourceRepoUrl = context.config.workspace.repoUrl;
    const mirrorPath = deriveGitHubMirrorPath(context.config.workspace.root);
    const mirrorParent = path.dirname(mirrorPath);

    try {
      const defaultBranch = await resolveSourceDefaultBranch(
        sourceRepoUrl,
        context.signal,
      );
      const exists = await pathExists(mirrorPath);

      await fs.mkdir(mirrorParent, { recursive: true });

      if (!exists) {
        context.logger.info("Creating GitHub bootstrap mirror", {
          sourceRepoUrl,
          mirrorPath,
          defaultBranch,
        });
        await execGit(["clone", "--mirror", sourceRepoUrl, mirrorPath], {
          signal: context.signal,
        });
      } else {
        await ensureBareMirror(mirrorPath, context.signal);
        context.logger.info("Refreshing GitHub bootstrap mirror", {
          sourceRepoUrl,
          mirrorPath,
          defaultBranch,
        });
        await execGit(["remote", "set-url", "origin", sourceRepoUrl], {
          cwd: mirrorPath,
          signal: context.signal,
        });
        await execGit(["remote", "update", "--prune", "origin"], {
          cwd: mirrorPath,
          signal: context.signal,
        });
      }

      await execGit(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], {
        cwd: mirrorPath,
        signal: context.signal,
      });

      const action = exists ? "refreshed" : "created";
      context.logger.info("GitHub bootstrap mirror ready", {
        sourceRepoUrl,
        mirrorPath,
        defaultBranch,
        action,
      });
      return {
        kind: "ready",
        summary: `GitHub bootstrap mirror ${action} at ${mirrorPath}.`,
        workspaceSourceOverride: createMirrorWorkspaceSource(mirrorPath),
      };
    } catch (error) {
      const summary = `GitHub bootstrap mirror setup failed for source ${sourceRepoUrl} at ${mirrorPath}: ${formatExecError(
        error,
      )}`;
      context.logger.error("GitHub bootstrap mirror setup failed", {
        sourceRepoUrl,
        mirrorPath,
        error: formatExecError(error),
      });
      return {
        kind: "failed",
        summary,
      };
    }
  }
}
