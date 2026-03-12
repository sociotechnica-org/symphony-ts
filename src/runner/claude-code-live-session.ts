import { RunnerError } from "../domain/errors.js";
import type { RunSession, RunTurn } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import {
  buildClaudeResumeCommand,
  describeClaudeCodeSession,
  parseClaudeCodeResult,
  validateClaudeCodeConfig,
} from "./claude-code-command.js";
import {
  type LocalCommandExecutionOptions,
  executeLocalRunnerCommand,
} from "./local-execution.js";
import type {
  LiveRunnerSession,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
  RunnerTurnResult,
} from "./service.js";

export class ClaudeCodeLiveSession implements LiveRunnerSession {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #runSession: RunSession;
  readonly #executeCommand: (
    logger: Logger,
    config: AgentConfig,
    execution: LocalCommandExecutionOptions,
  ) => Promise<RunnerExecutionResult>;
  #description: RunnerSessionDescription;

  constructor(
    config: AgentConfig,
    logger: Logger,
    session: RunSession,
    executeCommand: (
      logger: Logger,
      config: AgentConfig,
      execution: LocalCommandExecutionOptions,
    ) => Promise<RunnerExecutionResult> = executeLocalRunnerCommand,
  ) {
    validateClaudeCodeConfig(config);
    this.#config = config;
    this.#logger = logger;
    this.#runSession = session;
    this.#executeCommand = executeCommand;
    this.#description = describeClaudeCodeSession(config.command);
  }

  describe(): RunnerSessionDescription {
    return this.#description;
  }

  async runTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    const executionResult = await this.#executeCommand(
      this.#logger,
      this.#config,
      {
        command: this.#commandForTurn(turn),
        prompt: turn.prompt,
        session: this.#runSession,
        turnNumber: turn.turnNumber,
        options,
        promptTransport: "stdin",
      },
    );

    if (executionResult.exitCode === 0) {
      const result = parseClaudeCodeResult(executionResult.stdout);
      this.#description = {
        ...this.#description,
        model: result.model ?? this.#description.model,
        backendSessionId:
          result.sessionId ?? this.#description.backendSessionId,
        latestTurnNumber: turn.turnNumber,
      };
    }

    return {
      ...executionResult,
      session: this.describe(),
    };
  }

  #commandForTurn(turn: RunTurn): string {
    if (turn.turnNumber === 1) {
      return this.#config.command;
    }
    if (this.#description.backendSessionId === null) {
      throw new RunnerError(
        "Claude Code continuation turn requested but no backend session id was returned by the previous turn",
      );
    }
    return buildClaudeResumeCommand(
      this.#config.command,
      this.#description.backendSessionId,
    );
  }
}
