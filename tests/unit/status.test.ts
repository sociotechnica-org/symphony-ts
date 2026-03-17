import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assessFactoryStatusSnapshot,
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
    runtimeIdentity: {
      checkoutPath: "/tmp/repo/.tmp/factory-main",
      headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
      committedAt: "2026-03-06T11:57:00.000Z",
      isDirty: false,
      source: "git",
      detail: null,
    },
    publication: {
      state: "current",
      detail: null,
    },
    restartRecovery: {
      state: "ready",
      startedAt: "2026-03-06T11:59:10.000Z",
      completedAt: "2026-03-06T11:59:20.000Z",
      summary: "Restart recovery completed successfully.",
      issues: [
        {
          issueNumber: 11,
          issueIdentifier: "sociotechnica-org/symphony-ts#11",
          branchName: "symphony/11",
          decision: "requeued",
          leaseState: "stale-owner",
          lifecycleKind: "missing-target",
          ownerPid: 4567,
          ownerAlive: false,
          runnerPid: null,
          runnerAlive: null,
          summary: "Recovered stale inherited ownership for issue #11.",
          observedAt: "2026-03-06T11:59:15.000Z",
        },
      ],
    },
    recoveryPosture: {
      summary: {
        family: "restart-recovery",
        summary: "3 issues still show restart reconciliation posture.",
        issueCount: 3,
      },
      entries: [
        {
          family: "restart-recovery",
          issueNumber: null,
          issueIdentifier: null,
          title: null,
          source: "restart-recovery",
          summary: "Restart recovery completed successfully.",
          observedAt: "2026-03-06T11:59:20.000Z",
        },
        {
          family: "restart-recovery",
          issueNumber: 11,
          issueIdentifier: "sociotechnica-org/symphony-ts#11",
          title: null,
          source: "restart-recovery",
          summary: "Recovered stale inherited ownership for issue #11.",
          observedAt: "2026-03-06T11:59:15.000Z",
        },
        {
          family: "waiting-expected",
          issueNumber: 12,
          issueIdentifier: "sociotechnica-org/symphony-ts#12",
          title: "Expose factory status",
          source: "active-issue",
          summary:
            "Waiting for PR checks to appear on https://example.test/pr/12",
          observedAt: "2026-03-06T12:00:00.000Z",
        },
        {
          family: "retry-backoff",
          issueNumber: 9,
          issueIdentifier: "sociotechnica-org/symphony-ts#9",
          title: "Retry a failed run",
          source: "retry-queue",
          summary: "Retry attempt 2 is queued until 2026-03-06T12:05:00.000Z.",
          observedAt: "2026-03-06T12:00:00.000Z",
        },
      ],
    },
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
          headSha: "head-sha-12",
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
        runnerVisibility: {
          state: "waiting",
          phase: "awaiting-external",
          session: {
            provider: "codex",
            model: "gpt-5.4",
            backendSessionId: "thread-12-turn-2",
            backendThreadId: "thread-12",
            latestTurnId: "turn-2",
            appServerPid: 4321,
            latestTurnNumber: 2,
            logPointers: [],
          },
          lastHeartbeatAt: "2026-03-06T12:00:00.000Z",
          lastActionAt: "2026-03-06T12:00:00.000Z",
          lastActionSummary: "Waiting for PR checks",
          waitingReason:
            "Waiting for PR checks to appear on https://example.test/pr/12",
          stdoutSummary: "Opened PR #12",
          stderrSummary: null,
          errorSummary: null,
          cancelledAt: null,
          timedOutAt: null,
        },
      },
    ],
    retries: [
      {
        issueNumber: 9,
        issueIdentifier: "sociotechnica-org/symphony-ts#9",
        title: "Retry a failed run",
        nextAttempt: 2,
        retryClass: "run-failure",
        scheduledAt: "2026-03-06T12:00:00.000Z",
        backoffMs: 300000,
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

  it("renders restart recovery posture and per-issue decisions", () => {
    const rendered = renderFactoryStatusSnapshot(createSnapshot());

    expect(rendered).toContain("Restart recovery: ready");
    expect(rendered).toContain(
      "Restart recovery detail: Restart recovery completed successfully.",
    );
    expect(rendered).toContain("Recovery posture: restart-recovery");
    expect(rendered).toContain("Recovery posture entries:");
    expect(rendered).toContain("[waiting-expected] #12");
    expect(rendered).toContain(
      "#11 sociotechnica-org/symphony-ts#11 [requeued]",
    );
    expect(rendered).toContain("[run-failure]");
    expect(rendered).toContain(
      "Scheduled: 2026-03-06T12:00:00.000Z (+300000ms)",
    );
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
            runnerVisibility: undefined,
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
            runnerVisibility: null,
          },
        ],
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders a terminal-friendly view from the snapshot", () => {
    const output = renderFactoryStatusSnapshot(createSnapshot(), {
      statusFilePath: "/tmp/status.json",
    });

    expect(output).toContain("Factory: blocked");
    expect(output).toContain("Snapshot freshness: fresh");
    expect(output).toContain("Worker: online");
    expect(output).toContain(
      "Counts: ready=1 tracker_running=2 failed=0 local=0 retries=1",
    );
    expect(output).toContain("Runtime checkout: /tmp/repo/.tmp/factory-main");
    expect(output).toContain(
      "Runtime version: 4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26 | committed 2026-03-06T11:57:00.000Z | clean",
    );
    expect(output).toContain(
      "#12 Expose factory status [awaiting-system-checks]",
    );
    expect(output).toContain("PR: #12 https://example.test/pr/12");
    expect(output).toContain(
      "Runner: waiting phase=awaiting-external provider=codex",
    );
    expect(output).toContain("Runner action: Waiting for PR checks");
    expect(output).toContain("Pending checks: CI");
    expect(output).toContain("Retries:");
    expect(output).toContain("#9 Retry a failed run attempt 2");
  });

  it("renders freshness as stale when the worker pid is offline", () => {
    const output = renderFactoryStatusSnapshot(
      createSnapshot({
        worker: {
          ...createSnapshot().worker,
          pid: 999_999_999,
        },
      }),
    );

    expect(output).toContain("Snapshot freshness: stale");
    expect(output).toContain(
      "The recorded worker PID is offline, so this snapshot is historical and not current.",
    );
  });

  it("renders unavailable runtime identity cleanly", () => {
    const output = renderFactoryStatusSnapshot(
      createSnapshot({
        runtimeIdentity: {
          checkoutPath: "/tmp/repo/.tmp/factory-main",
          headSha: null,
          committedAt: null,
          isDirty: null,
          source: "not-a-git-checkout",
          detail: "fatal: not a git repository",
        },
        activeIssues: [],
        retries: [],
      }),
    );

    expect(output).toContain(
      "Runtime version: unavailable (not-a-git-checkout: fatal: not a git repository)",
    );
  });

  it("classifies startup snapshots as unavailable while the worker is live", () => {
    expect(
      assessFactoryStatusSnapshot(
        createSnapshot({
          publication: {
            state: "initializing",
            detail:
              "Factory startup is in progress; no current runtime snapshot is available yet.",
          },
        }),
        { workerAlive: true, hasLiveRuntime: true },
      ),
    ).toMatchObject({
      freshness: "unavailable",
      reason: "startup-in-progress",
    });
  });

  it("classifies startup snapshots from an offline worker as stale startup failures", () => {
    expect(
      assessFactoryStatusSnapshot(
        createSnapshot({
          publication: {
            state: "initializing",
            detail:
              "Factory startup is in progress; no current runtime snapshot is available yet.",
          },
        }),
        { workerAlive: false, hasLiveRuntime: true },
      ),
    ).toMatchObject({
      freshness: "stale",
      reason: "startup-failed",
      summary:
        "The startup placeholder belongs to an offline worker, so startup did not complete and this snapshot is historical.",
    });
  });

  it("classifies startup snapshots without a live runtime as stale", () => {
    expect(
      assessFactoryStatusSnapshot(
        createSnapshot({
          publication: {
            state: "initializing",
            detail:
              "Factory startup is in progress; no current runtime snapshot is available yet.",
          },
        }),
        { workerAlive: true, hasLiveRuntime: false },
      ),
    ).toMatchObject({
      freshness: "stale",
      reason: "no-live-runtime",
      summary:
        "No live factory runtime owns this startup snapshot anymore, so it is historical and not current.",
    });
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

  it("renders awaiting-landing-command issues distinctly", () => {
    const output = renderFactoryStatusSnapshot(
      createSnapshot({
        lastAction: {
          kind: "awaiting-landing-command",
          summary:
            "Pull request https://example.test/pr/12 is awaiting a human /land command",
          at: "2026-03-06T12:00:00.000Z",
          issueNumber: 12,
        },
        activeIssues: [
          {
            ...createSnapshot().activeIssues[0]!,
            status: "awaiting-landing-command",
            summary:
              "Pull request https://example.test/pr/12 is awaiting a human /land command",
            blockedReason:
              "Pull request https://example.test/pr/12 is awaiting a human /land command",
          },
        ],
      }),
    );

    expect(output).toContain(
      "#12 Expose factory status [awaiting-landing-command]",
    );
    expect(output).toContain("awaiting a human /land command");
  });
});
