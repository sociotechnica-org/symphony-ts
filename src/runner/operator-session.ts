import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type { OperatorProvider } from "../config/operator-loop.js";
import {
  buildClaudeResumeCommand,
  parseClaudeCodeResult,
} from "./claude-code-command.js";
import { findCodexSession } from "./codex-session-discovery.js";
import { buildCodexResumeCommand } from "./codex-resume-command.js";
import {
  clearOperatorSessionState,
  describeOperatorSessionCompatibility,
  fingerprintOperatorCommand,
  type OperatorSessionStateDocument,
  readOperatorSessionState,
  writeOperatorSessionState,
} from "../observability/operator-session-state.js";

const execFileAsync = promisify(execFile);

export interface PreparedOperatorCycle {
  readonly effectiveCommand: string;
  readonly sessionMode: "disabled" | "fresh" | "resuming";
  readonly sessionSummary: string;
  readonly backendSessionId: string | null;
  readonly resetReason: string | null;
}

export interface RecordedOperatorCycle {
  readonly sessionSummary: string;
  readonly backendSessionId: string | null;
}

export async function prepareOperatorCycle(args: {
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
  readonly resumeSession: boolean;
  readonly sessionStatePath: string;
}): Promise<PreparedOperatorCycle> {
  if (!args.resumeSession) {
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "disabled",
      sessionSummary: "Resumable operator sessions are disabled.",
      backendSessionId: null,
      resetReason: null,
    };
  }

  const stored = await readStoredSessionLenient(args.sessionStatePath);
  const resumeSupport = buildResumeCommand({
    provider: args.provider,
    baseCommand: args.baseCommand,
    sessionId: stored.document?.backendSessionId ?? "probe-session",
  });

  if (!resumeSupport.supported) {
    if (stored.document !== null || stored.error !== null) {
      await clearOperatorSessionState(args.sessionStatePath);
    }
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "fresh",
      sessionSummary:
        stored.error !== null
          ? `Stored operator session was cleared after a read error (${stored.error}); running fresh because the selected command cannot be resumed safely.`
          : "Selected operator command does not support safe resumable sessions; running fresh.",
      backendSessionId: null,
      resetReason: resumeSupport.reason,
    };
  }

  if (stored.error !== null) {
    await clearOperatorSessionState(args.sessionStatePath);
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "fresh",
      sessionSummary: `Stored operator session was unreadable and was cleared (${stored.error}); running fresh.`,
      backendSessionId: null,
      resetReason: stored.error,
    };
  }

  if (stored.document === null) {
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "fresh",
      sessionSummary:
        "No stored operator session matched this instance; running fresh.",
      backendSessionId: null,
      resetReason: null,
    };
  }

  const compatibility = describeOperatorSessionCompatibility({
    stored: stored.document,
    provider: args.provider,
    model: args.model,
    baseCommand: args.baseCommand,
  });
  if (!compatibility.compatible) {
    await clearOperatorSessionState(args.sessionStatePath);
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "fresh",
      sessionSummary: `Stored operator session was cleared because ${compatibility.reason}; running fresh.`,
      backendSessionId: null,
      resetReason: compatibility.reason,
    };
  }

  const resume = buildResumeCommand({
    provider: args.provider,
    baseCommand: args.baseCommand,
    sessionId: stored.document.backendSessionId,
  });
  if (!resume.supported) {
    await clearOperatorSessionState(args.sessionStatePath);
    return {
      effectiveCommand: args.baseCommand,
      sessionMode: "fresh",
      sessionSummary: `Stored operator session was cleared because the resume command could not be reconstructed (${resume.reason}); running fresh.`,
      backendSessionId: null,
      resetReason: resume.reason,
    };
  }

  const droppedArgsSummary =
    resume.droppedArgs.length === 0
      ? ""
      : ` Dropped unsupported resume args: ${resume.droppedArgs.join(" ")}.`;

  return {
    effectiveCommand: resume.command,
    sessionMode: "resuming",
    sessionSummary:
      `Resuming stored ${args.provider} operator session ${stored.document.backendSessionId}.${droppedArgsSummary}`.trim(),
    backendSessionId: stored.document.backendSessionId,
    resetReason: null,
  };
}

