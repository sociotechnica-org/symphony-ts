import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { RunnerAbortedError, RunnerError } from "../domain/errors.js";
import type { RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { RunnerExecutionResult, RunnerRunOptions } from "./service.js";

export interface LocalCommandExecutionOptions {
  readonly command: string;
  readonly prompt: string;
  readonly session: RunSession;
  readonly turnNumber: number;
  readonly options: RunnerRunOptions | undefined;
  readonly promptTransport: AgentConfig["promptTransport"];
}

const TERMINATION_GRACE_MS = 200;

export async function executeLocalRunnerCommand(
  logger: Logger,
  config: AgentConfig,
  execution: LocalCommandExecutionOptions,
): Promise<RunnerExecutionResult> {
  const startedAt = new Date().toISOString();
  // Multi-turn runs keep per-turn prompt files distinct; older one-shot runs
  // used `.symphony-prompt.md`.
  const promptFile = `${execution.session.workspace.path}/.symphony-prompt.turn-${execution.turnNumber.toString()}.md`;

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

  return await new Promise<RunnerExecutionResult>((resolve, reject) => {
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
      }, TERMINATION_GRACE_MS);
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
      spawnError = new RunnerError(`Failed to record runner spawn: ${reason}`, {
        cause: error instanceof Error ? error : new Error(reason),
      });
      terminateChild();
    };

    if (child.pid !== undefined) {
      try {
        spawnNotificationPromise = Promise.resolve(
          execution.options?.onEvent?.({
            kind: "spawned",
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
