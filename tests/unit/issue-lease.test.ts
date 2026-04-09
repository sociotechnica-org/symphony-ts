import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { createConfiguredWorkspaceSource } from "../../src/domain/workspace.js";
import { JsonLogger } from "../../src/observability/logger.js";
import type { Logger } from "../../src/observability/logger.js";
import { LocalIssueLeaseManager } from "../../src/orchestrator/issue-lease.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import { createTempDir } from "../support/git.js";
import { waitForExit } from "../support/process.js";

function createSession(issueNumber: number, workspacePath: string): RunSession {
  const timestamp = new Date().toISOString();
  return {
    id: `sociotechnica-org/symphony-ts#${issueNumber}/attempt-1/test`,
    issue: {
      id: String(issueNumber),
      identifier: `sociotechnica-org/symphony-ts#${issueNumber}`,
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      description: "",
      labels: ["symphony:running"],
      state: "open",
      url: `https://example.test/issues/${issueNumber}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      queuePriority: null,
      blockedBy: [],
    },
    workspace: {
      key: `sociotechnica-org_symphony-ts_${issueNumber}`,
      branchName: `symphony/${issueNumber}`,
      createdNow: false,
      source: createConfiguredWorkspaceSource(workspacePath),
      target: {
        kind: "local",
        path: workspacePath,
      },
    },
    prompt: "test prompt",
    startedAt: timestamp,
    attempt: {
      sequence: 1,
    },
  };
}

function createDescription() {
  return {
    provider: "test-runner",
    model: null,
    transport: createRunnerTransportMetadata("local-process", {
      canTerminateLocalProcess: true,
    }),
    backendSessionId: null,
    backendThreadId: null,
    latestTurnId: null,
    latestTurnNumber: null,
    logPointers: [],
  };
}

class CapturingLogger implements Logger {
  readonly warnings: string[] = [];

  info(_message: string, _data?: Record<string, unknown>): void {}

  warn(message: string, _data?: Record<string, unknown>): void {
    this.warnings.push(message);
  }

  error(_message: string, _data?: Record<string, unknown>): void {}
}

describe("LocalIssueLeaseManager", () => {
  it("persists active run metadata once a runner pid is attached", async () => {
    const tempRoot = await createTempDir("symphony-lease-state-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());

    try {
      const lockDir = await manager.acquire(21);
      expect(lockDir).not.toBeNull();

      await manager.recordRun(
        lockDir!,
        createSession(21, tempRoot),
        createDescription(),
        {
          factoryInstanceId: "test-instance",
        },
      );
      manager.recordRunnerSpawn(lockDir!, {
        kind: "spawned",
        transport: createRunnerTransportMetadata("local-process", {
          localProcessPid: process.pid,
          canTerminateLocalProcess: true,
        }),
        spawnedAt: new Date().toISOString(),
      });

      const snapshot = await manager.inspect(21);
      expect(snapshot.kind).toBe("active");
      expect(snapshot.ownerPid).toBe(process.pid);
      expect(snapshot.runnerPid).toBe(process.pid);
      expect(snapshot.record?.runSessionId).toContain("#21");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not record a local runner pid for remote-only execution transport", async () => {
    const tempRoot = await createTempDir("symphony-lease-remote-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());

    try {
      const lockDir = await manager.acquire(31);
      expect(lockDir).not.toBeNull();

      await manager.recordRun(
        lockDir!,
        createSession(31, tempRoot),
        createDescription(),
        {
          factoryInstanceId: "test-instance",
        },
      );
      manager.recordRunnerSpawn(lockDir!, {
        kind: "spawned",
        transport: createRunnerTransportMetadata("remote-task", {
          remoteTaskId: "task-31",
        }),
        spawnedAt: new Date().toISOString(),
      });

      const snapshot = await manager.inspect(31);
      expect(snapshot.kind).toBe("active");
      expect(snapshot.runnerPid).toBeNull();
      expect(snapshot.record?.runnerPid).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves an intentional shutdown record during recovery when requested", async () => {
    const tempRoot = await createTempDir("symphony-lease-shutdown-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());

    try {
      const lockDir = await manager.acquire(28);
      expect(lockDir).not.toBeNull();

      await manager.recordRun(
        lockDir!,
        createSession(28, tempRoot),
        createDescription(),
        {
          factoryInstanceId: "test-instance",
        },
      );
      await manager.recordShutdown(lockDir!, {
        state: "shutdown-terminated",
        requestedAt: new Date().toISOString(),
        gracefulDeadlineAt: new Date().toISOString(),
        terminatedAt: new Date().toISOString(),
        reasonSummary: "Runner cancelled by shutdown",
        updatedAt: new Date().toISOString(),
      });
      await fs.writeFile(path.join(lockDir!, "pid"), "999999\n", "utf8");

      const snapshot = await manager.reconcile(28, {
        preserveShutdown: true,
      });

      expect(snapshot.kind).toBe("shutdown-terminated");
      expect((await manager.inspect(28)).kind).toBe("shutdown-terminated");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("clears an intentional shutdown record during recovery when preservation is not requested", async () => {
    const tempRoot = await createTempDir("symphony-lease-shutdown-clear-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());

    try {
      const lockDir = await manager.acquire(29);
      expect(lockDir).not.toBeNull();

      await manager.recordRun(
        lockDir!,
        createSession(29, tempRoot),
        createDescription(),
        {
          factoryInstanceId: "test-instance",
        },
      );
      await manager.recordShutdown(lockDir!, {
        state: "shutdown-forced",
        requestedAt: new Date().toISOString(),
        gracefulDeadlineAt: new Date().toISOString(),
        terminatedAt: new Date().toISOString(),
        reasonSummary: "Runner forced to stop during shutdown",
        updatedAt: new Date().toISOString(),
      });
      await fs.writeFile(path.join(lockDir!, "pid"), "999999\n", "utf8");

      const snapshot = await manager.reconcile(29);

      expect(snapshot.kind).toBe("shutdown-forced");
      expect((await manager.inspect(29)).kind).toBe("missing");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes an incomplete lease if pid persistence fails during acquire", async () => {
    const tempRoot = await createTempDir("symphony-lease-acquire-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());
    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(
        Object.assign(new Error("disk full"), { code: "ENOSPC" }),
      );

    try {
      await expect(manager.acquire(23)).rejects.toMatchObject({
        code: "ENOSPC",
      });
      expect((await manager.inspect(23)).kind).toBe("missing");
    } finally {
      writeFileSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles a stale lease by terminating the orphaned runner and clearing the lock", async () => {
    const tempRoot = await createTempDir("symphony-lease-reconcile-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());
    const orphan = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );

    try {
      const lockDir = path.join(tempRoot, ".symphony-locks", "22");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 22,
            issueIdentifier: "sociotechnica-org/symphony-ts#22",
            branchName: "symphony/22",
            runSessionId: "sociotechnica-org/symphony-ts#22/attempt-1/orphaned",
            attempt: 1,
            ownerPid: 999999,
            runnerPid: orphan.pid,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const snapshot = await manager.reconcile(22);
      expect(snapshot.kind).toBe("stale-owner-runner");

      await waitForExit(orphan.pid!);
      expect((await manager.inspect(22)).kind).toBe("missing");
    } finally {
      orphan.kill("SIGKILL");
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles an invalid lease by terminating the orphaned runner and clearing the lock", async () => {
    const tempRoot = await createTempDir("symphony-lease-invalid-");
    const manager = new LocalIssueLeaseManager(tempRoot, new JsonLogger());
    const orphan = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );

    try {
      const lockDir = path.join(tempRoot, ".symphony-locks", "24");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "not-a-pid\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 24,
            issueIdentifier: "sociotechnica-org/symphony-ts#24",
            branchName: "symphony/24",
            runSessionId: "sociotechnica-org/symphony-ts#24/attempt-1/orphaned",
            attempt: 1,
            ownerPid: 999999,
            runnerPid: orphan.pid,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const snapshot = await manager.reconcile(24);
      expect(snapshot.kind).toBe("invalid");

      await waitForExit(orphan.pid!);
      expect((await manager.inspect(24)).kind).toBe("missing");
    } finally {
      orphan.kill("SIGKILL");
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("clears a stale runner lease without waiting when signaling is denied", async () => {
    const tempRoot = await createTempDir("symphony-lease-eperm-");
    const logger = new CapturingLogger();
    const manager = new LocalIssueLeaseManager(tempRoot, logger);

    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === 999999 && signal === 0) {
          const error = new Error("missing process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }

        if (pid === 4242 && signal === 0) {
          return true;
        }

        if (pid === 4242 && signal === "SIGTERM") {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }

        throw new Error(`Unexpected kill(${String(pid)}, ${String(signal)})`);
      });

    try {
      const lockDir = path.join(tempRoot, ".symphony-locks", "25");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 25,
            issueIdentifier: "sociotechnica-org/symphony-ts#25",
            branchName: "symphony/25",
            runSessionId: "sociotechnica-org/symphony-ts#25/attempt-1/orphaned",
            attempt: 1,
            ownerPid: 999999,
            runnerPid: 4242,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const snapshot = await manager.reconcile(25);
      expect(snapshot.kind).toBe("stale-owner-runner");
      expect(killSpy.mock.calls).toEqual([
        [999999, 0],
        [4242, 0],
        [4242, "SIGTERM"],
      ]);
      expect(logger.warnings).toContain(
        "Unable to signal orphaned runner process; clearing lease anyway",
      );
      expect((await manager.inspect(25)).kind).toBe("missing");
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("never signals the current orchestrator process while reconciling a stale runner lease", async () => {
    const tempRoot = await createTempDir("symphony-lease-self-runner-");
    const logger = new CapturingLogger();
    const manager = new LocalIssueLeaseManager(tempRoot, logger);

    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === 999999 && signal === 0) {
          const error = new Error("missing process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }

        if (pid === process.pid && signal === 0) {
          return true;
        }

        throw new Error(`Unexpected kill(${String(pid)}, ${String(signal)})`);
      });

    try {
      const lockDir = path.join(tempRoot, ".symphony-locks", "27");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 27,
            issueIdentifier: "sociotechnica-org/symphony-ts#27",
            branchName: "symphony/27",
            runSessionId: "sociotechnica-org/symphony-ts#27/attempt-1/orphaned",
            attempt: 1,
            ownerPid: 999999,
            runnerPid: process.pid,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const snapshot = await manager.reconcile(27);
      expect(snapshot.kind).toBe("stale-owner-runner");
      expect(killSpy.mock.calls).toEqual([
        [999999, 0],
        [process.pid, 0],
      ]);
      expect(logger.warnings).toContain(
        "Refusing to terminate current orchestrator process while reconciling orphaned runner lease",
      );
      expect((await manager.inspect(27)).kind).toBe("missing");
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not warn when the runner exits before SIGKILL is delivered", async () => {
    const tempRoot = await createTempDir("symphony-lease-sigkill-missing-");
    const logger = new CapturingLogger();
    const manager = new LocalIssueLeaseManager(tempRoot, logger);

    let runnerAliveChecks = 0;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === 999999 && signal === 0) {
          const error = new Error("missing process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }

        if (pid === 4343 && signal === 0) {
          runnerAliveChecks += 1;
          if (runnerAliveChecks <= 11) {
            return true;
          }

          const error = new Error("missing process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }

        if (pid === 4343 && signal === "SIGTERM") {
          return true;
        }

        if (pid === 4343 && signal === "SIGKILL") {
          const error = new Error("missing process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }

        throw new Error(`Unexpected kill(${String(pid)}, ${String(signal)})`);
      });

    try {
      const lockDir = path.join(tempRoot, ".symphony-locks", "26");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 26,
            issueIdentifier: "sociotechnica-org/symphony-ts#26",
            branchName: "symphony/26",
            runSessionId: "sociotechnica-org/symphony-ts#26/attempt-1/orphaned",
            attempt: 1,
            ownerPid: 999999,
            runnerPid: 4343,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const snapshot = await manager.reconcile(26);
      expect(snapshot.kind).toBe("stale-owner-runner");
      expect(logger.warnings).toEqual([]);
      expect((await manager.inspect(26)).kind).toBe("missing");
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
