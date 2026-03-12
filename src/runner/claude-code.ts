import type { RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import {
  describeClaudeCodeSession,
  validateClaudeCodeConfig,
} from "./claude-code-command.js";
import { ClaudeCodeLiveSession } from "./claude-code-live-session.js";
import { executeLocalRunnerCommand } from "./local-execution.js";
import type {
  Runner,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
} from "./service.js";

export class ClaudeCodeRunner implements Runner {
  readonly #config: AgentConfig;
  readonly #logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    validateClaudeCodeConfig(config);
    this.#config = config;
    this.#logger = logger;
  }

  describeSession(_session: RunSession): RunnerSessionDescription {
    return describeClaudeCodeSession(this.#config.command);
  }

  startSession(session: RunSession): Promise<ClaudeCodeLiveSession> {
    try {
      return Promise.resolve(
        new ClaudeCodeLiveSession(
          this.#config,
          this.#logger,
          session,
          ClaudeCodeRunner.executeCommand,
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
    const liveSession = await this.startSession(session);
    const result = await liveSession.runTurn(
      {
        turnNumber: 1,
        prompt: session.prompt,
      },
      options,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  }

  static async executeCommand(
    ...args: Parameters<typeof executeLocalRunnerCommand>
  ): Promise<RunnerExecutionResult> {
    return await executeLocalRunnerCommand(...args);
  }
}
