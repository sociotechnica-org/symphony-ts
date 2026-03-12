import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RunnerAbortedError, RunnerError } from "../domain/errors.js";
import type { RunSession, RunTurn } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { describeLocalRunnerSession } from "./local-session-description.js";
import {
  buildCodexAppServerCommand,
  type CodexAppServerCommand,
} from "./codex-app-server-command.js";
import type {
  LiveRunnerSession,
  RunnerEvent,
  RunnerRunOptions,
  RunnerSessionDescription,
  RunnerTurnResult,
} from "./service.js";

const INITIALIZE_REQUEST_ID = 1;
const THREAD_START_REQUEST_ID = 2;
const TURN_START_REQUEST_ID = 3;
const TERMINATION_GRACE_MS = 200;

interface PendingResponse {
  readonly id: number;
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveTurn {
  readonly turnNumber: number;
  readonly startedAt: string;
  stdout: string;
  stderr: string;
  readonly resolve: (result: RunnerTurnResult) => void;
  readonly reject: (error: Error) => void;
}

export class CodexAppServerSession implements LiveRunnerSession {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #runSession: RunSession;
  readonly #baseDescription: RunnerSessionDescription;
  readonly #appServerCommand: CodexAppServerCommand;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closePromise: Promise<void> | null = null;
  #closeResolve: (() => void) | null = null;
  #closeReject: ((error: Error) => void) | null = null;
  #pendingResponse: PendingResponse | null = null;
  #activeTurn: ActiveTurn | null = null;
  #stdoutBuffer = "";
  #threadId: string | null = null;
  #latestTurnId: string | null = null;
  #latestTurnNumber: number | null = null;
  #appServerPid: number | null = null;
  #loggedDroppedArgs = false;
  #closingReason: "timeout" | "aborted" | null = null;

  constructor(config: AgentConfig, logger: Logger, session: RunSession) {
    this.#config = config;
    this.#logger = logger;
    this.#runSession = session;
    this.#baseDescription = describeLocalRunnerSession(config.command);
    this.#appServerCommand = buildCodexAppServerCommand(config.command);
  }

  describe(): RunnerSessionDescription {
    return {
      ...this.#baseDescription,
      backendSessionId:
        this.#threadId !== null && this.#latestTurnId !== null
          ? `${this.#threadId}-${this.#latestTurnId}`
          : null,
      backendThreadId: this.#threadId,
      latestTurnId: this.#latestTurnId,
      appServerPid: this.#appServerPid,
      latestTurnNumber: this.#latestTurnNumber,
    };
  }

