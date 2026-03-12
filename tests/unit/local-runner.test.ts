import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import type { AgentConfig } from "../../src/domain/workflow.js";
import { RunnerAbortedError } from "../../src/domain/errors.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { GenericCommandRunner } from "../../src/runner/generic-command.js";
import { describeLocalRunnerBackend } from "../../src/runner/local-command.js";
import type { RunnerSpawnedEvent } from "../../src/runner/service.js";
import { waitForExit } from "../support/process.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTempDir } from "../support/git.js";
import { vi } from "vitest";
import type { Logger } from "../../src/observability/logger.js";

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
    startedAt: new Date().toISOString(),
    attempt: {
      sequence: 1,
    },
  };
}

function createCodexConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    runner: {
      kind: "codex",
    },
    command:
      "codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -",
    promptTransport: "stdin",
    timeoutMs: 5_000,
    maxTurns: 3,
    env: {},
    ...overrides,
  };
}

function createGenericCommandConfig(command: string): AgentConfig {
  return {
    runner: {
      kind: "generic-command",
    },
    command,
    promptTransport: "stdin",
    timeoutMs: 5_000,
    maxTurns: 3,
    env: {},
  };
}

describe("runners", () => {
  it("describes Codex-backed sessions with provider and model metadata", () => {
    const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

    expect(runner.describeSession(createSession())).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      backendSessionId: null,
      latestTurnNumber: null,
      logPointers: [],
    });
  });

  it("describes generic command sessions without Codex metadata", () => {
    const runner = new GenericCommandRunner(
      createGenericCommandConfig("tests/fixtures/fake-agent-success.sh"),
      new JsonLogger(),
    );

    expect(runner.describeSession(createSession())).toEqual({
      provider: "generic-command",
      model: null,
      backendSessionId: null,
      latestTurnNumber: null,
      logPointers: [],
    });
  });

  it("treats backslashes as literal characters inside single-quoted arguments", () => {
    expect(
      describeLocalRunnerBackend("codex exec -m 'gpt\\\\5.4\\\\reasoning'"),
    ).toEqual({
      provider: "codex",
      model: "gpt\\\\5.4\\\\reasoning",
    });
  });

  it("does not treat the next CLI flag as a Codex model name", () => {
    expect(
      describeLocalRunnerBackend(
        "codex exec -m --dangerously-bypass-approvals-and-sandbox -C . -",
      ),
    ).toEqual({
      provider: "codex",
      model: null,
    });
  });

  it("handles a closed stdin pipe without crashing the process", async () => {
    const runner = new GenericCommandRunner(
      createGenericCommandConfig(
        'node -e "process.stdin.destroy(); setTimeout(() => process.exit(0), 10)"',
      ),
      new JsonLogger(),
    );
    const session = createSession();

    const result = await runner.run(session);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("stdin write failed");
  });

  it("keeps CodexRunner.run on the one-shot execute-and-return path", async () => {
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:01.000Z",
      });

    try {
      const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

      await expect(runner.run(createSession())).resolves.toMatchObject({
        exitCode: 0,
        stdout: "ok",
      });
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("reports the spawned pid and aborts the runner child on shutdown", async () => {
    const runner = new GenericCommandRunner(
      createGenericCommandConfig(
        "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
      ),
      new JsonLogger(),
    );
    const session = createSession();
    const abortController = new AbortController();
    let spawnedPid = -1;

    const run = runner.run(session, {
      signal: abortController.signal,
      onEvent(event) {
        expect(event.kind).toBe("spawned");
        spawnedPid = event.pid;
        abortController.abort();
      },
    });

    await expect(run).rejects.toBeInstanceOf(RunnerAbortedError);
    expect(spawnedPid).toBeGreaterThan(0);
    await waitForExit(spawnedPid);
  });

  it("terminates the runner child if recording the spawn fails", async () => {
    const runner = new GenericCommandRunner(
      createGenericCommandConfig('node -e "setInterval(() => {}, 1000)"'),
      new JsonLogger(),
    );
    const session = createSession();
    let spawnedPid = -1;

    const run = runner.run(session, {
      onEvent: async (event: RunnerSpawnedEvent) => {
        spawnedPid = event.pid;
        throw new Error("persist failed");
      },
    });

    await expect(run).rejects.toMatchObject({
      message: "Failed to record runner spawn: persist failed",
    });
    expect(spawnedPid).toBeGreaterThan(0);
    await waitForExit(spawnedPid);
  });

  it("reports a timeout even when the runner must be SIGKILLed", async () => {
    const runner = new GenericCommandRunner(
      {
        ...createGenericCommandConfig(
          "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
        ),
        timeoutMs: 50,
      },
      new JsonLogger(),
    );
    const session = createSession();

    await expect(runner.run(session)).rejects.toMatchObject({
      message: "Runner timed out after 50ms",
    });
  });

  it("selects the newest matching Codex session by parsed timestamp", async () => {
    const tempHome = await createTempDir("symphony-local-runner-home-");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:05.000Z",
      });

    try {
      const sessionsRoot = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "03",
        "11",
      );
      await fs.mkdir(sessionsRoot, { recursive: true });
      await fs.writeFile(
        path.join(sessionsRoot, "z-session.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "older-session",
            timestamp: "2026-03-11T10:00:02.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionsRoot, "a-session.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "newer-session",
            timestamp: "2026-03-11T10:00:04.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );

      const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

      const liveSession = await runner.startSession(createSession());
      const result = await liveSession.runTurn({
        prompt: "initial prompt",
        turnNumber: 1,
      });

      expect(result.session.backendSessionId).toBe("newer-session");
    } finally {
      executeSpy.mockRestore();
      homedirSpy.mockRestore();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("skips malformed Codex session jsonl files during session discovery", async () => {
    const tempHome = await createTempDir("symphony-local-runner-home-");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:05.000Z",
      });

    try {
      const sessionsRoot = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "03",
        "11",
      );
      await fs.mkdir(sessionsRoot, { recursive: true });
      await fs.writeFile(
        path.join(sessionsRoot, "broken-session.jsonl"),
        "{not-json}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionsRoot, "good-session.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "good-session",
            timestamp: "2026-03-11T10:00:04.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );

      const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

      const liveSession = await runner.startSession(createSession());
      const result = await liveSession.runTurn({
        prompt: "initial prompt",
        turnNumber: 1,
      });

      expect(result.session.backendSessionId).toBe("good-session");
    } finally {
      executeSpy.mockRestore();
      homedirSpy.mockRestore();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("skips unreadable Codex session jsonl files during session discovery", async () => {
    const tempHome = await createTempDir("symphony-local-runner-home-");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:05.000Z",
      });

    try {
      const sessionsRoot = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "03",
        "11",
      );
      await fs.mkdir(sessionsRoot, { recursive: true });
      const unreadablePath = path.join(
        sessionsRoot,
        "unreadable-session.jsonl",
      );
      await fs.writeFile(
        unreadablePath,
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "unreadable-session",
            timestamp: "2026-03-11T10:00:03.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionsRoot, "good-session.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "good-session",
            timestamp: "2026-03-11T10:00:04.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );
      const readFileSpy = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (filePath, encoding) => {
          if (filePath === unreadablePath && encoding === "utf8") {
            const error = new Error(
              "permission denied",
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          return await vi
            .importActual<typeof import("node:fs/promises")>("node:fs/promises")
            .then((module) => module.readFile(filePath, encoding as "utf8"));
        });

      try {
        const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

        const liveSession = await runner.startSession(createSession());
        const result = await liveSession.runTurn({
          prompt: "initial prompt",
          turnNumber: 1,
        });

        expect(result.session.backendSessionId).toBe("good-session");
      } finally {
        readFileSpy.mockRestore();
      }
    } finally {
      executeSpy.mockRestore();
      homedirSpy.mockRestore();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("warns once when unsupported Codex continuation args are dropped", async () => {
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:05.000Z",
      });
    const warn = vi.fn<Logger["warn"]>();
    const logger: Logger = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const tempHome = await createTempDir("symphony-local-runner-home-");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      const sessionsRoot = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "03",
        "11",
      );
      await fs.mkdir(sessionsRoot, { recursive: true });
      await fs.writeFile(
        path.join(sessionsRoot, "match.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-03-11T10:00:01.000Z",
          payload: {
            id: "codex-session-1",
            timestamp: "2026-03-11T10:00:01.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );

      const runner = new CodexRunner(
        createCodexConfig({
          command:
            "codex exec --dangerously-bypass-approvals-and-sandbox --profile strict -m gpt-5.4 -C . -",
        }),
        logger,
      );
      const live = await runner.startSession!(createSession());

      await live.runTurn({ turnNumber: 1, prompt: "first" });
      await live.runTurn({ turnNumber: 2, prompt: "second" });
      await live.runTurn({ turnNumber: 3, prompt: "third" });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "Dropped unsupported Codex continuation arguments while building resume command",
        expect.objectContaining({
          droppedArgs: ["--profile", "strict", "-C", "."],
        }),
      );
      expect(
        (executeSpy.mock.calls[1]?.[2] as { command: string } | undefined)
          ?.command,
      ).not.toContain(" -C ");
    } finally {
      executeSpy.mockRestore();
      homedirSpy.mockRestore();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("drops unknown value-consuming flags as a pair during Codex resume reconstruction", async () => {
    const executeSpy = vi
      .spyOn(CodexRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:05.000Z",
      });
    const warn = vi.fn<Logger["warn"]>();
    const logger: Logger = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const tempHome = await createTempDir("symphony-local-runner-home-");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      const sessionsRoot = path.join(
        tempHome,
        ".codex",
        "sessions",
        "2026",
        "03",
        "11",
      );
      await fs.mkdir(sessionsRoot, { recursive: true });
      await fs.writeFile(
        path.join(sessionsRoot, "match.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-03-11T10:00:01.000Z",
          payload: {
            id: "codex-session-1",
            timestamp: "2026-03-11T10:00:01.000Z",
            cwd: process.cwd(),
            git: { branch: "symphony/1" },
          },
        })}\n`,
        "utf8",
      );

      const runner = new CodexRunner(
        createCodexConfig({
          command:
            "codex exec --dangerously-bypass-approvals-and-sandbox --profile --model -m gpt-5.4 -C . -",
        }),
        logger,
      );
      const live = await runner.startSession!(createSession());

      await live.runTurn({ turnNumber: 1, prompt: "first" });
      await live.runTurn({ turnNumber: 2, prompt: "second" });

      expect(warn).toHaveBeenCalledWith(
        "Dropped unsupported Codex continuation arguments while building resume command",
        expect.objectContaining({
          droppedArgs: ["--profile", "--model", "-C", "."],
        }),
      );
    } finally {
      executeSpy.mockRestore();
      homedirSpy.mockRestore();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("returns a rejected promise when Codex continuation is configured with file prompt transport", async () => {
    const runner = new CodexRunner(
      createCodexConfig({
        promptTransport: "file",
        maxTurns: 2,
      }),
      new JsonLogger(),
    );

    await expect(runner.startSession!(createSession())).rejects.toThrowError(
      "Codex continuation turns require agent.prompt_transport to be 'stdin'",
    );
  });

  it("rejects Codex runner construction when the command is not the codex CLI", () => {
    expect(
      () =>
        new CodexRunner(
          {
            ...createCodexConfig(),
            command: "claude --project-id xyz",
          },
          new JsonLogger(),
        ),
    ).toThrowError(
      "Codex runner requires agent.command to invoke the codex CLI",
    );
  });
});
