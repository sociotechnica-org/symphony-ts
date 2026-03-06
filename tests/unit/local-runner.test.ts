import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { RunnerAbortedError } from "../../src/domain/errors.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { LocalRunner } from "../../src/runner/local.js";

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

function createSession(): RunSession {
  return {
    id: "sociotechnica-org/symphony-ts#1/attempt-1",
    issue: {
      id: "1",
      identifier: "sociotechnica-org/symphony-ts#1",
      number: 1,
      title: "Runner stdin closes early",
      description: "",
      labels: [],
      state: "open",
      url: "https://example.test/issues/1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    workspace: {
      key: "sociotechnica-org_symphony-ts_1",
      path: process.cwd(),
      branchName: "symphony/1",
      createdNow: false,
    },
    prompt: "x".repeat(10_000_000),
    attempt: {
      sequence: 1,
    },
  };
}

describe("LocalRunner", () => {
  it("handles a closed stdin pipe without crashing the process", async () => {
    const runner = new LocalRunner(
      {
        command:
          'node -e "process.stdin.destroy(); setTimeout(() => process.exit(0), 10)"',
        promptTransport: "stdin",
        timeoutMs: 5_000,
        env: {},
      },
      new JsonLogger(),
    );
    const session = createSession();

    const result = await runner.run(session);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("stdin write failed");
  });

  it("reports the spawned pid and aborts the runner child on shutdown", async () => {
    const runner = new LocalRunner(
      {
        command: 'node -e "setInterval(() => {}, 1000)"',
        promptTransport: "stdin",
        timeoutMs: 5_000,
        env: {},
      },
      new JsonLogger(),
    );
    const session = createSession();
    const abortController = new AbortController();
    let spawnedPid = -1;

    const run = runner.run(session, {
      signal: abortController.signal,
      onSpawn(event) {
        spawnedPid = event.pid;
        abortController.abort();
      },
    });

    await expect(run).rejects.toBeInstanceOf(RunnerAbortedError);
    expect(spawnedPid).toBeGreaterThan(0);
    await waitForExit(spawnedPid);
  });
});
