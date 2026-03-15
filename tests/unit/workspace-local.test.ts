import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "../../src/domain/errors.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import {
  commitAllFiles,
  createSeedRemote,
  createTempDir,
} from "../support/git.js";

const execFile = promisify(execFileCallback);

function createIssue(number: number) {
  return {
    id: String(number),
    identifier: `repo#${number.toString()}`,
    number,
    title: `Issue ${number.toString()}`,
    description: "desc",
    labels: [],
    state: "open" as const,
    url: `https://example.test/issues/${number.toString()}`,
    createdAt: "2026-03-14T12:00:00.000Z",
    updatedAt: "2026-03-14T12:00:00.000Z",
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("LocalWorkspaceManager", () => {
  it("resets reused workspaces against the remote default branch from origin/HEAD", async () => {
    const tempDir = await createTempDir("workspace-master-");
    const remote = await createSeedRemote({ branch: "master" });
    const logger = new JsonLogger();
    const manager = new LocalWorkspaceManager(
      {
        root: path.join(tempDir, ".tmp", "workspaces"),
        repoUrl: remote.remotePath,
        branchPrefix: "symphony/",
        cleanupOnSuccess: false,
      },
      [],
      logger,
    );

    try {
      const firstPrepared = await manager.prepareWorkspace({
        issue: createIssue(7),
      });
      const firstHead = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: firstPrepared.path,
      });

      await fs.writeFile(
        path.join(remote.seedPath, "README.md"),
        "# master update\n",
        "utf8",
      );
      await commitAllFiles(remote.seedPath, "update master");
      await execFile("git", ["push", "origin", "HEAD"], {
        cwd: remote.seedPath,
      });

      const secondPrepared = await manager.prepareWorkspace({
        issue: createIssue(7),
      });
      const secondHead = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: secondPrepared.path,
      });
      const currentBranch = await execFile(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        { cwd: secondPrepared.path },
      );

      expect(firstHead.stdout.trim()).not.toBe(secondHead.stdout.trim());
      expect(secondPrepared.createdNow).toBe(false);
      expect(currentBranch.stdout.trim()).toBe("symphony/7");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the source remote has no resolvable default branch", async () => {
    const tempDir = await createTempDir("workspace-no-default-");
    const remotePath = path.join(tempDir, "remote.git");
    const logger = new JsonLogger();

    await execFile("git", ["init", "--bare", remotePath]);

    const manager = new LocalWorkspaceManager(
      {
        root: path.join(tempDir, ".tmp", "workspaces"),
        repoUrl: remotePath,
        branchPrefix: "symphony/",
        cleanupOnSuccess: false,
      },
      [],
      logger,
    );

    try {
      let thrown: unknown;
      try {
        await manager.prepareWorkspace({
          issue: createIssue(8),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(WorkspaceError);
      expect((thrown as Error).message).toMatch(
        /Could not resolve the default branch/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
