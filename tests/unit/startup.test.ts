import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import {
  GitHubMirrorStartupPreparer,
  deriveGitHubMirrorPath,
} from "../../src/startup/github-mirror.js";
import {
  createStartupPreparer,
  deriveStartupFilePath,
  parseStartupSnapshotContent,
  readStartupSnapshot,
  runStartupPreparation,
  type StartupPreparer,
} from "../../src/startup/service.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import { isAbortError } from "../../src/support/abort.js";
import {
  commitAllFiles,
  createSeedRemote,
  createTempDir,
} from "../support/git.js";

const execFile = promisify(execFileCallback);

afterEach(() => {
  process.exitCode = undefined;
});

function createConfig(
  root: string,
  repoUrl: string,
  trackerKind: "github" | "github-bootstrap" = "github-bootstrap",
) {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    tracker: {
      kind: trackerKind,
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.test",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: [],
    },
    polling: {
      intervalMs: 1_000,
      maxConcurrentRuns: 1,
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    workspace: {
      root: path.join(root, ".tmp", "workspaces"),
      repoUrl,
      branchPrefix: "symphony/",
      cleanupOnSuccess: false,
    },
    hooks: {
      afterCreate: [],
    },
    agent: {
      runner: { kind: "codex" as const },
      command: "codex",
      promptTransport: "stdin" as const,
      timeoutMs: 1_000,
      maxTurns: 1,
      env: {},
    },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 1_000,
    },
  };
}

async function readFileAtRef(
  repoPath: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const result = await execFile("git", ["show", `${ref}:${filePath}`], {
    cwd: repoPath,
  });
  return result.stdout;
}