  async runTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    let abortReject: ((error: Error) => void) | null = null;
    let timeoutReject!: (error: Error) => void;

    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortReject = reject;
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutReject = reject;
    });
    const handleAbort = (): void => {
      this.#closingReason = "aborted";
      void this.close().finally(() => {
        abortReject?.(new RunnerAbortedError("Runner cancelled by shutdown"));
      });
    };
    const timeoutHandle = setTimeout(() => {
      this.#closingReason = "timeout";
      void this.close().finally(() => {
        timeoutReject(
          new RunnerError(`Runner timed out after ${this.#config.timeoutMs}ms`),
        );
      });
    }, this.#config.timeoutMs);

    try {
      if (options?.signal?.aborted) {
        handleAbort();
      } else {
        options?.signal?.addEventListener("abort", handleAbort, { once: true });
      }

      const runPromise = (async (): Promise<RunnerTurnResult> => {
        await this.#ensureStarted(options);
        return await this.#startTurn(turn, options);
      })();
      return await Promise.race([runPromise, timeoutPromise, abortPromise]);
    } finally {
      clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", handleAbort);
    }
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      return;
    }
    if (this.#closePromise === null) {
      this.#closePromise = new Promise<void>((resolve, reject) => {
        this.#closeResolve = resolve;
        this.#closeReject = reject;
      });
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, TERMINATION_GRACE_MS);
    }
    await this.#closePromise;
  }

  async #ensureStarted(options?: RunnerRunOptions): Promise<void> {
    if (this.#threadId !== null) {
      return;
    }
    if (this.#activeTurn !== null || this.#pendingResponse !== null) {
      throw new RunnerError("Codex app-server session is already starting");
    }

    if (this.#child === null) {
      this.#spawnProcess(options?.onEvent);
    }

    await this.#sendInitialize();
    await this.#sendNotification({ method: "initialized", params: {} });
    await this.#startThread();
  }

  #spawnProcess(onEvent?: (event: RunnerEvent) => void | Promise<void>): void {
    if (
      !this.#loggedDroppedArgs &&
      this.#appServerCommand.droppedArgs.length > 0
    ) {
      this.#logger.warn(
        "Dropped unsupported Codex exec arguments while building app-server launch command",
        {
          runSessionId: this.#runSession.id,
          droppedArgs: this.#appServerCommand.droppedArgs,
        },
      );
      this.#loggedDroppedArgs = true;
    }

    const child = spawn("bash", ["-lc", this.#appServerCommand.launchCommand], {
      cwd: this.#runSession.workspace.path,
      env: {
        ...process.env,
        ...this.#config.env,
        SYMPHONY_ISSUE_ID: this.#runSession.issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: this.#runSession.issue.identifier,
        SYMPHONY_ISSUE_NUMBER: String(this.#runSession.issue.number),
        SYMPHONY_RUN_ATTEMPT: String(this.#runSession.attempt.sequence),
        SYMPHONY_BRANCH_NAME: this.#runSession.workspace.branchName,
        SYMPHONY_WORKSPACE_PATH: this.#runSession.workspace.path,
        SYMPHONY_RUN_SESSION_ID: this.#runSession.id,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child = child;
    this.#appServerPid = child.pid ?? null;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#closeResolve = resolve;
      this.#closeReject = reject;
    });

    if (child.pid !== undefined) {
      Promise.resolve(
        onEvent?.({
          kind: "spawned",
          pid: child.pid,
          spawnedAt: new Date().toISOString(),
        }),
      ).catch((error) => {
        void this.close().finally(() => {
          this.#rejectActiveState(
            new RunnerError(
              `Failed to record runner spawn: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        });
      });
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#handleStdoutChunk(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (this.#activeTurn !== null) {
        this.#activeTurn.stderr += text;
      }
    });
    child.on("error", (error) => {
      this.#rejectActiveState(
        new RunnerError(`Failed to launch codex app-server`, { cause: error }),
      );
    });
    child.on("close", (exitCode, signalCode) => {
      const error =
        this.#closingReason === null &&
        (this.#activeTurn !== null || this.#pendingResponse !== null)
          ? new RunnerError(
              `Codex app-server exited before the active request completed (exit=${String(
                exitCode,
              )}, signal=${String(signalCode)})`,
            )
          : null;
      if (error !== null) {
        this.#rejectActiveState(error);
      }
      this.#child = null;
      this.#closeResolve?.();
      this.#closeResolve = null;
      this.#closeReject = null;
      this.#closePromise = null;
      this.#closingReason = null;
    });
  }

  async #sendInitialize(): Promise<void> {
    await this.#sendRequest({
      id: INITIALIZE_REQUEST_ID,
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
        },
        clientInfo: {
          name: "symphony-ts",
          title: "Symphony TypeScript",
          version: "0.1.0",
        },
      },
    });
  }

  async #startThread(): Promise<void> {
    const result = await this.#sendRequest({
      id: THREAD_START_REQUEST_ID,
      method: "thread/start",
      params: {
        approvalPolicy: this.#appServerCommand.approvalPolicy,
        cwd: this.#runSession.workspace.path,
        model: this.#appServerCommand.model,
        sandbox: this.#appServerCommand.sandbox,
      },
    });

    const thread = asRecord(result["thread"]);
    const threadId = typeof thread?.["id"] === "string" ? thread["id"] : null;
    if (threadId === null) {
      throw new RunnerError(
        "Codex app-server returned an invalid thread/start response",
      );
    }
    this.#threadId = threadId;
  }

  async #startTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    if (this.#threadId === null) {
      throw new RunnerError("Codex app-server session has no active thread");
    }
    if (this.#activeTurn !== null) {
      throw new RunnerError("Codex app-server already has an active turn");
    }

    const startedAt = new Date().toISOString();
    const result = await new Promise<RunnerTurnResult>((resolve, reject) => {
      this.#activeTurn = {
        turnNumber: turn.turnNumber,
        startedAt,
        stdout: "",
        stderr: "",
        resolve,
        reject,
      };
      void this.#sendRequest({
        id: TURN_START_REQUEST_ID,
        method: "turn/start",
        params: {
          threadId: this.#threadId,
          cwd: this.#runSession.workspace.path,
          input: [
            {
              type: "text",
              text: turn.prompt,
            },
          ],
        },
      })
        .then((response) => {
          const turnPayload = asRecord(response["turn"]);
          const turnId =
            typeof turnPayload?.["id"] === "string" ? turnPayload["id"] : null;
          if (turnId === null) {
            this.#rejectActiveTurn(
              new RunnerError(
                "Codex app-server returned an invalid turn/start response",
              ),
            );
            return;
          }
          this.#latestTurnId = turnId;
        })
        .catch((error) => {
          this.#rejectActiveTurn(error);
        });
    });

    if (options?.signal?.aborted) {
      throw new RunnerAbortedError("Runner cancelled by shutdown");
    }

    return result;
  }

  async #sendRequest(request: {
    readonly id: number;
    readonly method: string;
    readonly params: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (this.#pendingResponse !== null) {
      throw new RunnerError("Codex app-server request already in flight");
    }
    await this.#writeMessage(request);
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pendingResponse = {
        id: request.id,
        method: request.method,
        resolve,
        reject,
      };
    });
  }

  async #sendNotification(message: {
    readonly method: string;
    readonly params: Record<string, unknown>;
  }): Promise<void> {
    await this.#writeMessage(message);
  }

  async #writeMessage(message: Record<string, unknown>): Promise<void> {
    const child = this.#child;
    if (child === null) {
      throw new RunnerError("Codex app-server process is not running");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => {
        if (error !== undefined && error !== null) {
          reject(
            new RunnerError("Failed to write to codex app-server stdin", {
              cause: error,
            }),
          );
          return;
        }
        resolve();
      });
    });
  }

  #handleStdoutChunk(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.#stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.#stdoutBuffer
        .slice(0, newlineIndex)
        .replace(/\r$/u, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      this.#handleStdoutLine(line);
    }
  }

  #handleStdoutLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    if (this.#activeTurn !== null) {
      this.#activeTurn.stdout += `${line}\n`;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      if (this.#pendingResponse !== null || this.#threadId === null) {
        this.#rejectActiveState(
          new RunnerError(`Codex app-server returned malformed JSON: ${line}`),
        );
        return;
      }
      this.#logger.warn("Ignoring malformed Codex app-server stream line", {
        runSessionId: this.#runSession.id,
        line,
      });
      return;
    }

    const message = asRecord(payload);
    if (message === null) {
      return;
    }
    if (message["id"] !== undefined) {
      this.#handleResponse(message);
      return;
    }
    this.#handleNotification(message, line);
  }

  #handleResponse(message: Record<string, unknown>): void {
    const pending = this.#pendingResponse;
    if (pending === null) {
      return;
    }
    if (message["id"] !== pending.id) {
      return;
    }
    this.#pendingResponse = null;
    if (message["error"] !== undefined) {
      pending.reject(
        new RunnerError(
          `Codex app-server request '${pending.method}' failed: ${JSON.stringify(
            message["error"],
          )}`,
        ),
      );
      return;
    }
    const result = asRecord(message["result"]);
    if (result === null) {
      pending.reject(
        new RunnerError(
          `Codex app-server request '${pending.method}' returned an invalid result payload`,
        ),
      );
      return;
    }
    pending.resolve(result);
  }

  #handleNotification(message: Record<string, unknown>, rawLine: string): void {
    const method =
      typeof message["method"] === "string" ? message["method"] : null;
    const params = asRecord(message["params"]);
    if (method === null || params === null) {
      return;
    }

    if (method === "turn/started") {
      const turnPayload = asRecord(params["turn"]);
      const turnId =
        typeof turnPayload?.["id"] === "string" ? turnPayload["id"] : null;
      if (turnId !== null) {
        this.#latestTurnId = turnId;
      }
      return;
    }

    if (method === "turn/completed") {
      this.#resolveActiveTurn(rawLine);
      return;
    }

    if (method === "turn/failed" || method === "turn/cancelled") {
      this.#rejectActiveTurn(
        new RunnerError(
          `Codex app-server reported ${method}: ${JSON.stringify(params)}`,
        ),
      );
      return;
    }
  }

  #resolveActiveTurn(rawLine: string): void {
    const activeTurn = this.#activeTurn;
    if (activeTurn === null) {
      return;
    }
    activeTurn.stdout += `${rawLine}\n`;
    this.#latestTurnNumber = activeTurn.turnNumber;
    this.#activeTurn = null;
    activeTurn.resolve({
      exitCode: 0,
      stdout: activeTurn.stdout,
      stderr: activeTurn.stderr,
      startedAt: activeTurn.startedAt,
      finishedAt: new Date().toISOString(),
      session: this.describe(),
    });
  }

  #rejectActiveTurn(error: unknown): void {
    const activeTurn = this.#activeTurn;
    if (activeTurn === null) {
      this.#rejectActiveState(asError(error));
      return;
    }
    this.#activeTurn = null;
    activeTurn.reject(asError(error));
  }

  #rejectActiveState(error: Error): void {
    if (this.#pendingResponse !== null) {
      const pending = this.#pendingResponse;
      this.#pendingResponse = null;
      pending.reject(error);
    }
    if (this.#activeTurn !== null) {
      const activeTurn = this.#activeTurn;
      this.#activeTurn = null;
      activeTurn.reject(error);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new RunnerError(String(error));
}
