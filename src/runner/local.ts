import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RunnerAbortedError, RunnerError } from "../domain/errors.js";
import type { RunResult, RunSession, RunTurn } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type {
  LiveRunnerSession,
  Runner,
  RunnerRunOptions,
  RunnerSessionDescription,
  RunnerTurnResult,
} from "./service.js";
import {
  describeLocalRunnerBackend,
  parseLocalRunnerCommand,
  quoteShellToken,
} from "./local-command.js";

const CODEX_SESSION_MATCH_WINDOW_MS = 10 * 60 * 1000;

interface LocalCommandExecutionOptions {
  readonly command: string;
  readonly prompt: string;
  readonly session: RunSession;
  readonly turnNumber: number;
  readonly options: RunnerRunOptions | undefined;
  readonly promptTransport: AgentConfig["promptTransport"];
}

interface CodexSessionMatch {
  readonly id: string;
  readonly filePath: string;
  readonly timestampMs: number;
}

export class LocalRunner implements Runner {
  static readonly #terminationGraceMs = 200;
  readonly #config: AgentConfig;
  readonly #logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  describeSession(_session: RunSession): RunnerSessionDescription {
    const backend = describeLocalRunnerBackend(this.#config.command);
    return {
      provider: backend.provider,
      model: backend.model,
      backendSessionId: null,
      latestTurnNumber: null,
      logPointers: [],
    };
  }

