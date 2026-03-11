import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deriveStatusFilePath,
  isProcessAlive,
  readFactoryStatusSnapshot,
  renderFactoryStatusSnapshot,
  writeFactoryStatusSnapshot,
  type FactoryStatusSnapshot,
} from "../../src/observability/status.js";
import { createTempDir } from "../support/git.js";

function createSnapshot(
  overrides?: Partial<FactoryStatusSnapshot>,
): FactoryStatusSnapshot {
  return {
    version: 1,
    generatedAt: "2026-03-06T12:00:00.000Z",
    factoryState: "blocked",
    worker: {
      instanceId: "worker-123",
      pid: process.pid,
      startedAt: "2026-03-06T11:59:00.000Z",
      pollIntervalMs: 5000,
      maxConcurrentRuns: 1,
    },
    counts: {
      ready: 1,
      running: 2,
      failed: 0,
      activeLocalRuns: 0,
      retries: 1,
    },
    lastAction: {
      kind: "awaiting-system-checks",
      summary: "Waiting for PR checks to appear on https://example.test/pr/12",
      at: "2026-03-06T12:00:00.000Z",
      issueNumber: 12,
    },
    activeIssues: [
      {
        issueNumber: 12,
        issueIdentifier: "sociotechnica-org/symphony-ts#12",
        title: "Expose factory status",
        source: "running",
        runSequence: 2,
        status: "awaiting-system-checks",
        summary:
          "Waiting for PR checks to appear on https://example.test/pr/12",
        workspacePath: "/tmp/workspaces/12",
        branchName: "symphony/12",
        runSessionId: "session-12",
        ownerPid: process.pid,
        runnerPid: null,
        startedAt: "2026-03-06T11:58:00.000Z",
        updatedAt: "2026-03-06T12:00:00.000Z",
        pullRequest: {
          number: 12,
          url: "https://example.test/pr/12",
          latestCommitAt: "2026-03-06T11:59:30.000Z",
        },
        checks: {
          pendingNames: ["CI"],
          failingNames: [],
        },
        review: {
          actionableCount: 0,
          unresolvedThreadCount: 0,
        },
        blockedReason:
          "Waiting for PR checks to appear on https://example.test/pr/12",
      },
    ],
    retries: [
      {
        issueNumber: 9,
        issueIdentifier: "sociotechnica-org/symphony-ts#9",
        title: "Retry a failed run",
        nextAttempt: 2,
        dueAt: "2026-03-06T12:05:00.000Z",
        lastError: "Runner exited with 1",
      },
    ],
    ...overrides,
  };
}

