import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { RemoteSshWorkspaceManager } from "../../src/workspace/remote-ssh.js";
import {
  commitAllFiles,
  createSeedRemote,
  createTempDir,
} from "../support/git.js";
import { createFakeSshExecutable } from "../support/fake-ssh.js";

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
    createdAt: "2026-03-19T12:00:00.000Z",
    updatedAt: "2026-03-19T12:00:00.000Z",
  };
}

describe("RemoteSshWorkspaceManager", () => {
  it("prepares and cleans up a remote issue workspace over SSH", async () => {
    const tempDir = await createTempDir("workspace-remote-ssh-");
    const remote = await createSeedRemote();
    const fakeSsh = await createFakeSshExecutable();
    const logger = new JsonLogger();
    const remoteRoot = path.join(tempDir, "remote-root");
    const manager = new RemoteSshWorkspaceManager(
      {
        root: path.join(tempDir, ".tmp", "workspaces"),
        repoUrl: remote.remotePath,
        branchPrefix: "symphony/",
        retention: {
          onSuccess: "retain",
          onFailure: "retain",
        },
      },
      {
        name: "builder",
        sshDestination: "builder@example.test",
        sshExecutable: fakeSsh,
        sshOptions: [],
        workspaceRoot: remoteRoot,
      },
      [],
      logger,
    );

    try {
      const prepared = await manager.prepareWorkspace({
        issue: createIssue(17),
      });
      expect(prepared.target).toEqual({
        kind: "remote",
        host: "builder",
        workspaceId: "builder:repo_17",
        pathHint: path.join(remoteRoot, "repo_17"),
      });
      const currentBranch = await execFile(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        { cwd: path.join(remoteRoot, "repo_17") },
      );
      expect(currentBranch.stdout.trim()).toBe("symphony/17");

      await fs.writeFile(
        path.join(remote.seedPath, "README.md"),
        "# remote ssh update\n",
        "utf8",
      );
      await commitAllFiles(remote.seedPath, "update remote ssh seed");
      await execFile("git", ["push", "origin", "HEAD"], {
        cwd: remote.seedPath,
      });

      await manager.prepareWorkspace({
        issue: createIssue(17),
      });
      const readme = await fs.readFile(
        path.join(remoteRoot, "repo_17", "README.md"),
        "utf8",
      );
      expect(readme).toContain("remote ssh update");

      const cleanup = await manager.cleanupWorkspace(prepared);
      expect(cleanup).toEqual({
        kind: "deleted",
        workspacePath: `builder:${path.join(remoteRoot, "repo_17")}`,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });
});
