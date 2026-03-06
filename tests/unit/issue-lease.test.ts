import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { LocalIssueLeaseManager } from "../../src/orchestrator/issue-lease.js";
import { createTempDir } from "../support/git.js";

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") {
        return;
      }
      throw error;
    }
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

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
});
