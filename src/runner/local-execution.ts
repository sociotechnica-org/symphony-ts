import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { RunnerError, RunnerShutdownError } from "../domain/errors.js";
import type { RunSession, RunUpdateEvent } from "../domain/run.js";
import { getPreparedWorkspacePath } from "../domain/workspace.js";
import { deriveWatchdogLogPath } from "../domain/watchdog-log.js";
import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { parseRunUpdateEvent } from "./run-update-event.js";
import { createRunnerEnvironment } from "./run-environment.js";
import {
  RUNNER_SHUTDOWN_GRACE_MS,
  createRunnerTransportMetadata,
  type RunnerExecutionResult,
  type RunnerRunOptions,
} from "./service.js";

function signalLocalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall through to direct child signaling when the process group is gone or
    // the platform/runtime cannot address it.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Ignore races where the runner exits between the liveness check and signal.
  }
}

function tryParseStdoutEvent(line: string): RunUpdateEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  return parseRunUpdateEvent(parsed);
}

export interface LocalCommandExecutionOptions {
  readonly command: string;
  readonly prompt: string;
  readonly session: RunSession;
  readonly turnNumber: number;
  readonly options: RunnerRunOptions | undefined;
  readonly promptTransport: AgentConfig["promptTransport"];
}

export function requireLocalWorkspacePath(
  session: RunSession,
  consumer: string,
): string {
  const workspacePath = getPreparedWorkspacePath(session.workspace);
  if (workspacePath === null) {
    throw new RunnerError(
      `${consumer} requires a local workspace target; received ${session.workspace.target.kind}`,
    );
  }
  return workspacePath;
}

export async function executeLocalRunnerCommand(
  logger: Logger,
  config: AgentConfig,
  execution: LocalCommandExecutionOptions,
): Promise<RunnerExecutionResult> {
  const startedAt = new Date().toISOString();
  const workspacePath = requireLocalWorkspacePath(
    execution.session,
    "Local runner execution",
  );
  // Multi-turn runs keep per-turn prompt files distinct; older one-shot runs
  // used `.symphony-prompt.md`.
  const promptFile = path.join(
    workspacePath,
    `.symphony-prompt.turn-${execution.turnNumber.toString()}.md`,
  );

  if (execution.promptTransport === "file") {
    await fs.writeFile(promptFile, execution.prompt, "utf8");
  }

  const command =
    execution.promptTransport === "file"
      ? `${execution.command} ${JSON.stringify(promptFile)}`
      : execution.command;

  logger.info("Launching runner", {
    command,
    workspacePath,
    issueIdentifier: execution.session.issue.identifier,
    attempt: execution.session.attempt.sequence,
    runSessionId: execution.session.id,
    turnNumber: execution.turnNumber,
  });

  return await new Promise<RunnerExecutionResult>((resolve, reject) => {
    const watchdogLogPath = deriveWatchdogLogPath({
      workspaceRoot: path.dirname(workspacePath),
      issueNumber: execution.session.issue.number,
      runSessionId: execution.session.id,
    });
    const child = spawn("bash", ["-lc", command], {
      cwd: workspacePath,
      detached: true,
      env: {
        ...process.env,
        ...createRunnerEnvironment(
          execution.session,
          execution.turnNumber,
          workspacePath,
          config.env,
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forcedShutdown = false;
    let spawnError: RunnerError | null = null;
    let forcedKillTimeout: NodeJS.Timeout | null = null;
    let spawnNotificationPromise: Promise<void> = Promise.resolve();
    let activityLogWriteChain: Promise<void> = Promise.resolve();

    const noteWatchdogActivity = (
      stream: "stdout" | "stderr",
      text: string,
    ): void => {
      if (text.length === 0) {
        return;
      }
      const entry = `${new Date().toISOString()} ${stream} ${Buffer.byteLength(text).toString()}\n`;
      activityLogWriteChain = activityLogWriteChain
        .catch(() => undefined)
        .then(async () => {
          await fs.mkdir(path.dirname(watchdogLogPath), { recursive: true });
          await fs.appendFile(watchdogLogPath, entry, "utf8");
        })
        .catch((error: unknown) => {
          logger.warn("Failed to append watchdog activity log", {
            issueIdentifier: execution.session.issue.identifier,
            runSessionId: execution.session.id,
            watchdogLogPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

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
      if (child.pid !== undefined) {
        signalLocalProcessTree(child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
      if (forcedKillTimeout !== null) {
        return;
      }
      forcedKillTimeout = setTimeout(() => {
        forcedKillTimeout = null;
        if (child.exitCode === null && child.signalCode === null) {
          if (aborted && !timedOut) {
            forcedShutdown = true;
          }
          if (child.pid !== undefined) {
            signalLocalProcessTree(child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        }
      }, RUNNER_SHUTDOWN_GRACE_MS);
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
            transport: createRunnerTransportMetadata("local-process", {
              localProcessPid: child.pid,
              canTerminateLocalProcess: true,
            }),
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
      if (aborted) {
        stderr += `\nstdin write aborted: ${error.message}`;
        return;
      }
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
      const text = chunk.toString();
      stdout += text;
      noteWatchdogActivity("stdout", text);
      if (execution.options?.onUpdate !== undefined) {
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split("\n");
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const update = tryParseStdoutEvent(line);
          if (update !== undefined) {
            try {
              execution.options.onUpdate(update);
            } catch {
              // Prevent a throwing onUpdate from crashing the stream.
            }
          }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      noteWatchdogActivity("stderr", text);
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
      // Flush any remaining partial line in the buffer
      if (
        execution.options?.onUpdate !== undefined &&
        stdoutLineBuffer.trim() !== ""
      ) {
        const update = tryParseStdoutEvent(stdoutLineBuffer);
        if (update !== undefined) {
          try {
            execution.options.onUpdate(update);
          } catch {
            // Prevent a throwing onUpdate from hanging the Promise.
          }
        }
      }
      void Promise.allSettled([spawnNotificationPromise, activityLogWriteChain]).finally(() => {
        finish(() => {
          const finishedAt = new Date().toISOString();
          if (timedOut) {
            reject(
              new RunnerError(`Runner timed out after ${config.timeoutMs}ms`),
            );
            return;
          }
          if (aborted) {
            reject(
              new RunnerShutdownError(
                "Runner cancelled by shutdown",
                forcedShutdown ? "forced" : "graceful",
              ),
            );
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
