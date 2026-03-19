import { RunnerError } from "../domain/errors.js";
import type { RunSession, RunTurn } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { buildCodexResumeCommand } from "./codex-resume-command.js";
import { findCodexSession } from "./codex-session-discovery.js";
import {
  type LocalCommandExecutionOptions,
  executeLocalRunnerCommand,
  requireLocalWorkspacePath,
} from "./local-execution.js";
import { describeLocalRunnerSession } from "./local-session-description.js";
import type {
  LiveRunnerSession,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerSessionDescription,
  RunnerTurnResult,
} from "./service.js";

export class LocalRunnerSession implements LiveRunnerSession {
  readonly #config: AgentConfig;
  readonly #logger: Logger;
  readonly #runSession: RunSession;
  readonly #baseDescription: RunnerSessionDescription;
  readonly #executeCommand: (
    logger: Logger,
    config: AgentConfig,
    execution: LocalCommandExecutionOptions,
  ) => Promise<RunnerExecutionResult>;
  #loggedDroppedResumeArgs = false;
  #backendSessionId: string | null = null;
  #latestTurnNumber: number | null = null;

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
    this.#config = config;
    this.#logger = logger;
    this.#runSession = session;
    this.#baseDescription = describeLocalRunnerSession(config.command);
    validateContinuationSessionConfig(config, this.#baseDescription);
    warnIfContinuationColdStarts(
      this.#logger,
      this.#runSession,
      this.#baseDescription,
      this.#config,
    );
    this.#executeCommand = executeCommand;
  }

  describe(): RunnerSessionDescription {
    return {
      ...this.#baseDescription,
      backendSessionId: this.#backendSessionId,
      latestTurnNumber: this.#latestTurnNumber,
    };
  }

  async close(): Promise<void> {}

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
        promptTransport: this.#promptTransportForTurn(turn),
      },
    );

    if (
      executionResult.exitCode === 0 &&
      this.#baseDescription.provider === "codex" &&
      this.#backendSessionId === null
    ) {
      const workspacePath = requireLocalWorkspacePath(
        this.#runSession,
        "Codex session discovery",
      );
      const matchedSession = await findCodexSession({
        workspacePath,
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
    const resume = buildCodexResumeCommand(
      this.#config.command,
      this.#backendSessionId,
    );
    if (!this.#loggedDroppedResumeArgs && resume.droppedArgs.length > 0) {
      this.#logger.warn(
        "Dropped unsupported Codex continuation arguments while building resume command",
        {
          runSessionId: this.#runSession.id,
          droppedArgs: resume.droppedArgs,
        },
      );
      this.#loggedDroppedResumeArgs = true;
    }
    return resume.command;
  }
}

function validateContinuationSessionConfig(
  config: AgentConfig,
  description: RunnerSessionDescription,
): void {
  if (
    description.provider === "codex" &&
    config.maxTurns > 1 &&
    config.promptTransport !== "stdin"
  ) {
    throw new RunnerError(
      "Codex continuation turns require agent.prompt_transport to be 'stdin'",
    );
  }
}

function warnIfContinuationColdStarts(
  logger: Logger,
  session: RunSession,
  description: RunnerSessionDescription,
  config: AgentConfig,
): void {
  if (config.maxTurns <= 1 || description.provider === "codex") {
    return;
  }

  logger.warn(
    "Session reuse is not implemented for this provider; continuation turns will cold-start new subprocesses",
    {
      runSessionId: session.id,
      provider: description.provider,
      maxTurns: config.maxTurns,
    },
  );
}
