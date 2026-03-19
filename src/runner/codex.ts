import type { RunSession } from "../domain/run.js";
import type { AgentConfig, SshWorkerHostConfig } from "../domain/workflow.js";
import { RunnerError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import type { TrackerToolService } from "../tracker/tool-service.js";
import { describeLocalRunnerBackend } from "./local-command.js";
import { executeLocalRunnerCommand } from "./local-execution.js";
import { CodexAppServerSession } from "./codex-app-server-session.js";
import { RunnerDynamicToolExecutor } from "./dynamic-tool-executor.js";
import type {
  Runner,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
} from "./service.js";
import { createRunnerTransportMetadata } from "./service.js";

export class CodexRunner implements Runner {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #dynamicToolExecutor: RunnerDynamicToolExecutor;
  readonly #remoteWorkerHosts: Readonly<Record<string, SshWorkerHostConfig>>;

  constructor(
    config: AgentConfig,
    logger: Logger,
    trackerToolService: TrackerToolService | null = null,
    remoteWorkerHosts: Readonly<Record<string, SshWorkerHostConfig>> | null = null,
  ) {
    if (config.runner.kind !== "codex") {
      throw new RunnerError(
        `CodexRunner requires agent.runner.kind 'codex', got '${config.runner.kind}'`,
      );
    }

    const backend = describeLocalRunnerBackend(config.command);
    if (backend.provider !== "codex") {
      throw new RunnerError(
        "Codex runner requires agent.command to invoke the codex CLI",
      );
    }

    this.#config = config;
    this.#logger = logger;
    this.#dynamicToolExecutor = new RunnerDynamicToolExecutor(
      trackerToolService,
    );
    this.#remoteWorkerHosts = remoteWorkerHosts ?? {};
  }

  describeSession(session: RunSession): RunnerSessionDescription {
    const backend = describeLocalRunnerBackend(this.#config.command);
    const remoteTransport =
      session.workspace.target.kind === "remote"
        ? {
            kind: "remote-stdio-session" as const,
            remoteSessionId: `${session.workspace.target.host}:${session.id}`,
          }
        : null;
    return {
      provider: backend.provider,
      model: backend.model,
      transport: createRunnerTransportMetadata(
        remoteTransport?.kind ?? "local-stdio-session",
        remoteTransport === null
          ? {
              canTerminateLocalProcess: true,
            }
          : {
              canTerminateLocalProcess: true,
              remoteSessionId: remoteTransport.remoteSessionId,
            },
      ),
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: null,
      logPointers: [],
    };
  }

  startSession(session: RunSession): Promise<CodexAppServerSession> {
    try {
      return Promise.resolve(
        new CodexAppServerSession(
          this.#config,
          this.#logger,
          session,
          this.#dynamicToolExecutor,
          this.#remoteWorkerHosts,
        ),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunnerExecutionResult> {
    if (session.workspace.target.kind === "remote") {
      const liveSession = await this.startSession(session);
      try {
        const result = await liveSession.runTurn(
          {
            prompt: session.prompt,
            turnNumber: 1,
          },
          options,
        );
        return result;
      } finally {
        await liveSession.close();
      }
    }
    return await CodexRunner.executeCommand(this.#logger, this.#config, {
      command: this.#config.command,
      prompt: session.prompt,
      session,
      turnNumber: 1,
      options,
      promptTransport: this.#config.promptTransport,
    });
  }

  static async executeCommand(
    ...args: Parameters<typeof executeLocalRunnerCommand>
  ): Promise<RunnerExecutionResult> {
    return await executeLocalRunnerCommand(...args);
  }
}
