import type { RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import { RunnerError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import type { TrackerToolService } from "../tracker/tool-service.js";
import { describeLocalRunnerBackend } from "./local-command.js";
import { executeLocalRunnerCommand } from "./local-execution.js";
import { CodexAppServerSession } from "./codex-app-server-session.js";
import { RunnerDynamicToolExecutor } from "./dynamic-tool-executor.js";
import { describeLocalRunnerSession } from "./local-session-description.js";
import type {
  Runner,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
} from "./service.js";

export class CodexRunner implements Runner {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #dynamicToolExecutor: RunnerDynamicToolExecutor;

  constructor(
    config: AgentConfig,
    logger: Logger,
    trackerToolService: TrackerToolService | null = null,
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
  }

  describeSession(_session: RunSession): RunnerSessionDescription {
    return describeLocalRunnerSession(
      this.#config.command,
      "local-stdio-session",
    );
  }

  startSession(session: RunSession): Promise<CodexAppServerSession> {
    try {
      return Promise.resolve(
        new CodexAppServerSession(
          this.#config,
          this.#logger,
          session,
          this.#dynamicToolExecutor,
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