export async function recordOperatorCycle(args: {
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
  readonly resumeSession: boolean;
  readonly sessionMode: PreparedOperatorCycle["sessionMode"];
  readonly sessionStatePath: string;
  readonly repoRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly logFile: string;
  readonly resetReason: string | null;
}): Promise<RecordedOperatorCycle> {
  if (!args.resumeSession) {
    return {
      sessionSummary: "Resumable operator sessions are disabled.",
      backendSessionId: null,
    };
  }

  if (args.exitCode !== 0) {
    if (args.sessionMode === "resuming") {
      await clearOperatorSessionState(args.sessionStatePath);
      return {
        sessionSummary:
          "Resume attempt failed; cleared the stored operator session so the next cycle starts fresh.",
        backendSessionId: null,
      };
    }
    return {
      sessionSummary:
        "Operator cycle failed before a reusable backend session was recorded.",
      backendSessionId: null,
    };
  }

  const sessionId = await detectBackendSessionId(args);
  if (sessionId === null) {
    await clearOperatorSessionState(args.sessionStatePath);
    return {
      sessionSummary:
        args.resetReason === null
          ? "Operator cycle succeeded but no reusable backend session id was discovered; the next cycle will start fresh."
          : `Stored operator session was cleared because ${args.resetReason}. Operator cycle succeeded but no reusable backend session id was discovered; the next cycle will start fresh.`,
      backendSessionId: null,
    };
  }

  const now = args.finishedAt;
  const current = await readOperatorSessionState(args.sessionStatePath);
  const summary =
    args.sessionMode === "resuming"
      ? `Resumed operator session ${sessionId} and refreshed the stored record.`
      : args.resetReason === null
        ? `Captured reusable operator session ${sessionId} for later wake-up cycles.`
        : `Stored operator session was cleared because ${args.resetReason}. Captured reusable operator session ${sessionId} for later wake-up cycles.`;

  const nextState: OperatorSessionStateDocument = {
    version: 1,
    provider: args.provider,
    model: args.model,
    baseCommandFingerprint: fingerprintOperatorCommand({
      provider: args.provider,
      baseCommand: args.baseCommand,
    }),
    backendSessionId: sessionId,
    createdAt: current?.createdAt ?? now,
    lastUsedAt: now,
    lastMode: args.sessionMode === "resuming" ? "resuming" : "fresh",
    lastSummary: summary,
  };
  await writeOperatorSessionState(args.sessionStatePath, nextState);
  return {
    sessionSummary: summary,
    backendSessionId: sessionId,
  };
}

async function detectBackendSessionId(args: {
  readonly provider: OperatorProvider;
  readonly repoRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly logFile: string;
}): Promise<string | null> {
  if (args.provider === "claude") {
    const output = await fs.readFile(args.logFile, "utf8").catch(() => null);
    if (output === null) {
      return null;
    }
    try {
      return parseClaudeCodeResult(output).sessionId;
    } catch {
      return null;
    }
  }

  if (args.provider === "codex") {
    const branchName = await readCurrentGitBranch(args.repoRoot);
    if (branchName === null) {
      return null;
    }
    const session = await findCodexSession({
      workspacePath: args.repoRoot,
      branchName,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    });
    return session?.id ?? null;
  }

  return null;
}

async function readStoredSessionLenient(filePath: string): Promise<{
  readonly document: OperatorSessionStateDocument | null;
  readonly error: string | null;
}> {
  try {
    return {
      document: await readOperatorSessionState(filePath),
      error: null,
    };
  } catch (error) {
    return {
      document: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readCurrentGitBranch(repoRoot: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoRoot },
    );
    const branchName = result.stdout.trim();
    return branchName.length === 0 ? null : branchName;
  } catch {
    return null;
  }
}

function buildResumeCommand(args: {
  readonly provider: OperatorProvider;
  readonly baseCommand: string;
  readonly sessionId: string;
}):
  | {
      readonly supported: true;
      readonly command: string;
      readonly droppedArgs: readonly string[];
    }
  | {
      readonly supported: false;
      readonly reason: string;
      readonly droppedArgs: readonly string[];
    } {
  try {
    if (args.provider === "codex") {
      const resume = buildCodexResumeCommand(args.baseCommand, args.sessionId);
      return {
        supported: true,
        command: resume.command,
        droppedArgs: resume.droppedArgs,
      };
    }
    if (args.provider === "claude") {
      return {
        supported: true,
        command: buildClaudeResumeCommand(args.baseCommand, args.sessionId),
        droppedArgs: [],
      };
    }
    return {
      supported: false,
      reason:
        "custom operator commands do not have a checked-in resume adapter",
      droppedArgs: [],
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      droppedArgs: [],
    };
  }
}
