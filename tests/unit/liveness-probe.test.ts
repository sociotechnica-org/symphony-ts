import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveWatchdogLogFileName,
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
      runStartedAt: "2026-03-13T08:45:59.000Z",
      runnerPhase: "turn-execution",
      runnerHeartbeatAt: "2026-03-13T08:46:00.000Z",
      runnerActionAt: "2026-03-13T08:46:01.000Z",
      hasActionableFeedback: true,
    });
    expect(result.logSizeBytes).toBeNull();
    expect(result.workspaceDiffHash).toBeNull();
    expect(result.prHeadSha).toBe("abc123");
    expect(result.runStartedAt).toBe("2026-03-13T08:45:59.000Z");
    expect(result.runnerPhase).toBe("turn-execution");
    expect(result.runnerHeartbeatAt).toBe("2026-03-13T08:46:00.000Z");
    expect(result.runnerActionAt).toBe("2026-03-13T08:46:01.000Z");
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
      path.join(
        root,
        ".symphony",
        deriveWatchdogLogFileName({ issueNumber, runSessionId }),
      ),
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
      runStartedAt: "2026-03-13T08:45:59.000Z",
      runnerPhase: "session-start",
      runnerHeartbeatAt: "2026-03-13T08:46:00.000Z",
      runnerActionAt: "2026-03-13T08:46:01.000Z",
      hasActionableFeedback: false,
    });

    expect(result.logSizeBytes).toBe("runner-a".length);
    expect(result.runStartedAt).toBe("2026-03-13T08:45:59.000Z");
    expect(result.runnerPhase).toBe("session-start");
    expect(result.runnerHeartbeatAt).toBe("2026-03-13T08:46:00.000Z");
    expect(result.runnerActionAt).toBe("2026-03-13T08:46:01.000Z");
  });

  it("falls back to an issue-specific log path when session id is missing", async () => {
    const root = await createProbeRoot();
    const issueNumber = 77;
    const probe = new FsLivenessProbe(root);

    await fs.writeFile(
      path.join(
        root,
        ".symphony",
        deriveWatchdogLogFileName({ issueNumber, runSessionId: null }),
      ),
      "issue-log",
      "utf8",
    );

    const result = await probe.capture({
      issueNumber,
      workspacePath: null,
      runSessionId: null,
      prHeadSha: null,
      runStartedAt: null,
      runnerPhase: null,
      runnerHeartbeatAt: null,
      runnerActionAt: null,
      hasActionableFeedback: false,
    });

    expect(result.logSizeBytes).toBe("issue-log".length);
  });

  it("derives the documented watchdog log filename contract", () => {
    expect(
      deriveWatchdogLogFileName({
        issueNumber: 12,
        runSessionId: "org/repo#12/attempt-1/demo",
      }),
    ).toBe(`${encodeURIComponent("org/repo#12/attempt-1/demo")}.log`);
    expect(
      deriveWatchdogLogFileName({
        issueNumber: 12,
        runSessionId: null,
      }),
    ).toBe("12.log");
  });
});
