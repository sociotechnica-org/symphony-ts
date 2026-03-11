import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FsLivenessProbe,
  NullLivenessProbe,
} from "../../src/orchestrator/liveness-probe.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createProbeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-liveness-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".symphony"), { recursive: true });
  return root;
}

describe("NullLivenessProbe", () => {
  it("returns null log and diff with passthrough fields", async () => {
    const probe = new NullLivenessProbe();
    const result = await probe.capture({
      issueNumber: 42,
      workspacePath: "/tmp/workspaces/42",
      runSessionId: "session-42",
      prHeadSha: "abc123",
      hasActionableFeedback: true,
    });
    expect(result.logSizeBytes).toBeNull();
    expect(result.workspaceDiffHash).toBeNull();
    expect(result.prHeadSha).toBe("abc123");
    expect(result.hasActionableFeedback).toBe(true);
    expect(result.capturedAt).toBeGreaterThan(0);
  });
});

describe("FsLivenessProbe", () => {
  it("reads a run-specific log path derived from the session id", async () => {
    const root = await createProbeRoot();
    const issueNumber = 42;
    const runSessionId = "sociotechnica-org/symphony-ts#42/attempt-1/demo";
    const probe = new FsLivenessProbe(root);

    await fs.writeFile(
      path.join(root, ".symphony", `${encodeURIComponent(runSessionId)}.log`),
      "runner-a",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, ".symphony", `${issueNumber.toString()}.log`),
      "legacy",
      "utf8",
    );

    const result = await probe.capture({
      issueNumber,
      workspacePath: null,
      runSessionId,
      prHeadSha: null,
      hasActionableFeedback: false,
    });

    expect(result.logSizeBytes).toBe("runner-a".length);
  });

  it("falls back to an issue-specific log path when session id is missing", async () => {
    const root = await createProbeRoot();
    const issueNumber = 77;
    const probe = new FsLivenessProbe(root);

    await fs.writeFile(
      path.join(root, ".symphony", `${issueNumber.toString()}.log`),
      "issue-log",
      "utf8",
    );

    const result = await probe.capture({
      issueNumber,
      workspacePath: null,
      runSessionId: null,
      prHeadSha: null,
      hasActionableFeedback: false,
    });

    expect(result.logSizeBytes).toBe("issue-log".length);
  });
});
