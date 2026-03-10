import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitMirrorConfig {
  readonly sourceUrl: string;
  readonly branch: string;
  readonly mirrorDir: string;
}

export function defaultMirrorDir(repoRoot: string): string {
  return path.join(repoRoot, "github", "upstream");
}

export async function resolveGitRemoteUrl(
  repoRoot: string,
  remoteName = "origin",
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["remote", "get-url", remoteName],
    { cwd: repoRoot },
  );
  return result.stdout.trim();
}

export async function syncGitMirror(config: GitMirrorConfig): Promise<void> {
  await fs.mkdir(path.dirname(config.mirrorDir), { recursive: true });

  const exists = await fs
    .stat(config.mirrorDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    await execFileAsync("git", [
      "clone",
      "--branch",
      config.branch,
      "--single-branch",
      config.sourceUrl,
      config.mirrorDir,
    ]);
  } else {
    await execFileAsync("git", ["remote", "set-url", "origin", config.sourceUrl], {
      cwd: config.mirrorDir,
    });
    await execFileAsync("git", ["fetch", "--prune", "origin"], {
      cwd: config.mirrorDir,
    });
    await execFileAsync("git", ["checkout", config.branch], {
      cwd: config.mirrorDir,
    });
    await execFileAsync("git", ["reset", "--hard", `origin/${config.branch}`], {
      cwd: config.mirrorDir,
    });
    await execFileAsync("git", ["clean", "-fdx"], {
      cwd: config.mirrorDir,
    });
  }
}
