import type { WorkspaceCleanupResult } from "../domain/workspace.js";
import type { WorkspaceRetentionPolicy } from "../domain/workflow.js";

export type WorkspaceRetentionReason = "success" | "failure" | "retry";

export type WorkspaceRetentionState =
  | "retry-retained"
  | "terminal-retained"
  | "cleanup-requested"
  | "cleanup-succeeded"
  | "cleanup-failed";

export interface RetainWorkspaceDecision {
  readonly reason: WorkspaceRetentionReason;
  readonly state: "retry-retained" | "terminal-retained";
  readonly action: "retain";
}

export interface CleanupWorkspaceDecision {
  readonly reason: WorkspaceRetentionReason;
  readonly state: "cleanup-requested";
  readonly action: "cleanup";
}

export type WorkspaceRetentionDecision =
  | RetainWorkspaceDecision
  | CleanupWorkspaceDecision;

export interface WorkspaceRetentionOutcome {
  readonly reason: WorkspaceRetentionReason;
  readonly state:
    | "retry-retained"
    | "terminal-retained"
    | "cleanup-succeeded"
    | "cleanup-failed";
  readonly action: "retain" | "cleanup";
  readonly cleanupResult?: WorkspaceCleanupResult;
  readonly cleanupError?: string;
}

export function decideRetryWorkspaceRetention(): RetainWorkspaceDecision {
  return {
    reason: "retry",
    state: "retry-retained",
    action: "retain",
  };
}

export function decideTerminalWorkspaceRetention(
  policy: WorkspaceRetentionPolicy,
  outcome: "success" | "failure",
): WorkspaceRetentionDecision {
  const mode = outcome === "success" ? policy.onSuccess : policy.onFailure;
  if (mode === "retain") {
    return {
      reason: outcome,
      state: "terminal-retained",
      action: "retain",
    };
  }
  return {
    reason: outcome,
    state: "cleanup-requested",
    action: "cleanup",
  };
}

export function classifyWorkspaceCleanupSuccess(
  decision: CleanupWorkspaceDecision,
  cleanupResult: WorkspaceCleanupResult,
): WorkspaceRetentionOutcome {
  return {
    reason: decision.reason,
    state: "cleanup-succeeded",
    action: "cleanup",
    cleanupResult,
  };
}

export function classifyWorkspaceCleanupFailure(
  decision: CleanupWorkspaceDecision,
  cleanupError: string,
): WorkspaceRetentionOutcome {
  return {
    reason: decision.reason,
    state: "cleanup-failed",
    action: "cleanup",
    cleanupError,
  };
}

export function finalizeRetainedWorkspace(
  decision: RetainWorkspaceDecision,
): WorkspaceRetentionOutcome {
  return {
    reason: decision.reason,
    state: decision.state,
    action: "retain",
  };
}
