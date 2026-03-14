import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStartupPreparer,
  deriveStartupFilePath,
  parseStartupSnapshotContent,
  readStartupSnapshot,
  runStartupPreparation,
  type StartupPreparer,
} from "../../src/startup/service.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { isAbortError } from "../../src/support/abort.js";
import { createTempDir } from "../support/git.js";

afterEach(() => {
  process.exitCode = undefined;
});

function createConfig(root: string) {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    tracker: {
      kind: "github-bootstrap" as const,
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
      repoUrl: "/tmp/repo.git",
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

describe("startup service", () => {
  it("creates tracker-specific no-op preparers", () => {
    const preparer = createStartupPreparer(createConfig("/tmp/repo"));
    expect(preparer.id).toBe("github-bootstrap/noop");
  });

  it("writes a ready startup snapshot for successful startup preparation", async () => {
    const tempDir = await createTempDir("symphony-startup-ready-");
    const config = createConfig(tempDir);

    try {
      const outcome = await runStartupPreparation({
        config,
        logger: new JsonLogger(),
        workerPid: 3210,
      });

      expect(outcome.kind).toBe("ready");
      const snapshot = await readStartupSnapshot(
        deriveStartupFilePath(config.workspace.root),
      );
      expect(snapshot).toMatchObject({
        state: "ready",
        workerPid: 3210,
        provider: "github-bootstrap/noop",
        runtimeIdentity: {
          checkoutPath: tempDir,
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists an explicit failed startup snapshot when the preparer fails", async () => {
    const tempDir = await createTempDir("symphony-startup-failed-");
    const config = createConfig(tempDir);
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
    const config = createConfig(tempDir);
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
