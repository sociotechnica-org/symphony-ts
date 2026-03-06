import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { RunnerAbortedError, RunnerError } from "../domain/errors.js";
import type { RunResult, RunSession } from "../domain/run.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Runner, RunnerRunOptions } from "./service.js";

export class LocalRunner implements Runner {
  static readonly #terminationGraceMs = 200;
  readonly #config: AgentConfig;
  readonly #logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const promptFile = path.join(session.workspace.path, ".symphony-prompt.md");
    const command =
      this.#config.promptTransport === "file"
        ? `${this.#config.command} ${JSON.stringify(promptFile)}`
        : this.#config.command;

    if (this.#config.promptTransport === "file") {
      await fs.writeFile(promptFile, session.prompt, "utf8");
    }

    this.#logger.info("Launching runner", {
      command,
      workspacePath: session.workspace.path,
      issueIdentifier: session.issue.identifier,
      attempt: session.attempt.sequence,
      runSessionId: session.id,
    });

    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: session.workspace.path,
        env: {
          ...process.env,
          ...this.#config.env,
          SYMPHONY_ISSUE_ID: session.issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: session.issue.identifier,
          SYMPHONY_ISSUE_NUMBER: String(session.issue.number),
          SYMPHONY_RUN_ATTEMPT: String(session.attempt.sequence),
          SYMPHONY_BRANCH_NAME: session.workspace.branchName,
          SYMPHONY_WORKSPACE_PATH: session.workspace.path,
          SYMPHONY_RUN_SESSION_ID: session.id,
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

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forcedKillTimeout !== null) {
          clearTimeout(forcedKillTimeout);
        }
        options?.signal?.removeEventListener("abort", handleAbort);
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
        }, LocalRunner.#terminationGraceMs);
      };

      const handleAbort = (): void => {
        aborted = true;
        terminateChild();
      };

      const handleSpawnFailure = (error: unknown): void => {
        if (spawnError !== null) {
          return;
        }
        spawnError = new RunnerError(`Failed to record runner spawn`, {
          cause: error as Error,
        });
        terminateChild();
      };

      if (child.pid !== undefined) {
        try {
          const spawnNotification = options?.onSpawn?.({
            pid: child.pid,
            spawnedAt: new Date().toISOString(),
          });
          if (spawnNotification instanceof Promise) {
            void spawnNotification.catch(handleSpawnFailure);
          }
        } catch (error) {
          handleSpawnFailure(error);
        }
      }

      if (options?.signal?.aborted) {
        handleAbort();
      } else {
        options?.signal?.addEventListener("abort", handleAbort, {
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
      }, this.#config.timeoutMs);

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
      child.on("close", (exitCode, signal) => {
        finish(() => {
          const finishedAt = new Date().toISOString();
          if (spawnError !== null) {
            reject(spawnError);
            return;
          }
          if (aborted) {
            reject(new RunnerAbortedError(`Runner cancelled by shutdown`));
            return;
          }
          if (signal === "SIGTERM" && timedOut) {
            reject(
              new RunnerError(
                `Runner timed out after ${this.#config.timeoutMs}ms`,
              ),
            );
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

      if (this.#config.promptTransport === "stdin") {
        child.stdin.end(session.prompt);
        return;
      }
      child.stdin.end();
    });
  }
}
