import type { WatchdogConfig } from "../domain/workflow.js";
import type { RunnerVisibilityPhase } from "../runner/service.js";

/** Reason a runner was classified as stalled. */
export type StallReason = "log-stall" | "workspace-stall" | "pr-stall";

export type LivenessSource =
  | "run-start"
  | "runner-startup"
  | "runner-heartbeat"
  | "runner-action"
  | "watchdog-log"
  | "workspace-diff"
  | "pr-head";

/** Liveness snapshot captured per active issue. */
export interface LivenessSnapshot {
  readonly logSizeBytes: number | null;
  readonly workspaceDiffHash: string | null;
  readonly prHeadSha: string | null;
  readonly runStartedAt: string | null;
  readonly runnerPhase: RunnerVisibilityPhase | null;
  readonly runnerHeartbeatAt: string | null;
  readonly runnerActionAt: string | null;
  readonly hasActionableFeedback: boolean;
  readonly capturedAt: number;
}

/** Per-issue watchdog tracking entry. */
export interface WatchdogEntry {
  readonly issueNumber: number;
  // These fields are intentionally mutated in place by checkStall() and
  // recordWatchdogRecovery() so the watchdog loop can update per-issue state
  // without allocating a replacement entry every poll.
  lastLiveness: LivenessSnapshot;
  lastObservableActivityAt: number;
  lastObservableActivitySource: LivenessSource | null;
  recoveryCount: number;
}

/** Result of a stall check for a single issue. */
export interface StallCheckResult {
  readonly issueNumber: number;
  readonly stalled: boolean;
  readonly reason: StallReason | null;
  // When stalled, this is the idle duration since the credited last observable
  // activity. On the non-stalled activity-detected path it is only the lag
  // between the current probe wall clock and the credited activity timestamp.
  readonly stalledForMs: number;
  readonly appliedThresholdMs: number;
  readonly lastObservableActivityAt: number;
  readonly lastObservableActivitySource: LivenessSource | null;
}

/**
 * Create a fresh watchdog entry for an issue.
 */
export function createWatchdogEntry(
  issueNumber: number,
  snapshot: LivenessSnapshot,
  recoveryCount = 0,
): WatchdogEntry {
  const initialActivity = deriveInitialObservableActivity(snapshot);
  return {
    issueNumber,
    lastLiveness: snapshot,
    lastObservableActivityAt: initialActivity.at,
    lastObservableActivitySource: initialActivity.source,
    recoveryCount,
  };
}

/**
 * Check whether an issue's runner has stalled based on liveness signals.
 *
 * Updates `entry.lastLiveness` and the authoritative last observable activity
 * as a side effect.
 * Returns whether the issue is stalled and why.
 */
