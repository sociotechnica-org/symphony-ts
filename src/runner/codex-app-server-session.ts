import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RunnerError, RunnerShutdownError } from "../domain/errors.js";
import type { RunSession, RunTurn, RunUpdateEvent } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { describeLocalRunnerSession } from "./local-session-description.js";
import { requireLocalWorkspacePath } from "./local-execution.js";
import { parseRunUpdateEvent } from "./run-update-event.js";
import {
  buildCodexAppServerCommand,
  type CodexAppServerCommand,
} from "./codex-app-server-command.js";
import {
  CodexAppServerTransportError,
  classifyCodexAppServerMessage,
  createCodexApprovalResponse,
  createCodexDynamicToolCallResponse,
  createCodexInvalidParamsResponse,
  createCodexUnsupportedRequestResponse,
  extractCodexDynamicToolCallRequest,
  extractCodexApprovalRequest,
  formatCodexTransportError,
  type CodexDynamicToolCallRequest,
  type CodexAppServerFailureClass,
  type CodexAppServerRequestMessage,
  type CodexAppServerSessionState,
} from "./codex-app-server-protocol.js";
import type { DynamicToolExecutor } from "./dynamic-tool-executor.js";
import {
  RUNNER_SHUTDOWN_GRACE_MS,
  summarizeRunnerText,
  withRunnerTransportLocalProcess,
  type RunnerTransportMetadata,
} from "./service.js";
import type {
  LiveRunnerSession,
  RunnerEvent,
  RunnerRunOptions,
  RunnerSessionDescription,
  RunnerTurnResult,
  RunnerVisibilitySnapshot,
} from "./service.js";

