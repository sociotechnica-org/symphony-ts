import type { WatchdogConfig } from "../domain/workflow.js";

/** Reason a runner was classified as stalled. */
export type StallReason = "log-stall" | "workspace-stall" | "pr-stall";

/** Liveness snapshot captured per active issue. */
export interface LivenessSnapshot {
  readonly logSizeBytes: number | null;
  readonly workspaceDiffHash: string | null;
  readonly prHeadSha: string | null;
  readonly hasActionableFeedback: boolean;
  readonly capturedAt: number;
}

/** Per-issue watchdog tracking entry. */
export interface WatchdogEntry {
  readonly issueNumber: number;
  lastLiveness: LivenessSnapshot;
  lastChangeAt: number;
  recoveryCount: number;
}

/** Result of a stall check for a single issue. */
export interface StallCheckResult {
  readonly issueNumber: number;
  readonly stalled: boolean;
  readonly reason: StallReason | null;
  readonly stalledForMs: number;
}

/**
 * Create a fresh watchdog entry for an issue.
 */
export function createWatchdogEntry(
  issueNumber: number,
  snapshot: LivenessSnapshot,
): WatchdogEntry {
  return {
    issueNumber,
    lastLiveness: snapshot,
    lastChangeAt: snapshot.capturedAt,
    recoveryCount: 0,
  };
}

/**
 * Check whether an issue's runner has stalled based on liveness signals.
 *
 * Pure function: compares the new snapshot against the tracked entry
 * and returns whether the issue is stalled and why.
 */
export function checkStall(
  entry: WatchdogEntry,
  current: LivenessSnapshot,
  config: WatchdogConfig,
): StallCheckResult {
  const previous = entry.lastLiveness;
  let changed = false;

  // Check log growth
  if (
    current.logSizeBytes !== null &&
    previous.logSizeBytes !== null &&
    current.logSizeBytes !== previous.logSizeBytes
  ) {
    changed = true;
  }

  // Check workspace diff changes
  if (
    current.workspaceDiffHash !== null &&
    previous.workspaceDiffHash !== null &&
    current.workspaceDiffHash !== previous.workspaceDiffHash
  ) {
    changed = true;
  }

  // Check PR head movement
  if (
    current.prHeadSha !== null &&
    previous.prHeadSha !== null &&
    current.prHeadSha !== previous.prHeadSha
  ) {
    changed = true;
  }

  if (changed) {
    entry.lastLiveness = current;
    entry.lastChangeAt = current.capturedAt;
    return {
      issueNumber: entry.issueNumber,
      stalled: false,
      reason: null,
      stalledForMs: 0,
    };
  }

  // Update snapshot even if no change detected
  entry.lastLiveness = current;

  const stalledForMs = current.capturedAt - entry.lastChangeAt;
  if (stalledForMs < config.stallThresholdMs) {
    return {
      issueNumber: entry.issueNumber,
      stalled: false,
      reason: null,
      stalledForMs,
    };
  }

  // Classify the stall reason
  const reason = classifyStallReason(current);
  return {
    issueNumber: entry.issueNumber,
    stalled: true,
    reason,
    stalledForMs,
  };
}

/**
 * Classify stall reason based on available signals.
 *
 * Priority: PR stall (actionable feedback with no head movement)
 * > workspace stall > log stall.
 */
export function classifyStallReason(snapshot: LivenessSnapshot): StallReason {
  if (snapshot.hasActionableFeedback && snapshot.prHeadSha !== null) {
    return "pr-stall";
  }
  if (snapshot.workspaceDiffHash !== null) {
    return "workspace-stall";
  }
  return "log-stall";
}

/**
 * Check whether recovery is allowed for this issue.
 */
export function canRecover(
  entry: WatchdogEntry,
  config: WatchdogConfig,
): boolean {
  return entry.recoveryCount < config.maxRecoveryAttempts;
}

/**
 * Record a recovery attempt for this issue.
 */
export function recordRecovery(entry: WatchdogEntry): void {
  entry.recoveryCount += 1;
}

/** Default watchdog config for use when not specified. */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: false,
  checkIntervalMs: 60_000,
  stallThresholdMs: 300_000,
  maxRecoveryAttempts: 2,
};
