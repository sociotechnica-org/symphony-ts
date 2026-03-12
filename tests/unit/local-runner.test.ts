import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunSession } from "../../src/domain/run.js";
import type { AgentConfig } from "../../src/domain/workflow.js";
import { RunnerAbortedError } from "../../src/domain/errors.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import {
  buildClaudeResumeCommand,
  parseClaudeCodeResult,
} from "../../src/runner/claude-code-command.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { GenericCommandRunner } from "../../src/runner/generic-command.js";
import { describeLocalRunnerBackend } from "../../src/runner/local-command.js";
import type { RunnerSpawnedEvent } from "../../src/runner/service.js";
import { waitForExit } from "../support/process.js";
import { createTempDir } from "../support/git.js";
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
    prompt: "x".repeat(1024),
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

function createClaudeCodeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    runner: {
      kind: "claude-code",
    },
    command:
      "claude -p --output-format json --permission-mode bypassPermissions --model sonnet",
    promptTransport: "stdin",
    timeoutMs: 5_000,
    maxTurns: 3,
    env: {},
    ...overrides,
  };
}

async function createFakeCodexExecutable(): Promise<string> {
  const dir = await createTempDir("fake-codex-app-server-");
  const executablePath = path.join(dir, "codex");
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.FAKE_CODEX_MODE ?? "success";
const logFile = process.env.FAKE_CODEX_LOG_FILE ?? null;
let turnCount = 0;
const threadId = "thread-1";

function log(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(turnId) {
  if (mode === "hang") {
    return;
  }
  if (mode === "turn-failed") {
    send({
      method: "turn/failed",
      params: {
        threadId,
        turn: { id: turnId },
        message: "simulated failure",
      },
    });
    return;
  }
  if (mode === "malformed-stream") {
    process.stdout.write("not-json\\n");
  }
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId },
    },
  });
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected command: " + process.argv.slice(2).join(" "));
  process.exit(1);
}

