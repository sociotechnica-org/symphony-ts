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

async function withScrubbedGitIdentity<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {
    GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"],
    GIT_AUTHOR_EMAIL: process.env["GIT_AUTHOR_EMAIL"],
    GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"],
    GIT_COMMITTER_EMAIL: process.env["GIT_COMMITTER_EMAIL"],
    GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
  };

  delete process.env["GIT_AUTHOR_NAME"];
  delete process.env["GIT_AUTHOR_EMAIL"];
  delete process.env["GIT_COMMITTER_NAME"];
  delete process.env["GIT_COMMITTER_EMAIL"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";

  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function listStashEntries(cwd: string): Promise<readonly string[]> {
  const result = await execFile("git", ["stash", "list"], { cwd });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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
  it("restores scrubbed git identity env vars by their original names", async () => {
    process.env["GIT_AUTHOR_NAME"] = "author";
    process.env["GIT_AUTHOR_EMAIL"] = "author@example.com";
    process.env["GIT_COMMITTER_NAME"] = "committer";
    process.env["GIT_COMMITTER_EMAIL"] = "committer@example.com";
    process.env["GIT_CONFIG_GLOBAL"] = "/tmp/original-gitconfig";

    await withScrubbedGitIdentity(async () => {
      expect(process.env["GIT_AUTHOR_NAME"]).toBeUndefined();
      expect(process.env["GIT_AUTHOR_EMAIL"]).toBeUndefined();
      expect(process.env["GIT_COMMITTER_NAME"]).toBeUndefined();
      expect(process.env["GIT_COMMITTER_EMAIL"]).toBeUndefined();
      expect(process.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    });

    expect(process.env["GIT_AUTHOR_NAME"]).toBe("author");
    expect(process.env["GIT_AUTHOR_EMAIL"]).toBe("author@example.com");
    expect(process.env["GIT_COMMITTER_NAME"]).toBe("committer");
    expect(process.env["GIT_COMMITTER_EMAIL"]).toBe("committer@example.com");
    expect(process.env["GIT_CONFIG_GLOBAL"]).toBe("/tmp/original-gitconfig");
  });

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
      await withScrubbedGitIdentity(async () => {
        await commitAllFiles(workspacePath, "bootstrap push");
        await execFile("git", ["push", "origin", "HEAD:symphony/10"], {
          cwd: workspacePath,
        });
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

  it("stashes dirty retained workspaces before resetting them for reuse", async () => {
    const tempDir = await createTempDir("workspace-retained-dirty-");
    const remote = await createSeedRemote();
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
      const prepared = await manager.prepareWorkspace({
        issue: createIssue(11),
      });
      const workspacePath = getPreparedWorkspacePath(prepared);
      if (workspacePath === null) {
        throw new Error("expected local workspace path");
      }

      await fs.writeFile(
        path.join(workspacePath, "README.md"),
        "# locally modified for retry\n",
        "utf8",
      );

      const reused = await manager.prepareWorkspace({
        issue: createIssue(11),
      });
      const reusedWorkspacePath = getPreparedWorkspacePath(reused);
      if (reusedWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }

      expect(reused.createdNow).toBe(false);
      await expect(
        fs.readFile(path.join(reusedWorkspacePath, "README.md"), "utf8"),
      ).resolves.toContain("# mock repo");

      const stashEntries = await listStashEntries(reusedWorkspacePath);
      expect(stashEntries).toHaveLength(1);
      expect(stashEntries[0]).toContain("symphony-retained-workspace-");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("recovers from conflicting untracked files in retained workspaces", async () => {
    const tempDir = await createTempDir("workspace-retained-untracked-");
    const remote = await createSeedRemote();
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
      const prepared = await manager.prepareWorkspace({
        issue: createIssue(12),
      });
      const workspacePath = getPreparedWorkspacePath(prepared);
      if (workspacePath === null) {
        throw new Error("expected local workspace path");
      }

      await fs.writeFile(
        path.join(workspacePath, "GENERATED.txt"),
        "untracked artifact from failed run\n",
        "utf8",
      );

      const reused = await manager.prepareWorkspace({
        issue: createIssue(12),
      });
      const reusedWorkspacePath = getPreparedWorkspacePath(reused);
      if (reusedWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }

      expect(reused.createdNow).toBe(false);
      const untrackedExists = await fs
        .stat(path.join(reusedWorkspacePath, "GENERATED.txt"))
        .then(() => true)
        .catch(() => false);
      expect(untrackedExists).toBe(false);

      const stashEntries = await listStashEntries(reusedWorkspacePath);
      expect(stashEntries).toHaveLength(1);
      expect(stashEntries[0]).toContain("symphony-retained-workspace-");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("stashes both tracked modifications and untracked files together", async () => {
    const tempDir = await createTempDir("workspace-retained-mixed-");
    const remote = await createSeedRemote();
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
      const prepared = await manager.prepareWorkspace({
        issue: createIssue(13),
      });
      const workspacePath = getPreparedWorkspacePath(prepared);
      if (workspacePath === null) {
        throw new Error("expected local workspace path");
      }

      await fs.writeFile(
        path.join(workspacePath, "README.md"),
        "# tracked modification\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspacePath, "NEW_FILE.txt"),
        "untracked new file\n",
        "utf8",
      );

      const reused = await manager.prepareWorkspace({
        issue: createIssue(13),
      });
      const reusedWorkspacePath = getPreparedWorkspacePath(reused);
      if (reusedWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }

      expect(reused.createdNow).toBe(false);
      await expect(
        fs.readFile(path.join(reusedWorkspacePath, "README.md"), "utf8"),
      ).resolves.toContain("# mock repo");
      const newFileExists = await fs
        .stat(path.join(reusedWorkspacePath, "NEW_FILE.txt"))
        .then(() => true)
        .catch(() => false);
      expect(newFileExists).toBe(false);

      const stashEntries = await listStashEntries(reusedWorkspacePath);
      expect(stashEntries).toHaveLength(1);
      expect(stashEntries[0]).toContain("symphony-retained-workspace-");
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