  startSession(session: RunSession): Promise<LiveRunnerSession> {
    return Promise.resolve(
      new LocalRunnerSession(this.#config, this.#logger, session),
    );
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunResult> {
    const liveSession = await this.startSession(session);
    const result = await liveSession.runTurn(
      {
        prompt: session.prompt,
        turnNumber: 1,
      },
      options,
    );
    return result;
  }

  static async executeCommand(
    logger: Logger,
    config: AgentConfig,
    execution: LocalCommandExecutionOptions,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const promptFile = path.join(
      execution.session.workspace.path,
      `.symphony-prompt.turn-${execution.turnNumber.toString()}.md`,
    );

    if (execution.promptTransport === "file") {
      await fs.writeFile(promptFile, execution.prompt, "utf8");
    }

    const command =
      execution.promptTransport === "file"
        ? `${execution.command} ${JSON.stringify(promptFile)}`
        : execution.command;

    logger.info("Launching runner", {
      command,
      workspacePath: execution.session.workspace.path,
      issueIdentifier: execution.session.issue.identifier,
      attempt: execution.session.attempt.sequence,
      runSessionId: execution.session.id,
      turnNumber: execution.turnNumber,
    });

    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: execution.session.workspace.path,
        env: {
          ...process.env,
          ...config.env,
          SYMPHONY_ISSUE_ID: execution.session.issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: execution.session.issue.identifier,
          SYMPHONY_ISSUE_NUMBER: String(execution.session.issue.number),
          SYMPHONY_RUN_ATTEMPT: String(execution.session.attempt.sequence),
          SYMPHONY_RUN_TURN: String(execution.turnNumber),
          SYMPHONY_BRANCH_NAME: execution.session.workspace.branchName,
          SYMPHONY_WORKSPACE_PATH: execution.session.workspace.path,
          SYMPHONY_RUN_SESSION_ID: execution.session.id,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let spawnError: RunnerError | null = null;
      let forcedKillTimeout: NodeJS.Timeout | null = null;
      let spawnNotificationPromise: Promise<void> = Promise.resolve();

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forcedKillTimeout !== null) {
          clearTimeout(forcedKillTimeout);
          forcedKillTimeout = null;
        }
        execution.options?.signal?.removeEventListener("abort", handleAbort);
        callback();
      };

      const terminateChild = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill("SIGTERM");
        if (forcedKillTimeout !== null) {
          return;
        }
        forcedKillTimeout = setTimeout(() => {
          forcedKillTimeout = null;
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, LocalRunner.#terminationGraceMs);
      };

      const handleAbort = (): void => {
        if (!timedOut) {
          aborted = true;
        }
        terminateChild();
      };

      const handleSpawnFailure = (error: unknown): void => {
        if (spawnError !== null) {
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        spawnError = new RunnerError(
          `Failed to record runner spawn: ${reason}`,
          {
            cause: error instanceof Error ? error : new Error(reason),
          },
        );
        terminateChild();
      };

      if (child.pid !== undefined) {
        try {
          spawnNotificationPromise = Promise.resolve(
            execution.options?.onSpawn?.({
              pid: child.pid,
              spawnedAt: new Date().toISOString(),
            }),
          ).catch((error) => {
            handleSpawnFailure(error);
          });
        } catch (error) {
          handleSpawnFailure(error);
        }
      }

      if (execution.options?.signal?.aborted) {
        handleAbort();
      } else {
        execution.options?.signal?.addEventListener("abort", handleAbort, {
          once: true,
        });
      }

      const handleStdinError = (error: NodeJS.ErrnoException): void => {
        if (
          error.code === "EPIPE" ||
          error.code === "ERR_STREAM_DESTROYED" ||
          error.code === "EOF"
        ) {
          stderr += `\nstdin write failed: ${error.message}`;
          return;
        }
        finish(() => {
          reject(
            new RunnerError(`Failed to write prompt to runner stdin`, {
              cause: error,
            }),
          );
        });
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, config.timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.stdin.on("error", handleStdinError);
      child.on("error", (error) => {
        finish(() => {
          reject(
            new RunnerError(`Failed to launch runner command: ${command}`, {
              cause: error,
            }),
          );
        });
      });
      child.on("close", (exitCode) => {
        void spawnNotificationPromise.finally(() => {
          finish(() => {
            const finishedAt = new Date().toISOString();
            if (timedOut) {
              reject(
                new RunnerError(`Runner timed out after ${config.timeoutMs}ms`),
              );
              return;
            }
            if (aborted) {
              reject(new RunnerAbortedError(`Runner cancelled by shutdown`));
              return;
            }
            if (spawnError !== null) {
              reject(spawnError);
              return;
            }
            resolve({
              exitCode: exitCode ?? 1,
              stdout,
              stderr,
              startedAt,
              finishedAt,
            });
          });
        });
      });

      if (execution.promptTransport === "stdin") {
        child.stdin.end(execution.prompt);
        return;
      }
      child.stdin.end();
    });
  }
}

class LocalRunnerSession implements LiveRunnerSession {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #runSession: RunSession;
  readonly #baseDescription: RunnerSessionDescription;
  #backendSessionId: string | null = null;
  #latestTurnNumber: number | null = null;

  constructor(config: AgentConfig, logger: Logger, session: RunSession) {
    this.#config = config;
    this.#logger = logger;
    this.#runSession = session;
    this.#baseDescription = {
      ...new LocalRunner(config, logger).describeSession(session),
    };
  }

  describe(): RunnerSessionDescription {
    return {
      ...this.#baseDescription,
      backendSessionId: this.#backendSessionId,
      latestTurnNumber: this.#latestTurnNumber,
    };
  }

  async runTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    const executionResult = await LocalRunner.executeCommand(
      this.#logger,
      this.#config,
      {
        command: this.#commandForTurn(turn),
        prompt: turn.prompt,
        session: this.#runSession,
        turnNumber: turn.turnNumber,
        options,
        promptTransport: this.#promptTransportForTurn(turn),
      },
    );

    if (
      executionResult.exitCode === 0 &&
      this.#baseDescription.provider === "codex" &&
      this.#backendSessionId === null
    ) {
      const matchedSession = await findCodexSession({
        workspacePath: this.#runSession.workspace.path,
        branchName: this.#runSession.workspace.branchName,
        startedAt: executionResult.startedAt,
        finishedAt: executionResult.finishedAt,
      });
      if (matchedSession === null) {
        throw new RunnerError(
          "Codex turn completed but no reusable backend session id was found",
        );
      }
      this.#backendSessionId = matchedSession.id;
    }

    if (executionResult.exitCode === 0) {
      this.#latestTurnNumber = turn.turnNumber;
    }

    return {
      ...executionResult,
      session: this.describe(),
    };
  }

  #promptTransportForTurn(turn: RunTurn): AgentConfig["promptTransport"] {
    if (turn.turnNumber === 1 || this.#baseDescription.provider !== "codex") {
      return this.#config.promptTransport;
    }
    if (this.#config.promptTransport !== "stdin") {
      throw new RunnerError(
        "Codex continuation turns require agent.prompt_transport to be 'stdin'",
      );
    }
    return "stdin";
  }

  #commandForTurn(turn: RunTurn): string {
    if (turn.turnNumber === 1 || this.#baseDescription.provider !== "codex") {
      return this.#config.command;
    }
    if (this.#backendSessionId === null) {
      throw new RunnerError(
        "Cannot start a Codex continuation turn without a backend session id",
      );
    }
    return buildCodexResumeCommand(
      this.#config.command,
      this.#backendSessionId,
    );
  }
}