process.on("SIGTERM", () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
  log(payload);

  if (payload.method === "initialize") {
    send({ id: payload.id, result: { userAgent: "fake-codex" } });
    return;
  }

  if (payload.method === "initialized") {
    return;
  }

  if (payload.method === "thread/start") {
    if (mode === "malformed-thread") {
      send({ id: payload.id, result: { thread: {} } });
      return;
    }
    send({
      id: payload.id,
      result: {
        approvalPolicy: "never",
        cwd: process.cwd(),
        model: "gpt-5.4",
        modelProvider: "openai",
        sandbox: { type: "dangerFullAccess" },
        thread: { id: threadId },
      },
    });
    return;
  }

  if (payload.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + String(turnCount);
    send({ id: payload.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: {
        threadId,
        turn: { id: turnId },
      },
    });
    setTimeout(() => completeTurn(turnId), 5);
  }
});
`,
    "utf8",
  );
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}

async function readLoggedPayloads(
  logFile: string,
): Promise<readonly Record<string, unknown>[]> {
  const raw = await fs.readFile(logFile, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runners", () => {
  it("describes Codex-backed sessions with provider and model metadata", () => {
    const runner = new CodexRunner(createCodexConfig(), new JsonLogger());

    expect(runner.describeSession(createSession())).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      appServerPid: null,
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
      backendThreadId: null,
      latestTurnId: null,
      appServerPid: null,
      latestTurnNumber: null,
      logPointers: [],
    });
  });

  it("describes Claude Code sessions with provider and model metadata", () => {
    const runner = new ClaudeCodeRunner(
      createClaudeCodeConfig(),
      new JsonLogger(),
    );

    expect(runner.describeSession(createSession())).toEqual({
      provider: "claude-code",
      model: "sonnet",
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      appServerPid: null,
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
    expect(result.stderr).not.toContain("Failed to write prompt");
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

  it("keeps ClaudeCodeRunner.run on the one-shot execute-and-return path", async () => {
    const executeSpy = vi
      .spyOn(ClaudeCodeRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "claude-session-1",
          modelUsage: {
            "claude-sonnet-4-5": {},
          },
        }),
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:01.000Z",
      });

    try {
      const runner = new ClaudeCodeRunner(
        createClaudeCodeConfig(),
        new JsonLogger(),
      );

      await expect(runner.run(createSession())).resolves.toMatchObject({
        exitCode: 0,
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

  it("reuses the Claude backend session id for continuation turns", async () => {
    const executeSpy = vi
      .spyOn(ClaudeCodeRunner, "executeCommand")
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "claude-session-1",
          modelUsage: {
            "claude-sonnet-4-5": {},
          },
        }),
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:01.000Z",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "claude-session-1",
          modelUsage: {
            "claude-sonnet-4-5": {},
          },
        }),
        stderr: "",
        startedAt: "2026-03-11T10:00:02.000Z",
        finishedAt: "2026-03-11T10:00:03.000Z",
      });

    try {
      const runner = new ClaudeCodeRunner(
        createClaudeCodeConfig(),
        new JsonLogger(),
      );
      const liveSession = await runner.startSession(createSession());

      const firstTurn = await liveSession.runTurn({
        turnNumber: 1,
        prompt: "first",
      });
      const secondTurn = await liveSession.runTurn({
        turnNumber: 2,
        prompt: "second",
      });

      expect(firstTurn.session.backendSessionId).toBe("claude-session-1");
      expect(secondTurn.session.backendSessionId).toBe("claude-session-1");
      expect(secondTurn.session.latestTurnNumber).toBe(2);
      expect(
        (executeSpy.mock.calls[1]?.[2] as { command: string } | undefined)
          ?.command,
      ).toContain("--resume claude-session-1");
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("fails when a Claude continuation turn is requested without a session id", async () => {
    const executeSpy = vi
      .spyOn(ClaudeCodeRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          modelUsage: {
            "claude-sonnet-4-5": {},
          },
        }),
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:01.000Z",
      });

    try {
      const runner = new ClaudeCodeRunner(
        createClaudeCodeConfig(),
        new JsonLogger(),
      );
      const liveSession = await runner.startSession(createSession());

      await liveSession.runTurn({
        turnNumber: 1,
        prompt: "first",
      });

      await expect(
        liveSession.runTurn({
          turnNumber: 2,
          prompt: "second",
        }),
      ).rejects.toThrowError(
        "Claude Code continuation turn requested but no backend session id was returned by the previous turn",
      );
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("drops session ids paired with prior Claude continue flags during resume reconstruction", () => {
    expect(
      buildClaudeResumeCommand(
        "claude --continue stale-session -p --output-format json --permission-mode bypassPermissions",
        "fresh-session",
      ),
    ).toBe(
      "claude --resume fresh-session -p --output-format json --permission-mode bypassPermissions",
    );

    expect(
      buildClaudeResumeCommand(
        "claude -c stale-session -p --output-format json --permission-mode bypassPermissions",
        "fresh-session",
      ),
    ).toBe(
      "claude --resume fresh-session -p --output-format json --permission-mode bypassPermissions",
    );
  });

  it("parses the Claude result object even when stdout has trailing non-JSON lines", () => {
    expect(
      parseClaudeCodeResult(
        [
          '{"type":"result","session_id":"claude-session-1","modelUsage":{"claude-sonnet-4-5":{}}}',
          "warning: trailing diagnostic",
        ].join("\n"),
      ),
    ).toEqual({
      sessionId: "claude-session-1",
      model: "claude-sonnet-4-5",
      modelCount: 1,
    });
  });

  it("warns when Claude reports multiple models in one turn", async () => {
    const logger: Logger = {
      info() {},
      warn: vi.fn(),
      error() {},
    };
    const executeSpy = vi
      .spyOn(ClaudeCodeRunner, "executeCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          session_id: "claude-session-1",
          modelUsage: {
            "claude-sonnet-4-5": {},
            "claude-haiku-4-5": {},
          },
        }),
        stderr: "",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: "2026-03-11T10:00:01.000Z",
      });

    try {
      const runner = new ClaudeCodeRunner(createClaudeCodeConfig(), logger);
      const liveSession = await runner.startSession(createSession());

      const result = await liveSession.runTurn({
        turnNumber: 1,
        prompt: "first",
      });

      expect(result.session.model).toBe("claude-sonnet-4-5");
      expect(logger.warn).toHaveBeenCalledWith(
        "Claude Code turn reported multiple models",
        expect.objectContaining({
          issueNumber: 1,
          turnNumber: 1,
          modelCount: 2,
          selectedModel: "claude-sonnet-4-5",
        }),
      );
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("starts Codex through app-server, reuses one thread, and derives session metadata", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const logFile = path.join(
      await createTempDir("fake-codex-log-"),
      "rpc.jsonl",
    );
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runner = new CodexRunner(
      createCodexConfig({
        command: `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox --profile strict -m gpt-5.4 -C . -`,
        env: {
          FAKE_CODEX_LOG_FILE: logFile,
        },
      }),
      logger,
    );
    const liveSession = await runner.startSession(createSession());
    let spawnedPid = -1;

    try {
      const firstTurn = await liveSession.runTurn(
        {
          turnNumber: 1,
          prompt: "first",
        },
        {
          onEvent(event) {
            spawnedPid = event.pid;
          },
        },
      );
      const secondTurn = await liveSession.runTurn({
        turnNumber: 2,
        prompt: "second",
      });

      expect(spawnedPid).toBeGreaterThan(0);
      expect(firstTurn.session.appServerPid).toBe(spawnedPid);
      expect(firstTurn.session.backendThreadId).toBe("thread-1");
      expect(firstTurn.session.latestTurnId).toBe("turn-1");
      expect(firstTurn.session.backendSessionId).toBe("thread-1-turn-1");
      expect(secondTurn.session.backendThreadId).toBe("thread-1");
      expect(secondTurn.session.latestTurnId).toBe("turn-2");
      expect(secondTurn.session.backendSessionId).toBe("thread-1-turn-2");
      expect(secondTurn.session.latestTurnNumber).toBe(2);
      expect(
        firstTurn.stdout.match(/"method":"turn\/completed"/g)?.length ?? 0,
      ).toBe(1);
      const payloads = await readLoggedPayloads(logFile);
      expect(payloads.map((entry) => entry["method"] ?? "unknown")).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "turn/start",
      ]);
      expect(
        payloads
          .filter((entry) => entry["method"] === "turn/start")
          .map((entry) => entry["id"]),
      ).toEqual([3, 4]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Dropped unsupported Codex exec arguments while building app-server launch command",
        expect.objectContaining({
          droppedArgs: ["--profile", "strict", "-C", "."],
        }),
      );
    } finally {
      await liveSession.close();
      if (spawnedPid > 0) {
        await waitForExit(spawnedPid);
      }
    }
  });

  it("omits unset optional thread/start fields from Codex app-server params", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const logFile = path.join(
      await createTempDir("fake-codex-log-"),
      "rpc.jsonl",
    );
    const runner = new CodexRunner(
      createCodexConfig({
        command: `${fakeCodex} exec -C . -`,
        env: {
          FAKE_CODEX_LOG_FILE: logFile,
        },
      }),
      new JsonLogger(),
    );
    const liveSession = await runner.startSession(createSession());

    try {
      await liveSession.runTurn({
        turnNumber: 1,
        prompt: "first",
      });

      const threadStart = (await readLoggedPayloads(logFile)).find(
        (entry) => entry["method"] === "thread/start",
      ) as { params?: Record<string, unknown> } | undefined;
      expect(threadStart).toBeDefined();
      expect(threadStart).toMatchObject({
        method: "thread/start",
        params: {
          cwd: process.cwd(),
        },
      });
      expect(threadStart?.params).not.toHaveProperty("approvalPolicy");
      expect(threadStart?.params).not.toHaveProperty("model");
      expect(threadStart?.params).not.toHaveProperty("sandbox");
    } finally {
      await liveSession.close();
    }
  });

  it("fails explicitly when Codex app-server returns an invalid thread payload", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const runner = new CodexRunner(
      createCodexConfig({
        command: `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -`,
        env: {
          FAKE_CODEX_MODE: "malformed-thread",
        },
      }),
      new JsonLogger(),
    );
    const liveSession = await runner.startSession(createSession());

    await expect(
      liveSession.runTurn({
        turnNumber: 1,
        prompt: "first",
      }),
    ).rejects.toThrowError(
      "Codex app-server returned an invalid thread/start response",
    );
  });

  it("ignores malformed non-terminal Codex stream lines after turn start", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runner = new CodexRunner(
      createCodexConfig({
        command: `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -`,
        env: {
          FAKE_CODEX_MODE: "malformed-stream",
        },
      }),
      logger,
    );
    const liveSession = await runner.startSession(createSession());

    const result = await liveSession.runTurn({
      turnNumber: 1,
      prompt: "first",
    });

    expect(result.exitCode).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "Ignoring malformed Codex app-server stream line",
      expect.objectContaining({
        line: "not-json",
      }),
    );
  });

  it("times out and cleans up the Codex app-server process", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const runner = new CodexRunner(
      createCodexConfig({
        command: `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -`,
        timeoutMs: 50,
        env: {
          FAKE_CODEX_MODE: "hang",
        },
      }),
      new JsonLogger(),
    );
    const liveSession = await runner.startSession(createSession());
    let spawnedPid = -1;

    await expect(
      liveSession.runTurn(
        {
          turnNumber: 1,
          prompt: "first",
        },
        {
          onEvent(event) {
            spawnedPid = event.pid;
          },
        },
      ),
    ).rejects.toThrowError("Runner timed out after 50ms");

    expect(spawnedPid).toBeGreaterThan(0);
    await waitForExit(spawnedPid);
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

  it("rejects Claude Code runner construction when the command is not the claude CLI", () => {
    expect(
      () =>
        new ClaudeCodeRunner(
          {
            ...createClaudeCodeConfig(),
            command:
              "codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -",
          },
          new JsonLogger(),
        ),
    ).toThrowError(
      "Claude Code runner requires agent.command to invoke the claude CLI",
    );
  });

  it("rejects Claude Code runner construction when the command is missing JSON print mode", () => {
    expect(
      () =>
        new ClaudeCodeRunner(
          {
            ...createClaudeCodeConfig(),
            command: "claude --permission-mode bypassPermissions",
          },
          new JsonLogger(),
        ),
    ).toThrowError(
      "Claude Code runner requires agent.command to include --print",
    );

    expect(
      () =>
        new ClaudeCodeRunner(
          {
            ...createClaudeCodeConfig(),
            command:
              "claude -p --output-format text --permission-mode bypassPermissions",
          },
          new JsonLogger(),
        ),
    ).toThrowError(
      "Claude Code runner requires agent.command to include --output-format json",
    );
  });

  it("rejects Claude Code continuation sessions configured with file prompt transport", () => {
    expect(
      () =>
        new ClaudeCodeRunner(
          {
            ...createClaudeCodeConfig(),
            promptTransport: "file",
          },
          new JsonLogger(),
        ),
    ).toThrowError(
      "Claude Code runner requires agent.prompt_transport to be 'stdin'",
    );
  });
});