const INITIALIZE_REQUEST_ID = 1;
const THREAD_START_REQUEST_ID = 2;
const TURN_START_FIRST_REQUEST_ID = 3;
const CLOSE_TIMEOUT_MS = 5_000;
const STARTUP_STDERR_LIMIT = 4_096;

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
  readonly #dynamicToolExecutor: DynamicToolExecutor;
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
  #sessionState: CodexAppServerSessionState = "idle";
  #transportFailureClass: CodexAppServerFailureClass | null = null;
  #forcedShutdown = false;
  #closeTimersScheduled = false;
  #nextTurnStartRequestId = TURN_START_FIRST_REQUEST_ID;
  #startupStderr = "";
  #currentOnEvent: ((event: RunnerEvent) => void | Promise<void>) | null = null;
  #currentOnUpdate: ((event: RunUpdateEvent) => void) | null = null;
  #activeToolCall: {
    readonly requestId: string | number;
    readonly tool: string;
    readonly callId: string;
  } | null = null;

  constructor(
    config: AgentConfig,
    logger: Logger,
    session: RunSession,
    dynamicToolExecutor: DynamicToolExecutor,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#runSession = session;
    this.#dynamicToolExecutor = dynamicToolExecutor;
    this.#baseDescription = describeLocalRunnerSession(
      config.command,
      "local-stdio-session",
    );
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
      transport: this.#describeTransport(),
      latestTurnNumber: this.#latestTurnNumber,
    };
  }

  #describeTransport(): RunnerTransportMetadata {
    return withRunnerTransportLocalProcess(
      this.#baseDescription.transport,
      this.#appServerPid,
    );
  }

  async runTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    if (options?.signal?.aborted) {
      throw new RunnerShutdownError("Runner cancelled by shutdown", "graceful");
    }

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
        abortReject?.(
          new RunnerShutdownError(
            "Runner cancelled by shutdown",
            this.#forcedShutdown ? "forced" : "graceful",
          ),
        );
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
      this.#currentOnEvent = options?.onEvent ?? null;
      this.#currentOnUpdate = options?.onUpdate ?? null;
      options?.signal?.addEventListener("abort", handleAbort, { once: true });
      await this.#emitVisibility({
        state: "starting",
        phase: "session-start",
        lastHeartbeatAt: new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        lastActionSummary: "Starting Codex app-server session",
      });

      const runPromise = (async (): Promise<RunnerTurnResult> => {
        await this.#ensureStarted(options);
        return await this.#startTurn(turn, options);
      })();
      return await Promise.race([runPromise, timeoutPromise, abortPromise]);
    } finally {
      this.#currentOnEvent = null;
      this.#currentOnUpdate = null;
      clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", handleAbort);
    }
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      this.#sessionState = "closed";
      return;
    }
    this.#sessionState = "closing";
    if (this.#closePromise === null) {
      this.#closePromise = new Promise<void>((resolve, reject) => {
        this.#closeResolve = resolve;
        this.#closeReject = reject;
      });
    }
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !this.#closeTimersScheduled
    ) {
      this.#closeTimersScheduled = true;
      this.#forcedShutdown = false;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          if (this.#closingReason === "aborted") {
            this.#forcedShutdown = true;
          }
          child.kill("SIGKILL");
        }
      }, RUNNER_SHUTDOWN_GRACE_MS);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.#closeReject?.(
            this.#createTransportError(
              "startup-transport-failure",
              `Codex app-server did not exit after ${CLOSE_TIMEOUT_MS}ms`,
            ),
          );
          this.#closeReject = null;
          this.#closeResolve = null;
          this.#closePromise = null;
          this.#closeTimersScheduled = false;
        }
      }, CLOSE_TIMEOUT_MS);
    }
    await this.#closePromise;
  }

  async #ensureStarted(options?: RunnerRunOptions): Promise<void> {
    if (this.#threadId !== null) {
      this.#sessionState = "ready";
      return;
    }
    if (this.#activeTurn !== null || this.#pendingResponse !== null) {
      throw new RunnerError("Codex app-server session is already starting");
    }

    if (this.#child === null) {
      this.#spawnProcess(options?.onEvent);
    }

    try {
      this.#sessionState = "initializing";
      await this.#sendInitialize();
      await this.#sendNotification({ method: "initialized", params: {} });
      this.#sessionState = "starting-thread";
      await this.#startThread();
    } catch (error) {
      throw this.#withStartupStderr(
        this.#normalizeTransportError(
          asError(error),
          "startup-transport-failure",
        ),
      );
    }
  }

  #spawnProcess(onEvent?: (event: RunnerEvent) => void | Promise<void>): void {
    const workspacePath = requireLocalWorkspacePath(
      this.#runSession,
      "Codex app-server runner",
    );
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
      cwd: workspacePath,
      env: {
        ...process.env,
        ...this.#config.env,
        SYMPHONY_ISSUE_ID: this.#runSession.issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: this.#runSession.issue.identifier,
        SYMPHONY_ISSUE_NUMBER: String(this.#runSession.issue.number),
        SYMPHONY_RUN_ATTEMPT: String(this.#runSession.attempt.sequence),
        SYMPHONY_BRANCH_NAME: this.#runSession.workspace.branchName,
        SYMPHONY_WORKSPACE_PATH: workspacePath,
        SYMPHONY_RUN_SESSION_ID: this.#runSession.id,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child = child;
    this.#appServerPid = child.pid ?? null;
    this.#sessionState = "starting-process";
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#closeResolve = resolve;
      this.#closeReject = reject;
    });

    if (child.pid !== undefined) {
      const spawnedAt = new Date().toISOString();
      Promise.resolve(
        onEvent?.({
          kind: "spawned",
          transport: this.#describeTransport(),
          spawnedAt,
        }),
      )
        .then(() =>
          this.#emitVisibility({
            state: "starting",
            phase: "session-start",
            lastHeartbeatAt: spawnedAt,
            lastActionAt: spawnedAt,
            lastActionSummary: "Codex app-server process spawned",
          }),
        )
        .catch((error) => {
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
      const text = chunk.toString();
      this.#handleStdoutChunk(text);
      if (this.#activeTurn !== null) {
        const observedAt = new Date().toISOString();
        void this.#emitVisibility({
          state: "running",
          phase: "turn-execution",
          lastHeartbeatAt: observedAt,
          lastActionAt: observedAt,
          lastActionSummary: "Codex app-server stdout activity",
          stdoutSummary: summarizeRunnerText(this.#activeTurn.stdout),
          stderrSummary: summarizeRunnerText(this.#activeTurn.stderr),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.#appendStartupStderr(text);
      if (this.#activeTurn !== null) {
        this.#activeTurn.stderr += text;
        const observedAt = new Date().toISOString();
        void this.#emitVisibility({
          state: "running",
          phase: "turn-execution",
          lastHeartbeatAt: observedAt,
          lastActionAt: observedAt,
          lastActionSummary: "Codex app-server stderr activity",
          stdoutSummary: summarizeRunnerText(this.#activeTurn.stdout),
          stderrSummary: summarizeRunnerText(this.#activeTurn.stderr),
        });
      }
    });
    child.on("error", (error) => {
      this.#rejectActiveState(
        this.#withStartupStderr(
          this.#normalizeTransportError(
            new RunnerError(`Failed to launch codex app-server`, {
              cause: error,
            }),
            "startup-transport-failure",
          ),
        ),
      );
    });
    child.on("close", (exitCode, signalCode) => {
      const error =
        this.#closingReason === null &&
        (this.#activeTurn !== null || this.#pendingResponse !== null)
          ? this.#withStartupStderr(
              this.#normalizeTransportError(
                new RunnerError(
                  `Codex app-server exited before the active request completed (exit=${String(
                    exitCode,
                  )}, signal=${String(signalCode)})`,
                ),
                this.#activeTurn === null
                  ? "startup-transport-failure"
                  : "active-turn-transport-failure",
              ),
            )
          : null;
      if (error !== null) {
        this.#rejectActiveState(error);
      }
      this.#child = null;
      this.#closeTimersScheduled = false;
      this.#sessionState = "closed";
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
    const workspacePath = requireLocalWorkspacePath(
      this.#runSession,
      "Codex app-server thread startup",
    );
    const result = await this.#sendRequest({
      id: THREAD_START_REQUEST_ID,
      method: "thread/start",
      params: omitNullValues({
        approvalPolicy: this.#appServerCommand.approvalPolicy,
        config: buildCodexThreadStartConfig(this.#dynamicToolExecutor),
        cwd: workspacePath,
        model: this.#appServerCommand.model,
        sandbox: this.#appServerCommand.sandbox,
      }),
    });

    const thread = asRecord(result["thread"]);
    const threadId = typeof thread?.["id"] === "string" ? thread["id"] : null;
    if (threadId === null) {
      throw new CodexAppServerTransportError(
        "thread-start-transport-failure",
        "Codex app-server returned an invalid thread/start response",
      );
    }
    this.#threadId = threadId;
    this.#sessionState = "ready";
    const dynamicToolCount = this.#dynamicToolExecutor.toolSpecs.length;
    await this.#emitVisibility({
      state: "starting",
      phase: "session-start",
      lastHeartbeatAt: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
      lastActionSummary:
        dynamicToolCount > 0
          ? `Codex thread started (${dynamicToolCount.toString()} dynamic tool${
              dynamicToolCount === 1 ? "" : "s"
            } advertised)`
          : "Codex thread started",
    });
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
    const workspacePath = requireLocalWorkspacePath(
      this.#runSession,
      "Codex app-server turn execution",
    );
    this.#sessionState = "starting-turn";
    await this.#emitVisibility({
      state: "running",
      phase: "turn-execution",
      lastHeartbeatAt: startedAt,
      lastActionAt: startedAt,
      lastActionSummary: `Starting Codex turn ${turn.turnNumber.toString()}`,
    });
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
        id: this.#nextTurnStartRequestId++,
        method: "turn/start",
        params: {
          threadId: this.#threadId,
          cwd: workspacePath,
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
              new CodexAppServerTransportError(
                "turn-start-transport-failure",
                "Codex app-server returned an invalid turn/start response",
              ),
            );
            return;
          }
          this.#latestTurnId = turnId;
          this.#sessionState = "streaming-turn";
        })
        .catch((error) => {
          this.#rejectActiveTurn(error);
        });
    });

    if (options?.signal?.aborted) {
      throw new RunnerShutdownError(
        "Runner cancelled by shutdown",
        this.#forcedShutdown ? "forced" : "graceful",
      );
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
          this.#withStartupStderr(
            new RunnerError(
              `Codex app-server returned malformed JSON: ${line}`,
            ),
          ),
        );
        return;
      }
      this.#logger.warn("Ignoring malformed Codex app-server stream line", {
        runSessionId: this.#runSession.id,
        line,
      });
      return;
    }

    const update = parseRunUpdateEvent(payload);
    if (update !== undefined) {
      try {
        this.#currentOnUpdate?.(update);
      } catch (error) {
        this.#logger.warn("Codex app-server onUpdate handler failed", {
          runSessionId: this.#runSession.id,
          error: error instanceof Error ? error.message : String(error),
          event: update.event,
        });
      }
    }

    const message = classifyCodexAppServerMessage(payload);
    if (message === null) {
      return;
    }

    switch (message.kind) {
      case "response":
        this.#handleResponse(message);
        return;
      case "request":
        void this.#handleRequest(message);
        return;
      case "notification":
        this.#handleNotification(
          message.method,
          message.params,
          message.rawParams,
        );
        return;
    }
  }

  #handleResponse(message: {
    readonly id: unknown;
    readonly result: Record<string, unknown> | null;
    readonly error: unknown;
  }): void {
    const pending = this.#pendingResponse;
    if (pending === null) {
      return;
    }
    if (message.id !== pending.id) {
      this.#logger.warn(
        "Codex app-server returned a response with an unexpected id",
        {
          runSessionId: this.#runSession.id,
          expectedId: pending.id,
          receivedId: message.id,
          method: pending.method,
        },
      );
      return;
    }
    this.#pendingResponse = null;
    if (message.error !== undefined) {
      pending.reject(
        this.#createTransportError(
          failureClassForPendingMethod(pending.method),
          `Codex app-server request '${pending.method}' failed: ${JSON.stringify(
            message.error,
          )}`,
        ),
      );
      return;
    }
    const result = message.result;
    if (result === null) {
      pending.reject(
        this.#createTransportError(
          failureClassForPendingMethod(pending.method),
          `Codex app-server request '${pending.method}' returned an invalid result payload`,
        ),
      );
      return;
    }
    pending.resolve(result);
  }

  async #handleRequest(message: CodexAppServerRequestMessage): Promise<void> {
    try {
      const approval = extractCodexApprovalRequest(message);
      if (approval !== null) {
        await this.#handleApprovalRequest(message, approval);
        return;
      }

      const dynamicToolRequest = extractCodexDynamicToolCallRequest(message);
      if (dynamicToolRequest !== null) {
        await this.#handleDynamicToolCall(message, dynamicToolRequest);
        return;
      }

      if (message.method === "item/tool/requestUserInput") {
        await this.#handleUnsupportedToolUserInputRequest(message);
        return;
      }

      await this.#writeMessage(
        createCodexUnsupportedRequestResponse(message.id, message.method),
      );
      this.#rejectActiveTurn(
        this.#createTransportError(
          "unsupported-request-failure",
          `Codex app-server requested unsupported method '${message.method}'`,
        ),
      );
    } catch (error) {
      const resolvedError = this.#normalizeTransportError(
        asError(error),
        failureClassForInboundRequestMethod(message.method),
      );
      try {
        await this.#writeMessage(
          createCodexInvalidParamsResponse(
            message.id,
            message.method,
            resolvedError.message,
          ),
        );
      } catch {}
      this.#rejectActiveTurn(resolvedError);
    }
  }

  async #handleApprovalRequest(
    message: CodexAppServerRequestMessage,
    approval: NonNullable<ReturnType<typeof extractCodexApprovalRequest>>,
  ): Promise<void> {
    try {
      this.#sessionState = "awaiting-approval";
      const observedAt = new Date().toISOString();
      await this.#emitVisibility({
        state: "waiting",
        phase: "awaiting-external",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: `Codex approval requested (${approval.kind})`,
        waitingReason: `Waiting on Codex ${approval.kind} approval for ${approval.summary}`,
      });

      if (this.#appServerCommand.approvalPolicy !== "never") {
        await this.#writeMessage(
          createCodexInvalidParamsResponse(
            message.id,
            message.method,
            "Symphony cannot satisfy interactive approvals unless the Codex runner is configured with approvalPolicy=never",
          ),
        );
        this.#rejectActiveTurn(
          this.#createTransportError(
            "approval-transport-failure",
            `Codex app-server requested approval for ${approval.summary}, but the runner is not configured for non-interactive approval`,
          ),
        );
        return;
      }

      await this.#writeMessage(createCodexApprovalResponse(message.id));
      this.#sessionState = "streaming-turn";
      await this.#emitVisibility({
        state: "running",
        phase: "turn-execution",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: `Codex approval granted (${approval.kind})`,
        stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
        stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
      });
    } catch (error) {
      throw this.#normalizeTransportError(
        asError(error),
        "approval-transport-failure",
      );
    }
  }

  async #handleDynamicToolCall(
    message: CodexAppServerRequestMessage,
    request: CodexDynamicToolCallRequest,
  ): Promise<void> {
    try {
      this.#activeToolCall = {
        requestId: message.id,
        tool: request.tool,
        callId: request.callId,
      };
      const observedAt = new Date().toISOString();
      await this.#emitVisibility({
        state: "running",
        phase: "turn-execution",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: `Dynamic tool call requested (${request.tool})`,
        stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
        stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
      });

      const outcome = await this.#dynamicToolExecutor.execute(request, {
        runSession: this.#runSession,
      });

      if (outcome.kind === "unsupported-tool") {
        await this.#writeMessage(
          createCodexDynamicToolCallResponse(message.id, {
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(
                  {
                    tool: request.tool,
                    error: {
                      code: "unsupported_tool",
                      message: `Dynamic tool '${request.tool}' is not supported by this Symphony runner`,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
            success: false,
          }),
        );
        await this.#emitVisibility({
          state: "running",
          phase: "turn-execution",
          lastHeartbeatAt: observedAt,
          lastActionAt: observedAt,
          lastActionSummary: `Dynamic tool rejected (${request.tool})`,
          stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
          stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
          errorSummary: "Unsupported dynamic tool request",
        });
        return;
      }

      if (outcome.kind === "invalid-arguments") {
        await this.#writeMessage(
          createCodexInvalidParamsResponse(
            message.id,
            message.method,
            outcome.message,
          ),
        );
        await this.#emitVisibility({
          state: "running",
          phase: "turn-execution",
          lastHeartbeatAt: observedAt,
          lastActionAt: observedAt,
          lastActionSummary: `Dynamic tool rejected (${request.tool})`,
          stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
          stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
          errorSummary: summarizeRunnerText(outcome.message),
        });
        return;
      }

      await this.#writeMessage(
        createCodexDynamicToolCallResponse(message.id, {
          contentItems: outcome.result.contentItems.map((item) =>
            item.type === "inputImage"
              ? { type: item.type, imageUrl: item.imageUrl ?? "" }
              : { type: item.type, text: item.text ?? "" },
          ),
          success: outcome.result.success,
        }),
      );
      await this.#emitVisibility({
        state: "running",
        phase: "turn-execution",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: outcome.result.success
          ? `Dynamic tool completed (${request.tool})`
          : `Dynamic tool failed (${request.tool})`,
        stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
        stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
        errorSummary: outcome.result.success
          ? null
          : summarizeRunnerText(outcome.result.summary),
      });
    } catch (error) {
      throw this.#normalizeTransportError(
        asError(error),
        "active-turn-transport-failure",
      );
    } finally {
      this.#activeToolCall = null;
    }
  }

  async #handleUnsupportedToolUserInputRequest(
    message: CodexAppServerRequestMessage,
  ): Promise<void> {
    try {
      const observedAt = new Date().toISOString();
      await this.#writeMessage(
        createCodexInvalidParamsResponse(
          message.id,
          message.method,
          "Symphony does not support interactive dynamic-tool user input in this slice",
        ),
      );
      await this.#emitVisibility({
        state: "running",
        phase: "turn-execution",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: "Dynamic tool user input rejected",
        stdoutSummary: summarizeRunnerText(this.#activeTurn?.stdout ?? ""),
        stderrSummary: summarizeRunnerText(this.#activeTurn?.stderr ?? ""),
        errorSummary:
          "unsupported-request-failure: interactive dynamic-tool user input is unsupported",
      });
    } catch (error) {
      throw this.#normalizeTransportError(
        asError(error),
        "unsupported-request-failure",
      );
    }
  }

  #handleNotification(
    method: string,
    params: Record<string, unknown> | null,
    rawParams: unknown,
  ): void {
    if (method === "turn/started") {
      if (params === null) {
        return;
      }
      const turnPayload = asRecord(params["turn"]);
      const turnId =
        typeof turnPayload?.["id"] === "string" ? turnPayload["id"] : null;
      if (turnId !== null) {
        this.#latestTurnId = turnId;
      }
      this.#sessionState = "streaming-turn";
      void this.#emitVisibility({
        state: "running",
        phase: "turn-execution",
        lastHeartbeatAt: new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        lastActionSummary: `Codex acknowledged turn ${
          this.#activeTurn?.turnNumber.toString() ?? "?"
        }`,
      });
      return;
    }

    if (method === "turn/completed") {
      if (rawParams !== undefined && rawParams !== null && params === null) {
        this.#rejectActiveTurn(
          this.#createTransportError(
            "malformed-terminal-payload",
            "Codex app-server returned a malformed turn/completed payload",
          ),
        );
        return;
      }
      if (params !== null) {
        const turnPayload = asRecord(params["turn"]);
        if (turnPayload === null) {
          this.#rejectActiveTurn(
            this.#createTransportError(
              "malformed-terminal-payload",
              "Codex app-server returned a malformed turn/completed payload",
            ),
          );
          return;
        }
      }
      this.#resolveActiveTurn();
      return;
    }

    if (method === "turn/failed" || method === "turn/cancelled") {
      if (rawParams !== undefined && rawParams !== null && params === null) {
        this.#rejectActiveTurn(
          this.#createTransportError(
            "malformed-terminal-payload",
            `Codex app-server returned a malformed ${method} payload`,
          ),
        );
        return;
      }
      const observedAt = new Date().toISOString();
      this.#sessionState = "turn-failed";
      void this.#emitVisibility({
        state: method === "turn/cancelled" ? "cancelled" : "failed",
        phase: method === "turn/cancelled" ? "shutdown" : "turn-finished",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary:
          method === "turn/cancelled"
            ? "Codex turn cancelled"
            : "Codex turn failed",
        errorSummary: summarizeRunnerText(JSON.stringify(params ?? {})),
        cancelledAt: method === "turn/cancelled" ? observedAt : null,
      });
      this.#rejectActiveTurn(
        new RunnerError(
          `Codex app-server reported ${method}: ${JSON.stringify(params ?? {})}`,
        ),
      );
      return;
    }
  }

  #resolveActiveTurn(): void {
    const activeTurn = this.#activeTurn;
    if (activeTurn === null) {
      return;
    }
    this.#latestTurnNumber = activeTurn.turnNumber;
    this.#sessionState = "turn-succeeded";
    this.#activeTurn = null;
    void this.#emitVisibility({
      state: "completed",
      phase: "turn-finished",
      lastHeartbeatAt: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
      lastActionSummary: `Turn ${activeTurn.turnNumber.toString()} completed`,
      stdoutSummary: summarizeRunnerText(activeTurn.stdout),
      stderrSummary: summarizeRunnerText(activeTurn.stderr),
    });
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
    const resolvedError = this.#normalizeTransportError(
      asError(error),
      this.#closingReason === "timeout"
        ? "turn-timeout"
        : "active-turn-transport-failure",
    );
    if (activeTurn === null) {
      this.#rejectActiveState(resolvedError);
      return;
    }
    this.#activeTurn = null;
    this.#sessionState = "turn-failed";
    const observedAt = new Date().toISOString();
    void this.#emitVisibility({
      state:
        this.#closingReason === "aborted"
          ? "cancelled"
          : this.#closingReason === "timeout"
            ? "timed-out"
            : "failed",
      phase: this.#closingReason === null ? "turn-finished" : "shutdown",
      lastHeartbeatAt: observedAt,
      lastActionAt: observedAt,
      lastActionSummary:
        this.#closingReason === "aborted"
          ? "Runner cancelled"
          : this.#closingReason === "timeout"
            ? "Runner timed out"
            : "Runner failed",
      stdoutSummary: summarizeRunnerText(activeTurn.stdout),
      stderrSummary: summarizeRunnerText(activeTurn.stderr),
      errorSummary: summarizeRunnerText(
        formatCodexTransportError(
          resolvedError,
          this.#transportFailureClass ?? "active-turn-transport-failure",
        ),
      ),
      cancelledAt: this.#closingReason === "aborted" ? observedAt : null,
      timedOutAt: this.#closingReason === "timeout" ? observedAt : null,
    });
    activeTurn.reject(resolvedError);
  }

  #rejectActiveState(error: Error): void {
    this.#sessionState = "turn-failed";
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

  #appendStartupStderr(text: string): void {
    if (text.length === 0 || this.#latestTurnNumber !== null) {
      return;
    }
    this.#startupStderr = `${this.#startupStderr}${text}`.slice(
      -STARTUP_STDERR_LIMIT,
    );
  }

  #withStartupStderr(error: Error): Error {
    const stderr = this.#startupStderr.trim();
    if (stderr.length === 0 || this.#latestTurnNumber !== null) {
      return error;
    }
    if (error instanceof CodexAppServerTransportError) {
      return new CodexAppServerTransportError(
        error.failureClass,
        `${error.message}\nStartup stderr:\n${stderr}`,
        {
          cause: error,
        },
      );
    }
    return new RunnerError(`${error.message}\nStartup stderr:\n${stderr}`, {
      cause: error,
    });
  }

  #createTransportError(
    failureClass: CodexAppServerFailureClass,
    message: string,
    options?: ErrorOptions,
  ): CodexAppServerTransportError {
    this.#transportFailureClass = failureClass;
    return new CodexAppServerTransportError(failureClass, message, options);
  }

  #normalizeTransportError(
    error: Error,
    fallbackClass: CodexAppServerFailureClass,
  ): Error {
    if (error instanceof CodexAppServerTransportError) {
      this.#transportFailureClass = error.failureClass;
      return error;
    }
    return this.#createTransportError(fallbackClass, error.message, {
      cause: error,
    });
  }

  async #emitVisibility(visibility: {
    readonly state: RunnerVisibilitySnapshot["state"];
    readonly phase: RunnerVisibilitySnapshot["phase"];
    readonly lastHeartbeatAt?: string | null;
    readonly lastActionAt?: string | null;
    readonly lastActionSummary?: string | null;
    readonly waitingReason?: string | null;
    readonly stdoutSummary?: string | null;
    readonly stderrSummary?: string | null;
    readonly errorSummary?: string | null;
    readonly cancelledAt?: string | null;
    readonly timedOutAt?: string | null;
  }): Promise<void> {
    const onEvent = this.#currentOnEvent;
    if (onEvent === null) {
      return;
    }
    try {
      await onEvent({
        kind: "visibility",
        visibility: {
          session: this.describe(),
          state: visibility.state,
          phase: visibility.phase,
          lastHeartbeatAt: visibility.lastHeartbeatAt ?? null,
          lastActionAt: visibility.lastActionAt ?? null,
          lastActionSummary: visibility.lastActionSummary ?? null,
          waitingReason: visibility.waitingReason ?? null,
          stdoutSummary: visibility.stdoutSummary ?? null,
          stderrSummary: visibility.stderrSummary ?? null,
          errorSummary: visibility.errorSummary ?? null,
          cancelledAt: visibility.cancelledAt ?? null,
          timedOutAt: visibility.timedOutAt ?? null,
        },
      });
    } catch (error) {
      this.#rejectActiveState(
        new RunnerError(
          `Failed to record runner visibility: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
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

function omitNullValues(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null),
  );
}

function buildCodexThreadStartConfig(
  dynamicToolExecutor: DynamicToolExecutor,
): Record<string, unknown> | null {
  if (dynamicToolExecutor.toolSpecs.length === 0) {
    return null;
  }

  return {
    experimental_supported_tools: dynamicToolExecutor.toolSpecs.map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
      ...(tool.deferLoading === undefined
        ? {}
        : { deferLoading: tool.deferLoading }),
    })),
  };
}

function failureClassForPendingMethod(
  method: string,
): CodexAppServerFailureClass {
  switch (method) {
    case "initialize":
      return "initialize-transport-failure";
    case "thread/start":
      return "thread-start-transport-failure";
    case "turn/start":
      return "turn-start-transport-failure";
    default:
      return "startup-transport-failure";
  }
}

function failureClassForInboundRequestMethod(
  method: string,
): CodexAppServerFailureClass {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return "approval-transport-failure";
  }

  if (method === "item/tool/call") {
    return "active-turn-transport-failure";
  }

  return "unsupported-request-failure";
}