export function checkStall(
  entry: WatchdogEntry,
  current: LivenessSnapshot,
  config: WatchdogConfig,
): StallCheckResult {
  const previous = entry.lastLiveness;
  const appliedThresholdMs = resolveStallThresholdMs(current, config);

  const activity = detectObservableActivity(previous, current);
  // Only credit activity that is at-or-after the last known baseline.
  // A runner may report heartbeat/action timestamps that are older than the
  // run-start anchor because of clock skew or delayed propagation; that still
  // updates visibility, but it must not reset the watchdog deadline.
  if (activity !== null && activity.at >= entry.lastObservableActivityAt) {
    // Clamp runner-reported timestamps to the probe wall clock so a fast
    // runner clock cannot push the baseline into the future and disable stall
    // detection with negative idle durations. An exact tie still updates the
    // source to the freshest signal, but it does not advance the baseline or
    // reset the stall timer.
    const creditedAt = Math.min(activity.at, current.capturedAt);
    entry.lastLiveness = current;
    entry.lastObservableActivityAt = creditedAt;
    entry.lastObservableActivitySource = activity.source;
    return {
      issueNumber: entry.issueNumber,
      stalled: false,
      reason: null,
      stalledForMs: current.capturedAt - creditedAt,
      appliedThresholdMs,
      lastObservableActivityAt: entry.lastObservableActivityAt,
      lastObservableActivitySource: entry.lastObservableActivitySource,
    };
  }

  // Update snapshot even if no change detected
  entry.lastLiveness = current;

  const stalledForMs = current.capturedAt - entry.lastObservableActivityAt;
  if (stalledForMs < appliedThresholdMs) {
    return {
      issueNumber: entry.issueNumber,
      stalled: false,
      reason: null,
      stalledForMs,
      appliedThresholdMs,
      lastObservableActivityAt: entry.lastObservableActivityAt,
      lastObservableActivitySource: entry.lastObservableActivitySource,
    };
  }

  // Classify the stall reason
  const reason = classifyStallReason(current);
  return {
    issueNumber: entry.issueNumber,
    stalled: true,
    reason,
    stalledForMs,
    appliedThresholdMs,
    lastObservableActivityAt: entry.lastObservableActivityAt,
    lastObservableActivitySource: entry.lastObservableActivitySource,
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

/** Default watchdog config for use when not specified. */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: false,
  checkIntervalMs: 60_000,
  stallThresholdMs: 300_000,
  executionStallThresholdMs: 300_000,
  prFollowThroughStallThresholdMs: 300_000,
  maxRecoveryAttempts: 2,
};

export function resolveStallThresholdMs(
  snapshot: LivenessSnapshot,
  config: WatchdogConfig,
): number {
  if (snapshot.prHeadSha !== null) {
    return config.prFollowThroughStallThresholdMs;
  }
  return config.executionStallThresholdMs;
}

interface ObservableActivity {
  readonly at: number;
  readonly source: LivenessSource | null;
}

function deriveInitialObservableActivity(
  snapshot: LivenessSnapshot,
): ObservableActivity {
  const candidates: ObservableActivity[] = [];

  const runStartedAt = parseTimestamp(snapshot.runStartedAt);
  if (runStartedAt !== null) {
    candidates.push({
      at: Math.min(runStartedAt, snapshot.capturedAt),
      source: "run-start",
    });
  }

  const runnerHeartbeatAt = parseTimestamp(snapshot.runnerHeartbeatAt);
  if (runnerHeartbeatAt !== null) {
    candidates.push({
      at: Math.min(runnerHeartbeatAt, snapshot.capturedAt),
      source: "runner-heartbeat",
    });
  }

  const runnerActionAt = parseTimestamp(snapshot.runnerActionAt);
  if (runnerActionAt !== null) {
    candidates.push({
      at: Math.min(runnerActionAt, snapshot.capturedAt),
      source: isStartupPhase(snapshot.runnerPhase)
        ? "runner-startup"
        : "runner-action",
    });
  }

  return (
    latestObservableActivity(candidates) ?? {
      at: snapshot.capturedAt,
      source: null,
    }
  );
}

function detectObservableActivity(
  previous: LivenessSnapshot,
  current: LivenessSnapshot,
): ObservableActivity | null {
  const candidates: ObservableActivity[] = [];

  if (
    current.logSizeBytes !== null &&
    current.logSizeBytes !== previous.logSizeBytes
  ) {
    candidates.push({
      at: current.capturedAt,
      source: "watchdog-log",
    });
  }

  if (
    current.workspaceDiffHash !== null &&
    current.workspaceDiffHash !== previous.workspaceDiffHash
  ) {
    candidates.push({
      at: current.capturedAt,
      source: "workspace-diff",
    });
  }

  if (current.prHeadSha !== null && current.prHeadSha !== previous.prHeadSha) {
    candidates.push({
      at: current.capturedAt,
      source: "pr-head",
    });
  }

  if (
    current.runnerHeartbeatAt !== null &&
    current.runnerHeartbeatAt !== previous.runnerHeartbeatAt
  ) {
    const runnerHeartbeatAt = parseTimestamp(current.runnerHeartbeatAt);
    if (runnerHeartbeatAt !== null) {
      candidates.push({
        at: runnerHeartbeatAt,
        source: "runner-heartbeat",
      });
    }
    // If the raw heartbeat string changed but is unparseable, this update
    // cannot advance the authoritative timestamp. We still replace
    // entry.lastLiveness below so a later valid heartbeat string is detected as
    // a new change instead of being masked by the malformed value.
  }

  if (
    current.runnerActionAt !== null &&
    current.runnerActionAt !== previous.runnerActionAt
  ) {
    const runnerActionAt = parseTimestamp(current.runnerActionAt);
    if (runnerActionAt !== null) {
      candidates.push({
        at: runnerActionAt,
        source: isStartupPhase(current.runnerPhase)
          ? "runner-startup"
          : "runner-action",
      });
    }
    // Same as runnerHeartbeatAt above: a malformed action timestamp is visible
    // in lastLiveness for future comparisons, but it cannot be credited as
    // observable activity until the runner reports a parseable timestamp.
  }

  return latestObservableActivity(candidates);
}

function latestObservableActivity(
  candidates: readonly ObservableActivity[],
): ObservableActivity | null {
  let latest: ObservableActivity | null = null;
  for (const candidate of candidates) {
    // Candidate push order is the priority order for tied timestamps:
    // run-start > runner-heartbeat > runner-startup/action during startup
    // derivation, and watchdog-log > workspace-diff > pr-head >
    // runner-heartbeat > runner-startup/action during incremental detection.
    // Strict greater-than preserves the first (highest-priority) candidate.
    if (latest === null || candidate.at > latest.at) {
      latest = candidate;
    }
  }
  return latest;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isStartupPhase(
  phase: RunnerVisibilityPhase | null,
): phase is "boot" | "session-start" {
  return phase === "boot" || phase === "session-start";
}
