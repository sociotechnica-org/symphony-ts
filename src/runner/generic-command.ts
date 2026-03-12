import type { RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import { RunnerError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import { executeLocalRunnerCommand } from "./local-execution.js";
import type {
  Runner,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
} from "./service.js";

function describeGenericCommandSession(): RunnerSessionDescription {
  return {
    provider: "generic-command",
    model: null,
    backendSessionId: null,
    latestTurnNumber: null,
    logPointers: [],
  };
}

export class GenericCommandRunner implements Runner {
  readonly #config: AgentConfig;
  readonly #logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    if (config.runner.kind !== "generic-command") {
      throw new RunnerError(
        `GenericCommandRunner requires agent.runner.kind 'generic-command', got '${config.runner.kind}'`,
      );
    }

    this.#config = config;
    this.#logger = logger;
  }

  describeSession(_session: RunSession): RunnerSessionDescription {
    return describeGenericCommandSession();
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunnerExecutionResult> {
    return await executeLocalRunnerCommand(this.#logger, this.#config, {
      command: this.#config.command,
      prompt: session.prompt,
      session,
      turnNumber: 1,
      options,
      promptTransport: this.#config.promptTransport,
    });
  }
}
