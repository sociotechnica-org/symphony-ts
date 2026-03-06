import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { JsonLogger } from "../../src/observability/logger.js";
import type { Logger } from "../../src/observability/logger.js";
import { LocalIssueLeaseManager } from "../../src/orchestrator/issue-lease.js";
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
    },
    workspace: {
      key: `sociotechnica-org_symphony-ts_${issueNumber}`,
      path: workspacePath,
      branchName: `symphony/${issueNumber}`,
      createdNow: false,
    },
    prompt: "test prompt",
    attempt: {
      sequence: 1,
    },
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

      await manager.recordRun(lockDir!, createSession(21, tempRoot));
      await manager.recordRunnerSpawn(lockDir!, {
        pid: process.pid,
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
            acquiredAt: new Date().toISOString(),
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
            acquiredAt: new Date().toISOString(),
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
            acquiredAt: new Date().toISOString(),
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
});
