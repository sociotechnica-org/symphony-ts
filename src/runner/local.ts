import type { RunResult, RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { executeLocalRunnerCommand } from "./local-execution.js";
import { LocalRunnerSession } from "./local-live-session.js";
import { describeLocalRunnerSession } from "./local-session-description.js";
import type {
  Runner,
  RunnerRunOptions,
  RunnerSessionDescription,
} from "./service.js";

export class LocalRunner implements Runner {
  readonly #config: AgentConfig;
  readonly #logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  describeSession(_session: RunSession): RunnerSessionDescription {
    return describeLocalRunnerSession(this.#config.command);
  }

  startSession(session: RunSession): Promise<LocalRunnerSession> {
    return Promise.resolve(
      new LocalRunnerSession(
        this.#config,
        this.#logger,
        session,
        LocalRunner.executeCommand,
      ),
    );
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunResult> {
    return await LocalRunner.executeCommand(this.#logger, this.#config, {
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
  ): Promise<RunResult> {
    return await executeLocalRunnerCommand(...args);
  }
}