describe("factory status helpers", () => {
  it("derives the shared status file from the workspace root", () => {
    expect(deriveStatusFilePath("/tmp/repo/.tmp/workspaces")).toBe(
      path.resolve("/tmp/repo/.tmp/status.json"),
    );
  });

  it("keeps the status file within the workspace root when given a filesystem root", () => {
    expect(deriveStatusFilePath("/")).toBe(path.join("/", "status.json"));
  });

  it("writes and reads the JSON snapshot contract", async () => {
    const tempDir = await createTempDir("symphony-status-test-");
    const filePath = path.join(tempDir, "status.json");

    try {
      const first = createSnapshot();
      await writeFactoryStatusSnapshot(filePath, first);
      expect(await readFactoryStatusSnapshot(filePath)).toEqual(first);

      const second = createSnapshot({
        factoryState: "idle",
        counts: {
          ready: 0,
          running: 0,
          failed: 1,
          activeLocalRuns: 0,
          retries: 0,
        },
      });
      await writeFactoryStatusSnapshot(filePath, second);
      expect(await readFactoryStatusSnapshot(filePath)).toEqual(second);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up the temporary file when rename fails", async () => {
    const tempDir = await createTempDir("symphony-status-rename-failure-");
    const filePath = path.join(tempDir, "status.json");
    const snapshot = createSnapshot();
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(
        Object.assign(new Error("rename failed"), { code: "EPERM" }),
      );

    try {
      await expect(
        writeFactoryStatusSnapshot(filePath, snapshot),
      ).rejects.toThrow("rename failed");
      const entries = await fs.readdir(tempDir);
      expect(entries).toEqual([]);
    } finally {
      rename.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the snapshot version is unsupported", async () => {
    const tempDir = await createTempDir("symphony-status-version-test-");
    const filePath = path.join(tempDir, "status.json");

    try {
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ ...createSnapshot(), version: 2 }, null, 2)}\n`,
        "utf8",
      );

      await expect(readFactoryStatusSnapshot(filePath)).rejects.toThrowError(
        `Unsupported factory status snapshot version at ${filePath}: expected 1, received 2`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails clearly when required snapshot fields are invalid", async () => {
    const tempDir = await createTempDir("symphony-status-invalid-test-");
    const filePath = path.join(tempDir, "status.json");

    try {
      await fs.writeFile(
        filePath,
        `${JSON.stringify(
          {
            ...createSnapshot(),
            worker: {
              ...createSnapshot().worker,
              pid: "not-a-pid",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(readFactoryStatusSnapshot(filePath)).rejects.toThrowError(
        `Invalid factory status snapshot at ${filePath}: expected worker.pid to be an integer`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats non-positive pids as invalid and offline", async () => {
    const tempDir = await createTempDir("symphony-status-pid-test-");
    const filePath = path.join(tempDir, "status.json");

    try {
      await fs.writeFile(
        filePath,
        `${JSON.stringify(
          {
            ...createSnapshot(),
            worker: {
              ...createSnapshot().worker,
              pid: 0,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(readFactoryStatusSnapshot(filePath)).rejects.toThrowError(
        `Invalid factory status snapshot at ${filePath}: expected worker.pid to be a positive integer`,
      );
      expect(isProcessAlive(0)).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats omitted nullable fields as null while reading the snapshot", async () => {
    const tempDir = await createTempDir("symphony-status-nullable-test-");
    const filePath = path.join(tempDir, "status.json");

    try {
      const baseSnapshot = createSnapshot();
      const snapshot = {
        ...baseSnapshot,
        lastAction: undefined,
        activeIssues: [
          {
            ...baseSnapshot.activeIssues[0],
            startedAt: undefined,
            pullRequest: undefined,
            blockedReason: undefined,
          },
        ],
      };
      await fs.writeFile(
        filePath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf8",
      );

      await expect(readFactoryStatusSnapshot(filePath)).resolves.toMatchObject({
        lastAction: null,
        activeIssues: [
          {
            startedAt: null,
            pullRequest: null,
            blockedReason: null,
          },
        ],
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders a terminal-friendly view from the snapshot", () => {
    const output = renderFactoryStatusSnapshot(createSnapshot(), {
      workerAlive: true,
      statusFilePath: "/tmp/status.json",
    });

    expect(output).toContain("Factory: blocked");
    expect(output).toContain("Worker: online");
    expect(output).toContain(
      "Counts: ready=1 tracker_running=2 failed=0 local=0 retries=1",
    );
    expect(output).toContain(
      "#12 Expose factory status [awaiting-system-checks]",
    );
    expect(output).toContain("PR: #12 https://example.test/pr/12");
    expect(output).toContain("Pending checks: CI");
    expect(output).toContain("Retries:");
    expect(output).toContain("#9 Retry a failed run attempt 2");
  });

  it("renders worker state as unknown when liveness is omitted", () => {
    const output = renderFactoryStatusSnapshot(createSnapshot());

    expect(output).toContain("Worker: unknown");
  });

  it("renders awaiting-landing issues distinctly", () => {
    const output = renderFactoryStatusSnapshot(
      createSnapshot({
        lastAction: {
          kind: "awaiting-landing",
          summary:
            "Pull request https://example.test/pr/12 is awaiting merge / landing",
          at: "2026-03-06T12:00:00.000Z",
          issueNumber: 12,
        },
        activeIssues: [
          {
            ...createSnapshot().activeIssues[0]!,
            status: "awaiting-landing",
            summary:
              "Pull request https://example.test/pr/12 is awaiting merge / landing",
            blockedReason:
              "Pull request https://example.test/pr/12 is awaiting merge / landing",
          },
        ],
      }),
    );

    expect(output).toContain("#12 Expose factory status [awaiting-landing]");
    expect(output).toContain("awaiting merge / landing");
  });
});
