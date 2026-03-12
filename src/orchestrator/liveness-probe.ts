import type { LivenessSnapshot } from "./stall-detector.js";

/**
 * Collects liveness signals for an active runner issue.
 *
 * Implementations gather log size, workspace diff hash, and PR head SHA
 * to feed stall detection.
 */
export interface LivenessProbe {
  capture(options: {
    readonly issueNumber: number;
    readonly workspacePath: string | null;
    readonly runSessionId: string | null;
    readonly prHeadSha: string | null;
    readonly hasActionableFeedback: boolean;
  }): Promise<LivenessSnapshot>;
}

export function deriveWatchdogLogFileName(options: {
  readonly issueNumber: number;
  readonly runSessionId: string | null;
}): string {
  return options.runSessionId === null
    ? `${options.issueNumber.toString()}.log`
    : `${encodeURIComponent(options.runSessionId)}.log`;
}

/**
 * Null probe that returns empty snapshots. Used when watchdog is disabled.
 */
export class NullLivenessProbe implements LivenessProbe {
  capture(options: {
    readonly issueNumber: number;
    readonly workspacePath: string | null;
    readonly runSessionId: string | null;
    readonly hasActionableFeedback: boolean;
    readonly prHeadSha: string | null;
  }): Promise<LivenessSnapshot> {
    return Promise.resolve({
      logSizeBytes: null,
      workspaceDiffHash: null,
      prHeadSha: options.prHeadSha,
      hasActionableFeedback: options.hasActionableFeedback,
      capturedAt: Date.now(),
    });
  }
}

/**
 * File-system-based liveness probe.
 *
 * Checks workspace git diff hash and session log file sizes
 * to detect whether real progress is being made.
 */
export class FsLivenessProbe implements LivenessProbe {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  async capture(options: {
    readonly issueNumber: number;
    readonly workspacePath: string | null;
    readonly runSessionId: string | null;
    readonly prHeadSha: string | null;
    readonly hasActionableFeedback: boolean;
  }): Promise<LivenessSnapshot> {
    const [logSize, diffHash] = await Promise.all([
      this.#measureLogSize(options.issueNumber, options.runSessionId),
      this.#measureWorkspaceDiff(options.workspacePath),
    ]);

    return {
      logSizeBytes: logSize,
      workspaceDiffHash: diffHash,
      prHeadSha: options.prHeadSha,
      hasActionableFeedback: options.hasActionableFeedback,
      capturedAt: Date.now(),
    };
  }

  async #measureLogSize(
    issueNumber: number,
    sessionId: string | null,
  ): Promise<number | null> {
    // Optional watchdog session logs must use this location so the probe can
    // sample them without depending on runner-specific path conventions.
    try {
      const { stat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const logName = deriveWatchdogLogFileName({
        issueNumber,
        runSessionId: sessionId,
      });
      const logPath = join(this.#workspaceRoot, ".symphony", logName);
      const stats = await stat(logPath);
      return stats.size;
    } catch {
      return null;
    }
  }

  async #measureWorkspaceDiff(
    workspacePath: string | null,
  ): Promise<string | null> {
    if (workspacePath === null) {
      return null;
    }
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { createHash } = await import("node:crypto");
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--stat", "HEAD"],
        { cwd: workspacePath, timeout: 5_000 },
      );
      return createHash("sha256").update(stdout).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  }
}
