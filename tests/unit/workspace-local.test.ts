import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "../../src/domain/errors.js";
import { getPreparedWorkspacePath } from "../../src/domain/workspace.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import {
  commitAllFiles,
  createSeedRemote,
  createTempDir,
  readRemoteBranchFile,
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
    queuePriority: null,
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
        retention: {
          onSuccess: "retain",
          onFailure: "retain",
        },
      },
      [],
      logger,
    );

    try {
      const firstPrepared = await manager.prepareWorkspace({
        issue: createIssue(7),
      });
      const firstWorkspacePath = getPreparedWorkspacePath(firstPrepared);
      if (firstWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }
      const firstHead = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: firstWorkspacePath,
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
      const secondWorkspacePath = getPreparedWorkspacePath(secondPrepared);
      if (secondWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }
      const secondHead = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: secondWorkspacePath,
      });
      const currentBranch = await execFile(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        { cwd: secondWorkspacePath },
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
        retention: {
          onSuccess: "retain",
          onFailure: "retain",
        },
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

  it("repoints bootstrap mirror workspaces at the configured upstream before pushing", async () => {
    const tempDir = await createTempDir("workspace-bootstrap-push-");
    const remote = await createSeedRemote();
    const mirrorPath = path.join(tempDir, "mirror.git");
    const logger = new JsonLogger();

    await execFile("git", ["clone", "--mirror", remote.remotePath, mirrorPath]);

    const manager = new LocalWorkspaceManager(
      {
        root: path.join(tempDir, ".tmp", "workspaces"),
        repoUrl: remote.remotePath,
        branchPrefix: "symphony/",
        retention: {
          onSuccess: "retain",
          onFailure: "retain",
        },
      },
      [],
      logger,
      {
        kind: "local-path",
        path: mirrorPath,
      },
    );

    try {
      const prepared = await manager.prepareWorkspace({
        issue: createIssue(10),
      });
      const workspacePath = getPreparedWorkspacePath(prepared);
      if (workspacePath === null) {
        throw new Error("expected local workspace path");
      }

      const remoteUrl = await execFile("git", ["remote", "get-url", "origin"], {
        cwd: workspacePath,
      });
      expect(remoteUrl.stdout.trim()).toBe(remote.remotePath);

      await fs.writeFile(
        path.join(workspacePath, "IMPLEMENTED.txt"),
        "bootstrap push path\n",
        "utf8",
      );
      await commitAllFiles(workspacePath, "bootstrap push");
      await execFile("git", ["push", "origin", "HEAD:symphony/10"], {
        cwd: workspacePath,
      });

      await expect(
        readRemoteBranchFile(
          remote.remotePath,
          "symphony/10",
          "IMPLEMENTED.txt",
        ),
      ).resolves.toContain("bootstrap push path");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("returns an idempotent cleanup result when the workspace is already absent", async () => {
    const tempDir = await createTempDir("workspace-cleanup-");
    const remote = await createSeedRemote();
    const logger = new JsonLogger();
    const manager = new LocalWorkspaceManager(
      {
        root: path.join(tempDir, ".tmp", "workspaces"),
        repoUrl: remote.remotePath,
        branchPrefix: "symphony/",
        retention: {
          onSuccess: "delete",
          onFailure: "retain",
        },
      },
      [],
      logger,
    );

    try {
      const result = await manager.cleanupWorkspaceForIssue({
        issue: createIssue(9),
      });

      expect(result).toEqual({
        kind: "already-absent",
        workspacePath: path.join(tempDir, ".tmp", "workspaces", "repo_9"),
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });
});