function buildCodexResumeCommand(command: string, sessionId: string): string {
  const parsed = parseLocalRunnerCommand(command);
  if (
    parsed.executable === null ||
    path.basename(parsed.executable) !== "codex" ||
    parsed.executableIndex < 0
  ) {
    throw new RunnerError(
      "Cannot build a Codex resume command from a non-Codex runner",
    );
  }

  const prefix = parsed.tokens.slice(0, parsed.executableIndex);
  const executable = parsed.tokens[parsed.executableIndex];
  const args = parsed.tokens.slice(parsed.executableIndex + 1);
  const execCommand = args[0];
  if (execCommand !== "exec" && execCommand !== "e") {
    throw new RunnerError(
      "Codex continuation turns require the runner command to start with 'codex exec'",
    );
  }

  const forwardedArgs = filterCodexResumeArgs(args.slice(1));
  const quoted = [
    ...prefix,
    executable,
    "exec",
    "resume",
    ...forwardedArgs,
    sessionId,
    "-",
  ].map((token) => quoteShellToken(token ?? ""));
  return quoted.join(" ");
}

function filterCodexResumeArgs(args: readonly string[]): readonly string[] {
  const filtered: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "-") {
      continue;
    }
    if (token === "--json") {
      continue;
    }
    if (
      token === "-c" ||
      token === "--config" ||
      token === "--enable" ||
      token === "--disable" ||
      token === "-i" ||
      token === "--image" ||
      token === "-m" ||
      token === "--model" ||
      token === "-o" ||
      token === "--output-last-message"
    ) {
      const value = args[index + 1];
      if (value !== undefined) {
        filtered.push(token, value);
        index += 1;
      }
      continue;
    }
    if (
      token === "--full-auto" ||
      token === "--dangerously-bypass-approvals-and-sandbox" ||
      token === "--skip-git-repo-check" ||
      token === "--ephemeral"
    ) {
      filtered.push(token);
      continue;
    }
    if (
      token.startsWith("--config=") ||
      token.startsWith("--enable=") ||
      token.startsWith("--disable=") ||
      token.startsWith("--image=") ||
      token.startsWith("--model=") ||
      token.startsWith("--output-last-message=")
    ) {
      filtered.push(token);
    }
  }

  return filtered;
}

async function findCodexSession(input: {
  readonly workspacePath: string;
  readonly branchName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}): Promise<CodexSessionMatch | null> {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const candidateRoots = deriveCandidateDayRoots(
    sessionsRoot,
    input.startedAt,
    input.finishedAt,
  );
  const matches: CodexSessionMatch[] = [];

  for (const root of candidateRoots) {
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(root, entry.name);
      const match = await parseCodexSessionMeta(filePath);
      if (match === null) {
        continue;
      }
      if (
        path.resolve(match.cwd) !== path.resolve(input.workspacePath) ||
        (match.branch !== null && match.branch !== input.branchName)
      ) {
        continue;
      }
      const metaTimestamp = Date.parse(match.timestamp);
      const sessionStart = Date.parse(input.startedAt);
      const sessionFinish = Date.parse(input.finishedAt);
      if (
        Number.isNaN(metaTimestamp) ||
        Number.isNaN(sessionStart) ||
        Number.isNaN(sessionFinish)
      ) {
        continue;
      }
      const lowerBound = sessionStart - CODEX_SESSION_MATCH_WINDOW_MS;
      const upperBound = sessionFinish + CODEX_SESSION_MATCH_WINDOW_MS;
      if (metaTimestamp < lowerBound || metaTimestamp > upperBound) {
        continue;
      }
      matches.push({
        id: match.id,
        filePath,
        timestampMs: metaTimestamp,
      });
    }
  }

  return (
    matches
      .sort((left, right) => {
        if (left.timestampMs !== right.timestampMs) {
          return left.timestampMs - right.timestampMs;
        }
        return left.filePath.localeCompare(right.filePath);
      })
      .at(-1) ?? null
  );
}

async function parseCodexSessionMeta(filePath: string): Promise<{
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly branch: string | null;
} | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record["type"] !== "session_meta") {
    return null;
  }
  const payload = asRecord(record["payload"]);
  const git = asRecord(payload?.["git"]);
  const id = asString(payload?.["id"]);
  const timestamp =
    asString(payload?.["timestamp"]) ?? asString(record["timestamp"]);
  const cwd = asString(payload?.["cwd"]);
  if (id === null || timestamp === null || cwd === null) {
    return null;
  }
  return {
    id,
    timestamp,
    cwd,
    branch: asString(git?.["branch"]),
  };
}

function deriveCandidateDayRoots(
  sessionsRoot: string,
  startedAt: string,
  finishedAt: string,
): readonly string[] {
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  const anchors = [
    startMs,
    finishMs,
    startMs - 24 * 60 * 60 * 1000,
    finishMs + 24 * 60 * 60 * 1000,
  ]
    .filter((value) => Number.isFinite(value))
    .map((value) => value as number);
  return [
    ...new Set(
      anchors.map((value) => path.join(sessionsRoot, formatDatePath(value))),
    ),
  ];
}

function formatDatePath(timestampMs: number): string {
  const date = new Date(timestampMs);
  return path.join(
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