function createIssue(number: number) {
  return {
    id: String(number),
    identifier: `sociotechnica-org/symphony-ts#${number.toString()}`,
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

describe("startup service", () => {
  it("creates a GitHub bootstrap mirror preparer", () => {
    const preparer = createStartupPreparer(
      createConfig("/tmp/repo", "/tmp/repo.git"),
    );
    expect(preparer).toBeInstanceOf(GitHubMirrorStartupPreparer);
    expect(preparer.id).toBe("github-bootstrap/local-mirror");
  });

  it("creates the same mirror preparer for the maintained github tracker", () => {
    const preparer = createStartupPreparer(
      createConfig("/tmp/repo", "/tmp/repo.git", "github"),
    );
    expect(preparer).toBeInstanceOf(GitHubMirrorStartupPreparer);
    expect(preparer.id).toBe("github-bootstrap/local-mirror");
  });

  it("creates a local mirror and writes a ready startup snapshot", async () => {
    const runtimeRoot = await createTempDir("symphony-startup-ready-");
    const remote = await createSeedRemote();
    const config = createConfig(runtimeRoot, remote.remotePath);

    try {
      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        workerPid: 3210,
      });

      expect(outcome.kind).toBe("ready");
      expect(outcome.provider).toBe("github-bootstrap/local-mirror");
      expect(outcome.workspaceRepoUrlOverride).toBe(
        deriveGitHubMirrorPath(config.workspace.root),
      );

      const mirrorResult = await execFile(
        "git",
        ["rev-parse", "--is-bare-repository"],
        { cwd: deriveGitHubMirrorPath(config.workspace.root) },
      );
      expect(mirrorResult.stdout.trim()).toBe("true");

      const snapshot = await readStartupSnapshot(
        deriveStartupFilePath(config.workspace.root),
      );
      expect(snapshot).toMatchObject({
        state: "ready",
        workerPid: 3210,
        provider: "github-bootstrap/local-mirror",
        runtimeIdentity: {
          checkoutPath: runtimeRoot,
        },
      });
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("refreshes an existing mirror and lets the workspace reuse it for newer upstream commits", async () => {
    const runtimeRoot = await createTempDir("symphony-startup-refresh-");
    const remote = await createSeedRemote();
    const config = createConfig(runtimeRoot, remote.remotePath);
    const logger = new JsonLogger();

    try {
      const firstStartup = await runStartupPreparation({
        config,
        logger,
      });
      expect(firstStartup.kind).toBe("ready");
      if (firstStartup.kind !== "ready") {
        throw new Error("expected startup success");
      }

      const workspace = new LocalWorkspaceManager(
        {
          ...config.workspace,
          repoUrl:
            firstStartup.workspaceRepoUrlOverride ?? config.workspace.repoUrl,
        },
        [],
        logger,
      );

      const firstPrepared = await workspace.prepareWorkspace({
        issue: createIssue(88),
      });
      expect(
        await readFileAtRef(firstPrepared.path, "HEAD", "README.md"),
      ).toContain("# mock repo");

      await fs.writeFile(
        path.join(remote.seedPath, "README.md"),
        "# refreshed repo\n",
        "utf8",
      );
      await commitAllFiles(remote.seedPath, "refresh upstream");
      await execFile("git", ["push", "origin", "HEAD"], {
        cwd: remote.seedPath,
      });

      const secondStartup = await runStartupPreparation({
        config,
        logger,
      });
      expect(secondStartup.kind).toBe("ready");

      const secondPrepared = await workspace.prepareWorkspace({
        issue: createIssue(88),
      });
      expect(secondPrepared.createdNow).toBe(false);
      expect(
        await readFileAtRef(secondPrepared.path, "HEAD", "README.md"),
      ).toContain("# refreshed repo");

      const remoteUrl = await execFile(
        "git",
        ["config", "--get", "remote.origin.url"],
        { cwd: secondPrepared.path },
      );
      expect(remoteUrl.stdout.trim()).toBe(
        deriveGitHubMirrorPath(config.workspace.root),
      );
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.rm(remote.rootDir, { recursive: true, force: true });
    }
  });

  it("reports a clear startup failure when mirror setup cannot reach the source", async () => {
    const runtimeRoot = await createTempDir("symphony-startup-mirror-fail-");
    const config = createConfig(
      runtimeRoot,
      path.join(runtimeRoot, "missing", "remote.git"),
    );

    try {
      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        workerPid: 6543,
      });

      expect(outcome.kind).toBe("failed");
      expect(outcome.provider).toBe("github-bootstrap/local-mirror");
      expect(outcome.summary).toContain("GitHub bootstrap mirror setup failed");
      expect(outcome.summary).toContain(config.workspace.repoUrl);
      expect(outcome.summary).toContain(
        deriveGitHubMirrorPath(config.workspace.root),
      );
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("persists an explicit failed startup snapshot when the preparer fails", async () => {
    const tempDir = await createTempDir("symphony-startup-failed-");
    const config = createConfig(tempDir, "/tmp/repo.git");
    const preparer: StartupPreparer = {
      id: "github-bootstrap/test-failure",
      async prepare() {
        return {
          kind: "failed",
          summary: "Mirror refresh failed.",
        };
      },
    };

    try {
      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        preparer,
        workerPid: 6543,
      });

      expect(outcome.kind).toBe("failed");
      const raw = await fs.readFile(
        deriveStartupFilePath(config.workspace.root),
        "utf8",
      );
      expect(parseStartupSnapshotContent(raw, "startup.json")).toMatchObject({
        state: "failed",
        workerPid: 6543,
        provider: "github-bootstrap/test-failure",
        summary: "Mirror refresh failed.",
        runtimeIdentity: {
          checkoutPath: tempDir,
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rethrows AbortError without overwriting the preparing snapshot", async () => {
    const tempDir = await createTempDir("symphony-startup-abort-");
    const config = createConfig(tempDir, "/tmp/repo.git");
    const preparer: StartupPreparer = {
      id: "github-bootstrap/test-abort",
      async prepare() {
        const error = new Error("Startup preparation aborted.");
        error.name = "AbortError";
        throw error;
      },
    };

    try {
      await expect(
        runStartupPreparation({
          config,
          logger: new JsonLogger(),
          preparer,
          workerPid: 9876,
        }),
      ).rejects.toSatisfy((error: unknown) => isAbortError(error));

      const snapshot = await readStartupSnapshot(
        deriveStartupFilePath(config.workspace.root),
      );
      expect(snapshot).toMatchObject({
        state: "preparing",
        workerPid: 9876,
        provider: "github-bootstrap/test-abort",
        runtimeIdentity: {
          checkoutPath: tempDir,
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats empty snapshot summaries as absent", async () => {
    expect(
      parseStartupSnapshotContent(
        JSON.stringify({
          version: 1,
          state: "failed",
          updatedAt: "2026-03-14T12:00:00.000Z",
          workerPid: 6543,
          provider: "github-bootstrap/test-failure",
          summary: "",
        }),
        "startup.json",
      ),
    ).toMatchObject({
      summary: null,
    });
  });
});
