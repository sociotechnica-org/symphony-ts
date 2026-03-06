import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { RunnerError } from "../domain/errors.js";
import type { AgentConfig, RunContext, RunResult } from "../domain/types.js";
import type { Logger } from "../observability/logger.js";
import type { Runner } from "./service.js";

export class LocalRunner implements Runner {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async run(context: RunContext, config: AgentConfig): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const promptFile = path.join(context.workspace.path, ".symphony-prompt.md");
    const command =
      config.promptTransport === "file"
        ? `${config.command} ${JSON.stringify(promptFile)}`
        : config.command;

    if (config.promptTransport === "file") {
      await fs.writeFile(promptFile, context.prompt, "utf8");
    }

    this.#logger.info("Launching runner", {
      command,
      workspacePath: context.workspace.path,
      issueIdentifier: context.issue.identifier,
      attempt: context.attempt,
    });

    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: context.workspace.path,
        env: {
          ...process.env,
          ...config.env,
          SYMPHONY_ISSUE_ID: context.issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: context.issue.identifier,
          SYMPHONY_ISSUE_NUMBER: String(context.issue.number),
          SYMPHONY_RUN_ATTEMPT: String(context.attempt),
          SYMPHONY_BRANCH_NAME: context.workspace.branchName,
          SYMPHONY_WORKSPACE_PATH: context.workspace.path,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback();
      };

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
        child.kill("SIGTERM");
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
      child.on("close", (exitCode, signal) => {
        finish(() => {
          const finishedAt = new Date().toISOString();
          if (signal === "SIGTERM") {
            reject(
              new RunnerError(`Runner timed out after ${config.timeoutMs}ms`),
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

      if (config.promptTransport === "stdin") {
        child.stdin.end(context.prompt);
        return;
      }
      child.stdin.end();
    });
  }
}
