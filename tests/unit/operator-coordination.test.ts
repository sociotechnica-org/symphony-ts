import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireActiveWakeUpLease,
  acquireLoopLock,
  inspectCoordinationArtifact,
  rejectLaunchDuringActiveWakeUpLease,
  releaseOwnedCoordinationArtifact,
} from "../../src/operator/coordination.js";

const createdRoots = new Set<string>();

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-coord-"));
  createdRoots.add(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of createdRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe("operator coordination artifacts", () => {
  it("treats missing owner metadata as stale and recovers the loop lock", async () => {
    const root = await createTempRoot();
    const lockDir = path.join(root, "operator-loop.lock");
    const ownerFile = path.join(lockDir, "owner");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(ownerFile, "pid=not-a-pid\n", "utf8");

    const messages: string[] = [];
    const artifact = await acquireLoopLock({
      lockDir,
      ownerFile,
      ownerPid: process.pid,
      repoRoot: "/tmp/operator-repo",
      startedAt: "2026-04-09T00:00:00Z",
      reporter: (message) => messages.push(message),
    });

    expect(messages).toContain(
      "operator-loop: clearing stale lock for pid unknown",
    );
    expect(artifact.ownerPid).toBe(process.pid);
    expect(await fs.readFile(ownerFile, "utf8")).toContain(
      `pid=${process.pid.toString()}`,
    );

    await releaseOwnedCoordinationArtifact(artifact);
    await expect(fs.access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second live loop lock holder", async () => {
    const root = await createTempRoot();
    const lockDir = path.join(root, "operator-loop.lock");
    const ownerFile = path.join(lockDir, "owner");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(ownerFile, `pid=${process.pid.toString()}\n`, "utf8");

    await expect(
      acquireLoopLock({
        lockDir,
        ownerFile,
        ownerPid: process.pid + 1,
        repoRoot: "/tmp/operator-repo",
        startedAt: "2026-04-09T00:00:00Z",
        reporter: () => {},
      }),
    ).rejects.toThrow(
      `operator-loop: another loop is already running with pid ${process.pid.toString()}`,
    );
  });

  it("reports a live active wake-up lease without taking it over", async () => {
    const root = await createTempRoot();
    const lockDir = path.join(root, "active-wake-up.lock");
    const ownerFile = path.join(lockDir, "owner");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      ownerFile,
      [
        `pid=${process.pid.toString()}`,
        "operator_repo_root=/tmp/other-repo",
        "selected_instance_root=/tmp/other-instance",
        "workflow_path=/tmp/other-instance/WORKFLOW.md",
      ].join("\n") + "\n",
      "utf8",
    );

    const messages: string[] = [];
    const result = await acquireActiveWakeUpLease({
      coordinationRoot: root,
      lockDir,
      ownerFile,
      ownerPid: process.pid + 1,
      selectedInstanceRoot: "/tmp/requested-instance",
      operatorRepoRoot: "/tmp/requested-repo",
      workflowPath: "/tmp/requested-instance/WORKFLOW.md",
      instanceKey: "requested-instance",
      startedAt: "2026-04-09T00:00:00Z",
      reporter: (message) => messages.push(message),
    });

    expect(result.ok).toBe(false);
    expect(messages).toContain(
      "operator-loop: active wake-up lease already held for this instance; " +
        `owner_pid=${process.pid.toString()}; ` +
        "owner_repo_root=/tmp/other-repo; " +
        "owner_selected_instance_root=/tmp/other-instance; " +
        "owner_workflow=/tmp/other-instance/WORKFLOW.md",
    );
  });

  it("retries the active wake-up lease when the lock disappears after EEXIST", async () => {
    const root = await createTempRoot();
    const lockDir = path.join(root, "active-wake-up.lock");
    const ownerFile = path.join(lockDir, "owner");
    const originalMkdir = fs.mkdir.bind(fs);
    let injectedRace = false;

    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const [target] = args;
      if (!injectedRace && target === lockDir) {
        injectedRace = true;
        const error = new Error("already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return await originalMkdir(...args);
    });

    const result = await acquireActiveWakeUpLease({
      coordinationRoot: root,
      lockDir,
      ownerFile,
      ownerPid: process.pid,
      selectedInstanceRoot: "/tmp/requested-instance",
      operatorRepoRoot: "/tmp/requested-repo",
      workflowPath: "/tmp/requested-instance/WORKFLOW.md",
      instanceKey: "requested-instance",
      startedAt: "2026-04-09T00:00:00Z",
      reporter: () => {},
    });

    expect(result.ok).toBe(true);
    await expect(fs.readFile(ownerFile, "utf8")).resolves.toContain(
      `pid=${process.pid.toString()}`,
    );
  });

  it("clears a stale active wake-up lease before top-level launch rejection runs", async () => {
    const root = await createTempRoot();
    const lockDir = path.join(root, "active-wake-up.lock");
    const ownerFile = path.join(lockDir, "owner");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(ownerFile, "pid=not-a-pid\n", "utf8");

    const messages: string[] = [];
    await rejectLaunchDuringActiveWakeUpLease({
      lockDir,
      ownerFile,
      requestedInstanceKey: "requested-instance",
      requestedWorkflowPath: "/tmp/requested-instance/WORKFLOW.md",
      reporter: (message) => messages.push(message),
    });

    expect(messages).toContain(
      "operator-loop: clearing stale active wake-up lease for pid unknown",
    );
    expect(await inspectCoordinationArtifact({ lockDir, ownerFile })).toEqual({
      state: "absent",
      owner: null,
    });
  });
});
