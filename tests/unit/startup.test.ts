import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getPreparedWorkspacePath } from "../../src/domain/workspace.js";
import {
  deriveRuntimeInstancePaths,
  type ResolvedConfig,
} from "../../src/domain/workflow.js";
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
): ResolvedConfig {
  const workflowPath = path.join(root, "WORKFLOW.md");
  const workspaceRoot = path.join(root, ".tmp", "workspaces");
  return {
    workflowPath,
    instance: deriveRuntimeInstancePaths({
      workflowPath,
      workspaceRoot,
    }),
    tracker: {
      kind: trackerKind,
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.test",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      respectBlockedRelationships: false,
      successComment: "done",
      reviewBotLogins: [],
    },
    polling: {
      intervalMs: 1_000,
      maxConcurrentRuns: 1,
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    workspace: {
      root: workspaceRoot,
      repoUrl,
      branchPrefix: "symphony/",
      retention: {
        onSuccess: "retain",
        onFailure: "retain",
      },
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
      issueReports: {
        archiveRoot: null,
      },
    },
  };
}

async function writeWorkflowContract(workflowPath: string): Promise<void> {
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  await fs.writeFile(
    workflowPath,
    [
      "---",
      "tracker:",
      "  kind: github-bootstrap",
      "  repo: sociotechnica-org/symphony-ts",
      "---",
      "",
      "# test workflow",
      "",
    ].join("\n"),
    "utf8",
  );
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
    queuePriority: null,
    blockedBy: [],
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
      await writeWorkflowContract(config.workflowPath);

      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        workerPid: 3210,
      });

      expect(outcome.kind).toBe("ready");
      expect(outcome.provider).toBe("github-bootstrap/local-mirror");
      expect(outcome.workspaceSourceOverride).toEqual({
        kind: "local-path",
        path: deriveGitHubMirrorPath(config.instance),
      });

      const mirrorResult = await execFile(
        "git",
        ["rev-parse", "--is-bare-repository"],
        { cwd: deriveGitHubMirrorPath(config.instance) },
      );
      expect(mirrorResult.stdout.trim()).toBe("true");

      const snapshot = await readStartupSnapshot(
        deriveStartupFilePath(config.instance),
      );
      expect(snapshot).toMatchObject({
        state: "ready",
        workerPid: 3210,
        provider: "github-bootstrap/local-mirror",
        runtimeIdentity: {
          checkoutPath: process.cwd(),
        },
        workflowIdentity: {
          workflowPath: config.workflowPath,
          source: "file",
        },
      });
      expect(snapshot.workflowIdentity?.contentHash).toMatch(/^[0-9a-f]{64}$/);
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
      await writeWorkflowContract(config.workflowPath);

      const firstStartup = await runStartupPreparation({
        config,
        logger,
      });
      expect(firstStartup.kind).toBe("ready");
      if (firstStartup.kind !== "ready") {
        throw new Error("expected startup success");
      }

      const workspace = new LocalWorkspaceManager(
        config.workspace,
        [],
        logger,
        firstStartup.workspaceSourceOverride,
      );

      const firstPrepared = await workspace.prepareWorkspace({
        issue: createIssue(88),
      });
      const firstWorkspacePath = getPreparedWorkspacePath(firstPrepared);
      if (firstWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }
      expect(
        await readFileAtRef(firstWorkspacePath, "HEAD", "README.md"),
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
      const secondWorkspacePath = getPreparedWorkspacePath(secondPrepared);
      if (secondWorkspacePath === null) {
        throw new Error("expected local workspace path");
      }
      expect(secondPrepared.createdNow).toBe(false);
      expect(
        await readFileAtRef(secondWorkspacePath, "HEAD", "README.md"),
      ).toContain("# refreshed repo");

      const remoteUrl = await execFile(
        "git",
        ["config", "--get", "remote.origin.url"],
        { cwd: secondWorkspacePath },
      );
      expect(remoteUrl.stdout.trim()).toBe(config.workspace.repoUrl);
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
      await writeWorkflowContract(config.workflowPath);

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
        deriveGitHubMirrorPath(config.instance),
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
      await writeWorkflowContract(config.workflowPath);

      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        preparer,
        workerPid: 6543,
      });

      expect(outcome.kind).toBe("failed");
      const raw = await fs.readFile(
        deriveStartupFilePath(config.instance),
        "utf8",
      );
      expect(parseStartupSnapshotContent(raw, "startup.json")).toMatchObject({
        state: "failed",
        workerPid: 6543,
        provider: "github-bootstrap/test-failure",
        summary: "Mirror refresh failed.",
        runtimeIdentity: {
          checkoutPath: process.cwd(),
        },
        workflowIdentity: {
          workflowPath: config.workflowPath,
          source: "file",
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
      await writeWorkflowContract(config.workflowPath);

      await expect(
        runStartupPreparation({
          config,
          logger: new JsonLogger(),
          preparer,
          workerPid: 9876,
        }),
      ).rejects.toSatisfy((error: unknown) => isAbortError(error));

      const snapshot = await readStartupSnapshot(
        deriveStartupFilePath(config.instance),
      );
      expect(snapshot).toMatchObject({
        state: "preparing",
        workerPid: 9876,
        provider: "github-bootstrap/test-abort",
        runtimeIdentity: {
          checkoutPath: process.cwd(),
        },
        workflowIdentity: {
          workflowPath: config.workflowPath,
          source: "file",
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

  it("round-trips recorded workflow identity from startup snapshots", () => {
    const snapshot = parseStartupSnapshotContent(
      JSON.stringify({
        version: 1,
        state: "ready",
        updatedAt: "2026-03-14T12:00:00.000Z",
        workerPid: 6543,
        provider: "github-bootstrap/test-failure",
        summary: "ready",
        runtimeIdentity: {
          checkoutPath: "/tmp/runtime",
          headSha: "runtime-sha",
          committedAt: "2026-03-14T11:00:00.000Z",
          isDirty: false,
          source: "git",
          detail: null,
        },
        workflowIdentity: {
          workflowPath: "/tmp/project/WORKFLOW.md",
          contentHash:
            "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
          source: "file",
          detail: null,
        },
      }),
      "startup.json",
    );

    expect(snapshot.workflowIdentity).toEqual({
      workflowPath: "/tmp/project/WORKFLOW.md",
      contentHash:
        "8b78342f9d6cb87a4fc8af4f35adf6ec0d8367864e594b0f88ff3a780b3fa929",
      source: "file",
      detail: null,
    });
  });
});
