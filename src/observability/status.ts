import fs from "node:fs/promises";
import path from "node:path";
import type { RetryClass } from "../domain/retry.js";
import { ObservabilityError } from "../domain/errors.js";
import type { ActiveRunExecutionOwner } from "../domain/execution-owner.js";
import type { DispatchPressureStateSnapshot } from "../domain/transient-failure.js";
import {
  parseFactoryRuntimeIdentity,
  renderFactoryRuntimeIdentity,
  type FactoryRuntimeIdentity,
} from "./runtime-identity.js";
import type {
  RunnerSessionDescription,
  RunnerTransportKind,
  RunnerVisibilityPhase,
  RunnerVisibilitySnapshot,
  RunnerVisibilityState,
} from "../runner/service.js";
import {
  createRunnerTransportMetadata,
  withRunnerTransportLocalProcess,
} from "../runner/service.js";
import type { RunnerAccountingSnapshot } from "../runner/accounting.js";

let snapshotWriteSequence = 0;

export type FactoryState = "idle" | "running" | "blocked";

export type FactoryRestartRecoveryState =
  | "idle"
  | "reconciling"
  | "degraded"
  | "ready";

export type FactoryIssueStatus =
  | "queued"
  | "preparing"
  | "running"
  | "shutdown-terminated"
  | "shutdown-forced"
  | "awaiting-human-handoff"
  | "merged"
  | "awaiting-human-review"
  | "awaiting-system-checks"
  | "awaiting-landing-command"
  | "awaiting-landing"
  | "rework-required";

export interface FactoryWorkerSnapshot {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly pollIntervalMs: number;
  readonly maxConcurrentRuns: number;
}

export interface FactoryStatusCounts {
  /** Tracker-level label counts refreshed from the tracker on each poll. */
  readonly ready: number;
  readonly running: number;
  readonly failed: number;
  /** Local process state for the current factory instance. */
  readonly activeLocalRuns: number;
  /** Local in-memory retry queue size, not a tracker-level label count. */
  readonly retries: number;
}

export interface FactoryStatusAction {
  readonly kind: string;
  readonly summary: string;
  readonly at: string;
  readonly issueNumber: number | null;
}

export interface FactoryRestartRecoveryIssueSnapshot {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly branchName: string;
  readonly decision:
    | "adopted"
    | "recovered-shutdown"
    | "requeued"
    | "suppressed-terminal"
    | "degraded";
  readonly leaseState:
    | "missing"
    | "active"
    | "shutdown-terminated"
    | "shutdown-forced"
    | "stale-owner"
    | "stale-owner-runner"
    | "invalid";
  readonly lifecycleKind:
    | "missing-target"
    | "awaiting-human-handoff"
    | "awaiting-human-review"
    | "awaiting-system-checks"
    | "awaiting-landing-command"
    | "awaiting-landing"
    | "rework-required"
    | "handoff-ready"
    | null;
  readonly executionOwner: ActiveRunExecutionOwner | null;
  readonly ownerPid: number | null;
  readonly ownerAlive: boolean | null;
  readonly runnerPid: number | null;
  readonly runnerAlive: boolean | null;
  readonly summary: string;
  readonly observedAt: string;
}

export interface FactoryRestartRecoverySnapshot {
  readonly state: FactoryRestartRecoveryState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly summary: string | null;
  readonly issues: readonly FactoryRestartRecoveryIssueSnapshot[];
}

export interface FactoryPullRequestStatus {
  readonly number: number;
  readonly url: string;
  readonly headSha: string | null;
  readonly latestCommitAt: string | null;
}

export interface FactoryCheckStatus {
  readonly pendingNames: readonly string[];
  readonly failingNames: readonly string[];
}

export interface FactoryReviewStatus {
  readonly actionableCount: number;
  readonly unresolvedThreadCount: number;
}

export interface FactoryActiveIssueSnapshot {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly source: "ready" | "running";
  readonly runSequence: number;
  readonly status: FactoryIssueStatus;
  readonly summary: string;
  readonly workspacePath: string | null;
  readonly branchName: string;
  readonly runSessionId: string | null;
  readonly executionOwner: ActiveRunExecutionOwner | null;
  readonly ownerPid: number | null;
  readonly runnerPid: number | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly pullRequest: FactoryPullRequestStatus | null;
  readonly checks: FactoryCheckStatus;
  readonly review: FactoryReviewStatus;
  readonly blockedReason: string | null;
  readonly runnerAccounting?: RunnerAccountingSnapshot | undefined;
  readonly runnerVisibility: RunnerVisibilitySnapshot | null;
}

export interface FactoryRetrySnapshot {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly nextAttempt: number;
  readonly retryClass: RetryClass;
  readonly scheduledAt: string;
  readonly backoffMs: number;
  readonly dueAt: string;
  readonly lastError: string;
}

export type FactoryRecoveryPostureFamily =
  | "healthy"
  | "waiting-expected"
  | "restart-recovery"
  | "retry-backoff"
  | "watchdog-recovery"
  | "cleanup-terminal"
  | "degraded-observability"
  | "degraded";

export interface FactoryRecoveryPostureEntry {
  readonly family: FactoryRecoveryPostureFamily;
  readonly issueNumber: number | null;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
  readonly source:
    | "active-issue"
    | "retry-queue"
    | "restart-recovery"
    | "terminal-cleanup"
    | "watchdog"
    | "snapshot";
  readonly summary: string;
  readonly observedAt: string | null;
}

export interface FactoryRecoveryPostureSummary {
  readonly family: FactoryRecoveryPostureFamily;
  readonly summary: string;
  readonly issueCount: number;
}

export interface FactoryRecoveryPostureSnapshot {
  readonly summary: FactoryRecoveryPostureSummary;
  readonly entries: readonly FactoryRecoveryPostureEntry[];
}

export interface FactoryStatusSnapshot {
  readonly version: 1;
  readonly generatedAt: string;
  readonly runtimeIdentity?: FactoryRuntimeIdentity | null;
  readonly publication?: FactoryStatusPublication;
  readonly dispatchPressure?: DispatchPressureStateSnapshot | null;
  readonly restartRecovery?: FactoryRestartRecoverySnapshot;
  readonly recoveryPosture?: FactoryRecoveryPostureSnapshot;
  readonly factoryState: FactoryState;
  readonly worker: FactoryWorkerSnapshot;
  readonly counts: FactoryStatusCounts;
  readonly lastAction: FactoryStatusAction | null;
  readonly activeIssues: readonly FactoryActiveIssueSnapshot[];
  readonly retries: readonly FactoryRetrySnapshot[];
}

export type FactoryStatusPublicationState = "current" | "initializing";

export interface FactoryStatusPublication {
  readonly state: FactoryStatusPublicationState;
  readonly detail: string | null;
}

export type FactoryStatusFreshness = "fresh" | "stale" | "unavailable";

export type FactoryStatusFreshnessReason =
  | "current-snapshot"
  | "worker-offline"
  | "startup-in-progress"
  | "startup-failed"
  | "no-live-runtime"
  | "missing-snapshot"
  | "unreadable-snapshot";

export interface FactoryStatusFreshnessAssessment {
  readonly freshness: FactoryStatusFreshness;
  readonly reason: FactoryStatusFreshnessReason;
  readonly summary: string;
  readonly workerAlive: boolean | null;
  readonly publicationState: FactoryStatusPublicationState | null;
}

export function deriveStatusFilePath(workspaceRoot: string): string {
  const parent = path.dirname(workspaceRoot);
  if (parent === workspaceRoot) {
    return path.join(workspaceRoot, "status.json");
  }
  return path.join(parent, "status.json");
}

export async function writeFactoryStatusSnapshot(
  filePath: string,
  snapshot: FactoryStatusSnapshot,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.status.${process.pid.toString()}.${snapshotWriteSequence.toString()}.tmp`,
  );
  snapshotWriteSequence += 1;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readFactoryStatusSnapshot(
  filePath: string,
): Promise<FactoryStatusSnapshot> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseFactoryStatusSnapshotContent(raw, filePath);
}

export function parseFactoryStatusSnapshotContent(
  raw: string,
  filePath: string,
): FactoryStatusSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ObservabilityError(
      `Failed to parse factory status snapshot at ${filePath}`,
      {
        cause: error as Error,
      },
    );
  }
  return parseFactoryStatusSnapshot(parsed, filePath);
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function renderFactoryStatusSnapshot(
  snapshot: FactoryStatusSnapshot,
  options?: {
    readonly statusFilePath?: string;
    readonly freshness?: FactoryStatusFreshnessAssessment;
  },
): string {
  const lines: string[] = [];
  const freshness = options?.freshness ?? assessFactoryStatusSnapshot(snapshot);
  const workerAlive = freshness.workerAlive;
  const workerState =
    workerAlive === null ? "unknown" : workerAlive ? "online" : "offline";

  lines.push(`Factory: ${snapshot.factoryState}`);
  lines.push(`Snapshot freshness: ${freshness.freshness}`);
  lines.push(`Snapshot detail: ${freshness.summary}`);
  lines.push(
    `Worker: ${workerState} pid=${snapshot.worker.pid.toString()} instance=${snapshot.worker.instanceId}`,
  );
  const publication = getFactoryStatusPublication(snapshot);
  lines.push(`Snapshot state: ${publication.state}`);
  if (publication.detail !== null) {
    lines.push(`Snapshot state detail: ${publication.detail}`);
  }
  const restartRecovery = getFactoryRestartRecovery(snapshot);
  const recoveryPosture = getFactoryRecoveryPosture(snapshot);
  const dispatchPressure = snapshot.dispatchPressure ?? null;
  lines.push(`Restart recovery: ${restartRecovery.state}`);
  if (restartRecovery.summary !== null) {
    lines.push(`Restart recovery detail: ${restartRecovery.summary}`);
  }
  lines.push(
    `Dispatch pressure: ${
      dispatchPressure === null
        ? "open"
        : `${dispatchPressure.retryClass} until ${dispatchPressure.resumeAt}`
    }`,
  );
  if (dispatchPressure !== null) {
    lines.push(`Dispatch pressure detail: ${dispatchPressure.reason}`);
  }
  lines.push(`Recovery posture: ${recoveryPosture.summary.family}`);
  lines.push(`Recovery detail: ${recoveryPosture.summary.summary}`);
  lines.push(
    `Started: ${snapshot.worker.startedAt}  Snapshot: ${snapshot.generatedAt}`,
  );
  lines.push(
    `Counts: ready=${snapshot.counts.ready.toString()} tracker_running=${snapshot.counts.running.toString()} failed=${snapshot.counts.failed.toString()} local=${snapshot.counts.activeLocalRuns.toString()} retries=${snapshot.counts.retries.toString()}`,
  );
  lines.push(
    `Polling: every ${snapshot.worker.pollIntervalMs.toString()}ms, max concurrency ${snapshot.worker.maxConcurrentRuns.toString()}`,
  );
  lines.push(
    `Runtime checkout: ${snapshot.runtimeIdentity?.checkoutPath ?? "unavailable"}`,
  );
  lines.push(
    `Runtime version: ${renderFactoryRuntimeIdentity(snapshot.runtimeIdentity)}`,
  );
  if (options?.statusFilePath) {
    lines.push(`Snapshot file: ${options.statusFilePath}`);
  }

  if (snapshot.lastAction === null) {
    lines.push("Last action: none");
  } else {
    const issueSuffix =
      snapshot.lastAction.issueNumber === null
        ? ""
        : ` issue #${snapshot.lastAction.issueNumber.toString()}`;
    lines.push(
      `Last action: ${snapshot.lastAction.kind}${issueSuffix} at ${snapshot.lastAction.at} - ${snapshot.lastAction.summary}`,
    );
  }

  lines.push("");
  lines.push("Recovery posture entries:");
  if (recoveryPosture.entries.length === 0) {
    lines.push("  none");
  } else {
    for (const entry of recoveryPosture.entries) {
      const issuePrefix =
        entry.issueNumber === null
          ? ""
          : ` #${entry.issueNumber.toString()} ${entry.issueIdentifier ?? ""}`.trimEnd();
      lines.push(`  [${entry.family}]${issuePrefix}`);
      lines.push(`    Summary: ${entry.summary}`);
      lines.push(`    Source: ${entry.source}`);
      if (entry.observedAt !== null) {
        lines.push(`    Observed: ${entry.observedAt}`);
      }
    }
  }

  lines.push("");
  lines.push("Restart recovery issues:");
  if (restartRecovery.issues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of restartRecovery.issues) {
      lines.push(
        `  #${issue.issueNumber.toString()} ${issue.issueIdentifier} [${issue.decision}]`,
      );
      lines.push(`    Summary: ${issue.summary}`);
      lines.push(`    Branch: ${issue.branchName}`);
      lines.push(
        `    Lease: ${issue.leaseState}  Lifecycle: ${issue.lifecycleKind ?? "n/a"}`,
      );
      if (issue.executionOwner !== null) {
        lines.push(
          `    Execution: transport=${issue.executionOwner.transport.kind} factory=${issue.executionOwner.factory.host}/${issue.executionOwner.factory.instanceId} session=${issue.executionOwner.runSessionId}`,
        );
      }
      lines.push(
        `    PIDs: owner=${issue.ownerPid?.toString() ?? "n/a"} runner=${issue.runnerPid?.toString() ?? "n/a"}`,
      );
      lines.push(
        `    Liveness: owner=${issue.ownerAlive === null ? "n/a" : issue.ownerAlive ? "alive" : "dead"} runner=${issue.runnerAlive === null ? "n/a" : issue.runnerAlive ? "alive" : "dead"}`,
      );
      lines.push(`    Observed: ${issue.observedAt}`);
    }
  }

  lines.push("");
  lines.push("Active issues:");
  if (snapshot.activeIssues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of snapshot.activeIssues) {
      lines.push(
        `  #${issue.issueNumber.toString()} ${issue.title} [${issue.status}]`,
      );
      lines.push(`    Summary: ${issue.summary}`);
      lines.push(`    Branch: ${issue.branchName}`);
      lines.push(
        `    Source: ${issue.source} attempt=${issue.runSequence.toString()}`,
      );
      lines.push(
        `    Workspace: ${issue.workspacePath ?? "n/a"}  Session: ${issue.runSessionId ?? "n/a"}`,
      );
      if (issue.executionOwner !== null) {
        lines.push(
          `    Execution: transport=${issue.executionOwner.transport.kind} factory=${issue.executionOwner.factory.host}/${issue.executionOwner.factory.instanceId}`,
        );
      }
      lines.push(
        `    PIDs: owner=${issue.ownerPid?.toString() ?? "n/a"} runner=${issue.runnerPid?.toString() ?? "n/a"}`,
      );
      lines.push(
        `    Updated: ${issue.updatedAt}${issue.startedAt === null ? "" : `  Started: ${issue.startedAt}`}`,
      );
      if (issue.pullRequest !== null) {
        lines.push(
          `    PR: #${issue.pullRequest.number.toString()} ${issue.pullRequest.url}`,
        );
      } else {
        lines.push("    PR: none");
      }
      lines.push(
        `    Checks: pending=${issue.checks.pendingNames.length.toString()} failing=${issue.checks.failingNames.length.toString()}`,
      );
      if (issue.checks.pendingNames.length > 0) {
        lines.push(
          `    Pending checks: ${issue.checks.pendingNames.join(", ")}`,
        );
      }
      if (issue.checks.failingNames.length > 0) {
        lines.push(
          `    Failing checks: ${issue.checks.failingNames.join(", ")}`,
        );
      }
      lines.push(
        `    Review: actionable=${issue.review.actionableCount.toString()} unresolved_threads=${issue.review.unresolvedThreadCount.toString()}`,
      );
      if (issue.runnerAccounting !== undefined) {
        lines.push(
          `    Accounting: ${issue.runnerAccounting.status} total_tokens=${renderNullableNumber(issue.runnerAccounting.totalTokens)} cost_usd=${renderNullableNumber(issue.runnerAccounting.costUsd)}`,
        );
      }
      if (issue.blockedReason !== null) {
        lines.push(`    Blocked: ${issue.blockedReason}`);
      }
      if (issue.runnerVisibility !== null) {
        const visibility = issue.runnerVisibility;
        lines.push(
          `    Runner: ${visibility.state} phase=${visibility.phase} provider=${visibility.session.provider}`,
        );
        if (visibility.session.model !== null) {
          lines.push(`    Runner model: ${visibility.session.model}`);
        }
        if (visibility.lastActionSummary !== null) {
          lines.push(
            `    Runner action: ${visibility.lastActionSummary}${
              visibility.lastActionAt === null
                ? ""
                : ` at ${visibility.lastActionAt}`
            }`,
          );
        }
        if (visibility.waitingReason !== null) {
          lines.push(`    Runner waiting: ${visibility.waitingReason}`);
        }
        if (visibility.lastHeartbeatAt !== null) {
          lines.push(`    Runner heartbeat: ${visibility.lastHeartbeatAt}`);
        }
        if (visibility.stdoutSummary !== null) {
          lines.push(`    Runner stdout: ${visibility.stdoutSummary}`);
        }
        if (visibility.stderrSummary !== null) {
          lines.push(`    Runner stderr: ${visibility.stderrSummary}`);
        }
        if (visibility.errorSummary !== null) {
          lines.push(`    Runner error: ${visibility.errorSummary}`);
        }
        if (visibility.cancelledAt !== null) {
          lines.push(`    Runner cancelled: ${visibility.cancelledAt}`);
        }
        if (visibility.timedOutAt !== null) {
          lines.push(`    Runner timed out: ${visibility.timedOutAt}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("Retries:");
  if (snapshot.retries.length === 0) {
    lines.push("  none");
  } else {
    for (const retry of snapshot.retries) {
      lines.push(
        `  #${retry.issueNumber.toString()} ${retry.title} attempt ${retry.nextAttempt.toString()} [${retry.retryClass}] at ${retry.dueAt}`,
      );
      lines.push(
        `    Scheduled: ${retry.scheduledAt} (+${retry.backoffMs.toString()}ms)`,
      );
      lines.push(`    Error: ${retry.lastError}`);
    }
  }

  return lines.join("\n");
}

export function getFactoryStatusPublication(
  snapshot: FactoryStatusSnapshot,
): FactoryStatusPublication {
  return snapshot.publication ?? { state: "current", detail: null };
}

export function getFactoryRestartRecovery(
  snapshot: FactoryStatusSnapshot,
): FactoryRestartRecoverySnapshot {
  return (
    snapshot.restartRecovery ?? {
      state: "idle",
      startedAt: null,
      completedAt: null,
      summary: null,
      issues: [],
    }
  );
}

export function getFactoryRecoveryPosture(
  snapshot: FactoryStatusSnapshot,
): FactoryRecoveryPostureSnapshot {
  return (
    snapshot.recoveryPosture ?? {
      summary: {
        family: "healthy",
        summary: "No active recovery posture is present.",
        issueCount: 0,
      },
      entries: [],
    }
  );
}

/**
 * Assesses whether a persisted factory status snapshot can be treated as
 * current for operator-facing status surfaces.
 *
 * NOTE: when `options.workerAlive` is omitted, this function calls
 * `isProcessAlive(snapshot.worker.pid)`, which performs an OS-level signal
 * probe. Pass `workerAlive` explicitly in hot-path or test contexts to avoid
 * that syscall.
 */
export function assessFactoryStatusSnapshot(
  snapshot: FactoryStatusSnapshot | null,
  options?: {
    readonly workerAlive?: boolean;
    /**
     * When omitted, the no-live-runtime stale check is skipped because the
     * caller does not have authoritative runtime/session ownership context.
     * Pass `true` or `false` explicitly to enable that classification path.
     */
    readonly hasLiveRuntime?: boolean;
    readonly readError?: Error | null;
  },
): FactoryStatusFreshnessAssessment {
  if (options?.readError !== undefined && options.readError !== null) {
    return {
      freshness: "unavailable",
      reason: "unreadable-snapshot",
      summary: options.readError.message,
      workerAlive: null,
      publicationState: null,
    };
  }

  if (snapshot === null) {
    return {
      freshness: "unavailable",
      reason: "missing-snapshot",
      summary:
        options?.hasLiveRuntime === true
          ? "No current runtime snapshot is available yet."
          : "No runtime snapshot is available.",
      workerAlive: null,
      publicationState: null,
    };
  }

  const publication = getFactoryStatusPublication(snapshot);
  const workerAlive =
    options?.workerAlive ?? isProcessAlive(snapshot.worker.pid);
  if (publication.state === "initializing") {
    if (!workerAlive) {
      return {
        freshness: "stale",
        reason: "startup-failed",
        summary:
          "The startup placeholder belongs to an offline worker, so startup did not complete and this snapshot is historical.",
        workerAlive,
        publicationState: publication.state,
      };
    }
    if (options?.hasLiveRuntime === false) {
      return {
        freshness: "stale",
        reason: "no-live-runtime",
        summary:
          "No live factory runtime owns this startup snapshot anymore, so it is historical and not current.",
        workerAlive,
        publicationState: publication.state,
      };
    }
    return {
      freshness: "unavailable",
      reason: "startup-in-progress",
      summary:
        publication.detail ??
        "Factory startup is in progress; no current runtime snapshot is available yet.",
      workerAlive,
      publicationState: publication.state,
    };
  }

  if (!workerAlive) {
    return {
      freshness: "stale",
      reason: "worker-offline",
      summary:
        "The recorded worker PID is offline, so this snapshot is historical and not current.",
      workerAlive,
      publicationState: publication.state,
    };
  }

  if (options?.hasLiveRuntime === false) {
    return {
      freshness: "stale",
      reason: "no-live-runtime",
      summary:
        "No live factory runtime owns this snapshot anymore, so it is historical and not current.",
      workerAlive,
      publicationState: publication.state,
    };
  }

  return {
    freshness: "fresh",
    reason: "current-snapshot",
    summary: "The snapshot belongs to the live factory runtime.",
    workerAlive,
    publicationState: publication.state,
  };
}

function renderNullableNumber(value: number | null): string {
  return value === null ? "n/a" : value.toString();
}

function parseFactoryStatusSnapshot(
  value: unknown,
  filePath: string,
): FactoryStatusSnapshot {
  const snapshot = expectObject(value, filePath, "snapshot");
  const version = expectInteger(snapshot.version, filePath, "version");
  if (version !== 1) {
    throw new ObservabilityError(
      `Unsupported factory status snapshot version at ${filePath}: expected 1, received ${version.toString()}`,
    );
  }

  return {
    version: 1,
    generatedAt: expectString(snapshot.generatedAt, filePath, "generatedAt"),
    runtimeIdentity: parseFactoryRuntimeIdentity(
      snapshot.runtimeIdentity,
      filePath,
      "runtimeIdentity",
    ),
    publication: parsePublication(snapshot.publication, filePath),
    dispatchPressure: parseDispatchPressure(
      snapshot.dispatchPressure,
      filePath,
      "dispatchPressure",
    ),
    restartRecovery: parseRestartRecovery(snapshot.restartRecovery, filePath),
    recoveryPosture: parseRecoveryPosture(snapshot.recoveryPosture, filePath),
    factoryState: expectEnum(
      snapshot.factoryState,
      ["idle", "running", "blocked"],
      filePath,
      "factoryState",
    ),
    worker: parseWorkerSnapshot(snapshot.worker, filePath),
    counts: parseCountsSnapshot(snapshot.counts, filePath),
    lastAction: parseLastAction(snapshot.lastAction, filePath),
    activeIssues: expectArray(
      snapshot.activeIssues,
      filePath,
      "activeIssues",
      (entry, index) =>
        parseActiveIssue(entry, filePath, `activeIssues[${index.toString()}]`),
    ),
    retries: expectArray(
      snapshot.retries,
      filePath,
      "retries",
      (entry, index) =>
        parseRetry(entry, filePath, `retries[${index.toString()}]`),
    ),
  };
}

function parseDispatchPressure(
  value: unknown,
  filePath: string,
  field: string,
): DispatchPressureStateSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  const pressure = expectObject(value, filePath, field);
  return {
    retryClass: expectEnum(
      pressure.retryClass,
      ["provider-rate-limit", "provider-account-pressure"],
      filePath,
      `${field}.retryClass`,
    ),
    reason: expectString(pressure.reason, filePath, `${field}.reason`),
    observedAt: expectString(
      pressure.observedAt,
      filePath,
      `${field}.observedAt`,
    ),
    resumeAt: expectString(pressure.resumeAt, filePath, `${field}.resumeAt`),
  };
}

function parsePublication(
  value: unknown,
  filePath: string,
): FactoryStatusPublication {
  if (value === undefined) {
    return {
      state: "current",
      detail: null,
    };
  }
  const publication = expectObject(value, filePath, "publication");
  return {
    state: expectEnum(
      publication.state,
      ["current", "initializing"],
      filePath,
      "publication.state",
    ),
    detail: expectNullableString(
      publication.detail,
      filePath,
      "publication.detail",
    ),
  };
}

function parseRestartRecovery(
  value: unknown,
  filePath: string,
): FactoryRestartRecoverySnapshot {
  if (value === undefined) {
    return {
      state: "idle",
      startedAt: null,
      completedAt: null,
      summary: null,
      issues: [],
    };
  }
  const recovery = expectObject(value, filePath, "restartRecovery");
  return {
    state: expectEnum(
      recovery.state,
      ["idle", "reconciling", "degraded", "ready"],
      filePath,
      "restartRecovery.state",
    ),
    startedAt: expectNullableString(
      recovery.startedAt,
      filePath,
      "restartRecovery.startedAt",
    ),
    completedAt: expectNullableString(
      recovery.completedAt,
      filePath,
      "restartRecovery.completedAt",
    ),
    summary: expectNullableString(
      recovery.summary,
      filePath,
      "restartRecovery.summary",
    ),
    issues: expectArray(
      recovery.issues,
      filePath,
      "restartRecovery.issues",
      (entry, index) =>
        parseRestartRecoveryIssue(
          entry,
          filePath,
          `restartRecovery.issues[${index.toString()}]`,
        ),
    ),
  };
}

function parseRecoveryPosture(
  value: unknown,
  filePath: string,
): FactoryRecoveryPostureSnapshot {
  if (value === undefined) {
    return {
      summary: {
        family: "healthy",
        summary: "No active recovery posture is present.",
        issueCount: 0,
      },
      entries: [],
    };
  }
  const posture = expectObject(value, filePath, "recoveryPosture");
  return {
    summary: parseRecoveryPostureSummary(posture.summary, filePath),
    entries: expectArray(
      posture.entries,
      filePath,
      "recoveryPosture.entries",
      (entry, index) =>
        parseRecoveryPostureEntry(
          entry,
          filePath,
          `recoveryPosture.entries[${index.toString()}]`,
        ),
    ),
  };
}

function parseRecoveryPostureSummary(
  value: unknown,
  filePath: string,
): FactoryRecoveryPostureSummary {
  const summary = expectObject(value, filePath, "recoveryPosture.summary");
  return {
    family: expectRecoveryPostureFamily(
      summary.family,
      filePath,
      "recoveryPosture.summary.family",
    ),
    summary: expectString(
      summary.summary,
      filePath,
      "recoveryPosture.summary.summary",
    ),
    issueCount: expectInteger(
      summary.issueCount,
      filePath,
      "recoveryPosture.summary.issueCount",
    ),
  };
}

function parseRecoveryPostureEntry(
  value: unknown,
  filePath: string,
  field: string,
): FactoryRecoveryPostureEntry {
  const entry = expectObject(value, filePath, field);
  return {
    family: expectRecoveryPostureFamily(
      entry.family,
      filePath,
      `${field}.family`,
    ),
    issueNumber: expectNullableInteger(
      entry.issueNumber,
      filePath,
      `${field}.issueNumber`,
    ),
    issueIdentifier: expectNullableString(
      entry.issueIdentifier,
      filePath,
      `${field}.issueIdentifier`,
    ),
    title: expectNullableString(entry.title, filePath, `${field}.title`),
    source: expectEnum(
      entry.source,
      [
        "active-issue",
        "retry-queue",
        "restart-recovery",
        "terminal-cleanup",
        "watchdog",
        "snapshot",
      ],
      filePath,
      `${field}.source`,
    ),
    summary: expectString(entry.summary, filePath, `${field}.summary`),
    observedAt: expectNullableString(
      entry.observedAt,
      filePath,
      `${field}.observedAt`,
    ),
  };
}

function parseRestartRecoveryIssue(
  value: unknown,
  filePath: string,
  field: string,
): FactoryRestartRecoveryIssueSnapshot {
  const issue = expectObject(value, filePath, field);
  return {
    issueNumber: expectInteger(
      issue.issueNumber,
      filePath,
      `${field}.issueNumber`,
    ),
    issueIdentifier: expectString(
      issue.issueIdentifier,
      filePath,
      `${field}.issueIdentifier`,
    ),
    branchName: expectString(issue.branchName, filePath, `${field}.branchName`),
    decision: expectEnum(
      issue.decision,
      [
        "adopted",
        "recovered-shutdown",
        "requeued",
        "suppressed-terminal",
        "degraded",
      ],
      filePath,
      `${field}.decision`,
    ),
    leaseState: expectEnum(
      issue.leaseState,
      [
        "missing",
        "active",
        "shutdown-terminated",
        "shutdown-forced",
        "stale-owner",
        "stale-owner-runner",
        "invalid",
      ],
      filePath,
      `${field}.leaseState`,
    ),
    lifecycleKind: expectNullableEnum(
      issue.lifecycleKind,
      [
        "missing-target",
        "awaiting-human-handoff",
        "awaiting-human-review",
        "awaiting-system-checks",
        "awaiting-landing-command",
        "awaiting-landing",
        "rework-required",
        "handoff-ready",
      ],
      filePath,
      `${field}.lifecycleKind`,
    ),
    executionOwner: parseExecutionOwner(
      issue.executionOwner,
      filePath,
      `${field}.executionOwner`,
    ),
    ownerPid: expectNullableInteger(
      issue.ownerPid,
      filePath,
      `${field}.ownerPid`,
    ),
    ownerAlive: expectNullableBoolean(
      issue.ownerAlive,
      filePath,
      `${field}.ownerAlive`,
    ),
    runnerPid: expectNullableInteger(
      issue.runnerPid,
      filePath,
      `${field}.runnerPid`,
    ),
    runnerAlive: expectNullableBoolean(
      issue.runnerAlive,
      filePath,
      `${field}.runnerAlive`,
    ),
    summary: expectString(issue.summary, filePath, `${field}.summary`),
    observedAt: expectString(issue.observedAt, filePath, `${field}.observedAt`),
  };
}

function parseWorkerSnapshot(
  value: unknown,
  filePath: string,
): FactoryWorkerSnapshot {
  const worker = expectObject(value, filePath, "worker");
  return {
    instanceId: expectString(worker.instanceId, filePath, "worker.instanceId"),
    pid: expectPositiveInteger(worker.pid, filePath, "worker.pid"),
    startedAt: expectString(worker.startedAt, filePath, "worker.startedAt"),
    pollIntervalMs: expectInteger(
      worker.pollIntervalMs,
      filePath,
      "worker.pollIntervalMs",
    ),
    maxConcurrentRuns: expectInteger(
      worker.maxConcurrentRuns,
      filePath,
      "worker.maxConcurrentRuns",
    ),
  };
}

function parseCountsSnapshot(
  value: unknown,
  filePath: string,
): FactoryStatusCounts {
  const counts = expectObject(value, filePath, "counts");
  return {
    ready: expectInteger(counts.ready, filePath, "counts.ready"),
    running: expectInteger(counts.running, filePath, "counts.running"),
    failed: expectInteger(counts.failed, filePath, "counts.failed"),
    activeLocalRuns: expectInteger(
      counts.activeLocalRuns,
      filePath,
      "counts.activeLocalRuns",
    ),
    retries: expectInteger(counts.retries, filePath, "counts.retries"),
  };
}

function parseLastAction(
  value: unknown,
  filePath: string,
): FactoryStatusAction | null {
  if (value === null || value === undefined) {
    return null;
  }
  const action = expectObject(value, filePath, "lastAction");
  return {
    kind: expectString(action.kind, filePath, "lastAction.kind"),
    summary: expectString(action.summary, filePath, "lastAction.summary"),
    at: expectString(action.at, filePath, "lastAction.at"),
    issueNumber: expectNullableInteger(
      action.issueNumber,
      filePath,
      "lastAction.issueNumber",
    ),
  };
}

function parseActiveIssue(
  value: unknown,
  filePath: string,
  field: string,
): FactoryActiveIssueSnapshot {
  const issue = expectObject(value, filePath, field);
  return {
    issueNumber: expectInteger(
      issue.issueNumber,
      filePath,
      `${field}.issueNumber`,
    ),
    issueIdentifier: expectString(
      issue.issueIdentifier,
      filePath,
      `${field}.issueIdentifier`,
    ),
    title: expectString(issue.title, filePath, `${field}.title`),
    source: expectEnum(
      issue.source,
      ["ready", "running"],
      filePath,
      `${field}.source`,
    ),
    runSequence: expectInteger(
      issue.runSequence,
      filePath,
      `${field}.runSequence`,
    ),
    status: expectEnum(
      issue.status,
      [
        "queued",
        "preparing",
        "running",
        "shutdown-terminated",
        "shutdown-forced",
        "awaiting-human-handoff",
        "merged",
        "awaiting-human-review",
        "awaiting-system-checks",
        "awaiting-landing-command",
        "awaiting-landing",
        "rework-required",
      ],
      filePath,
      `${field}.status`,
    ),
    summary: expectString(issue.summary, filePath, `${field}.summary`),
    workspacePath: expectNullableString(
      issue.workspacePath,
      filePath,
      `${field}.workspacePath`,
    ),
    branchName: expectString(issue.branchName, filePath, `${field}.branchName`),
    runSessionId: expectNullableString(
      issue.runSessionId,
      filePath,
      `${field}.runSessionId`,
    ),
    executionOwner: parseExecutionOwner(
      issue.executionOwner,
      filePath,
      `${field}.executionOwner`,
    ),
    ownerPid: expectNullableInteger(
      issue.ownerPid,
      filePath,
      `${field}.ownerPid`,
    ),
    runnerPid: expectNullableInteger(
      issue.runnerPid,
      filePath,
      `${field}.runnerPid`,
    ),
    startedAt: expectNullableString(
      issue.startedAt,
      filePath,
      `${field}.startedAt`,
    ),
    updatedAt: expectString(issue.updatedAt, filePath, `${field}.updatedAt`),
    pullRequest: parsePullRequest(
      issue.pullRequest,
      filePath,
      `${field}.pullRequest`,
    ),
    checks: parseCheckStatus(issue.checks, filePath, `${field}.checks`),
    review: parseReviewStatus(issue.review, filePath, `${field}.review`),
    blockedReason: expectNullableString(
      issue.blockedReason,
      filePath,
      `${field}.blockedReason`,
    ),
    runnerAccounting: parseRunnerAccounting(
      issue.runnerAccounting,
      filePath,
      `${field}.runnerAccounting`,
    ),
    runnerVisibility: parseRunnerVisibility(
      issue.runnerVisibility,
      filePath,
      `${field}.runnerVisibility`,
    ),
  };
}

function parseExecutionOwner(
  value: unknown,
  filePath: string,
  field: string,
): ActiveRunExecutionOwner | null {
  if (value === null || value === undefined) {
    return null;
  }
  const owner = expectObject(value, filePath, field);
  const factory = expectObject(owner.factory, filePath, `${field}.factory`);
  const transport = parseRunnerTransportMetadata(
    owner.transport,
    null,
    filePath,
    `${field}.transport`,
  );
  const localControl =
    owner.localControl === null || owner.localControl === undefined
      ? null
      : {
          host: expectString(
            expectObject(owner.localControl, filePath, `${field}.localControl`)
              .host,
            filePath,
            `${field}.localControl.host`,
          ),
          pid: expectNullableInteger(
            expectObject(owner.localControl, filePath, `${field}.localControl`)
              .pid,
            filePath,
            `${field}.localControl.pid`,
          ),
          canTerminate: expectNullableBoolean(
            expectObject(owner.localControl, filePath, `${field}.localControl`)
              .canTerminate,
            filePath,
            `${field}.localControl.canTerminate`,
          ) ?? false,
        };
  const endpoint = expectObject(owner.endpoint, filePath, `${field}.endpoint`);
  return {
    factory: {
      host: expectString(factory.host, filePath, `${field}.factory.host`),
      instanceId: expectString(
        factory.instanceId,
        filePath,
        `${field}.factory.instanceId`,
      ),
      pid: expectNullableInteger(factory.pid, filePath, `${field}.factory.pid`),
    },
    runSessionId: expectString(
      owner.runSessionId,
      filePath,
      `${field}.runSessionId`,
    ),
    transport,
    localControl,
    endpoint: {
      workspaceTargetKind: expectEnum(
        endpoint.workspaceTargetKind,
        ["local", "remote"],
        filePath,
        `${field}.endpoint.workspaceTargetKind`,
      ),
      workspaceHost: expectNullableString(
        endpoint.workspaceHost,
        filePath,
        `${field}.endpoint.workspaceHost`,
      ),
      workspacePath: expectNullableString(
        endpoint.workspacePath,
        filePath,
        `${field}.endpoint.workspacePath`,
      ),
      workspaceId: expectNullableString(
        endpoint.workspaceId,
        filePath,
        `${field}.endpoint.workspaceId`,
      ),
      provider: expectNullableString(
        endpoint.provider,
        filePath,
        `${field}.endpoint.provider`,
      ),
      model: expectNullableString(
        endpoint.model,
        filePath,
        `${field}.endpoint.model`,
      ),
      backendSessionId: expectNullableString(
        endpoint.backendSessionId,
        filePath,
        `${field}.endpoint.backendSessionId`,
      ),
      backendThreadId: expectNullableString(
        endpoint.backendThreadId,
        filePath,
        `${field}.endpoint.backendThreadId`,
      ),
    },
  };
}

function parseRunnerVisibility(
  value: unknown,
  filePath: string,
  field: string,
): RunnerVisibilitySnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  const visibility = expectObject(value, filePath, field);
  return {
    state: expectEnum<RunnerVisibilityState>(
      visibility.state,
      [
        "idle",
        "starting",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
        "timed-out",
      ],
      filePath,
      `${field}.state`,
    ),
    phase: expectEnum<RunnerVisibilityPhase>(
      visibility.phase,
      [
        "boot",
        "session-start",
        "turn-execution",
        "turn-finished",
        "handoff-reconciliation",
        "awaiting-external",
        "shutdown",
      ],
      filePath,
      `${field}.phase`,
    ),
    session: parseRunnerSessionDescription(
      visibility.session,
      filePath,
      `${field}.session`,
    ),
    lastHeartbeatAt: expectNullableString(
      visibility.lastHeartbeatAt,
      filePath,
      `${field}.lastHeartbeatAt`,
    ),
    lastActionAt: expectNullableString(
      visibility.lastActionAt,
      filePath,
      `${field}.lastActionAt`,
    ),
    lastActionSummary: expectNullableString(
      visibility.lastActionSummary,
      filePath,
      `${field}.lastActionSummary`,
    ),
    waitingReason: expectNullableString(
      visibility.waitingReason,
      filePath,
      `${field}.waitingReason`,
    ),
    stdoutSummary: expectNullableString(
      visibility.stdoutSummary,
      filePath,
      `${field}.stdoutSummary`,
    ),
    stderrSummary: expectNullableString(
      visibility.stderrSummary,
      filePath,
      `${field}.stderrSummary`,
    ),
    errorSummary: expectNullableString(
      visibility.errorSummary,
      filePath,
      `${field}.errorSummary`,
    ),
    cancelledAt: expectNullableString(
      visibility.cancelledAt,
      filePath,
      `${field}.cancelledAt`,
    ),
    timedOutAt: expectNullableString(
      visibility.timedOutAt,
      filePath,
      `${field}.timedOutAt`,
    ),
  };
}

function parseRunnerAccounting(
  value: unknown,
  filePath: string,
  field: string,
): RunnerAccountingSnapshot | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const accounting = expectObject(value, filePath, field);
  return {
    status: expectEnum(
      accounting.status,
      ["unavailable", "partial", "complete"],
      filePath,
      `${field}.status`,
    ),
    inputTokens: expectNullableNumber(
      accounting.inputTokens,
      filePath,
      `${field}.inputTokens`,
    ),
    outputTokens: expectNullableNumber(
      accounting.outputTokens,
      filePath,
      `${field}.outputTokens`,
    ),
    totalTokens: expectNullableNumber(
      accounting.totalTokens,
      filePath,
      `${field}.totalTokens`,
    ),
    costUsd: expectNullableNumber(
      accounting.costUsd,
      filePath,
      `${field}.costUsd`,
    ),
  };
}

function parseRunnerSessionDescription(
  value: unknown,
  filePath: string,
  field: string,
): RunnerSessionDescription {
  const session = expectObject(value, filePath, field);
  const legacyAppServerPid = expectNullableInteger(
    session.appServerPid,
    filePath,
    `${field}.appServerPid`,
  );
  return {
    provider: expectString(session.provider, filePath, `${field}.provider`),
    model: expectNullableString(session.model, filePath, `${field}.model`),
    transport: parseRunnerTransportMetadata(
      session.transport,
      legacyAppServerPid,
      filePath,
      `${field}.transport`,
    ),
    backendSessionId: expectNullableString(
      session.backendSessionId,
      filePath,
      `${field}.backendSessionId`,
    ),
    backendThreadId: expectNullableString(
      session.backendThreadId,
      filePath,
      `${field}.backendThreadId`,
    ),
    latestTurnId: expectNullableString(
      session.latestTurnId,
      filePath,
      `${field}.latestTurnId`,
    ),
    latestTurnNumber: expectNullableInteger(
      session.latestTurnNumber,
      filePath,
      `${field}.latestTurnNumber`,
    ),
    logPointers: expectArray(
      session.logPointers,
      filePath,
      `${field}.logPointers`,
      (entry, index) => {
        const pointer = expectObject(
          entry,
          filePath,
          `${field}.logPointers[${index.toString()}]`,
        );
        return {
          name: expectString(
            pointer.name,
            filePath,
            `${field}.logPointers[${index.toString()}].name`,
          ),
          location: expectNullableString(
            pointer.location,
            filePath,
            `${field}.logPointers[${index.toString()}].location`,
          ),
          archiveLocation: expectNullableString(
            pointer.archiveLocation,
            filePath,
            `${field}.logPointers[${index.toString()}].archiveLocation`,
          ),
        };
      },
    ),
  };
}

function parseRunnerTransportMetadata(
  value: unknown,
  legacyAppServerPid: number | null,
  filePath: string,
  field: string,
) {
  if (value === undefined) {
    return withRunnerTransportLocalProcess(
      createRunnerTransportMetadata(
        legacyAppServerPid === null ? "local-process" : "local-stdio-session",
        {
          canTerminateLocalProcess: true,
        },
      ),
      legacyAppServerPid,
    );
  }

  const transport = expectObject(value, filePath, field);
  return {
    kind: expectRunnerTransportKind(transport.kind, filePath, `${field}.kind`),
    localProcess:
      transport.localProcess === null || transport.localProcess === undefined
        ? null
        : parseRunnerLocalProcessMetadata(
            transport.localProcess,
            filePath,
            `${field}.localProcess`,
          ),
    remoteSessionId: expectNullableString(
      transport.remoteSessionId,
      filePath,
      `${field}.remoteSessionId`,
    ),
    remoteTaskId: expectNullableString(
      transport.remoteTaskId,
      filePath,
      `${field}.remoteTaskId`,
    ),
  };
}

function parseRunnerLocalProcessMetadata(
  value: unknown,
  filePath: string,
  field: string,
) {
  const localProcess = expectObject(value, filePath, field);
  const canTerminate = localProcess.canTerminate;
  if (typeof canTerminate !== "boolean") {
    throw new ObservabilityError(
      `Expected ${field}.canTerminate in ${filePath} to be a boolean`,
    );
  }
  return {
    pid: expectNullableInteger(localProcess.pid, filePath, `${field}.pid`),
    canTerminate,
  };
}

function expectRunnerTransportKind(
  value: unknown,
  filePath: string,
  field: string,
): RunnerTransportKind {
  const kind = expectString(value, filePath, field);
  switch (kind) {
    case "local-process":
    case "local-stdio-session":
    case "remote-stdio-session":
    case "remote-task":
      return kind;
    default:
      throw new ObservabilityError(
        `Expected ${field} in ${filePath} to be a supported runner transport kind`,
      );
  }
}

function parsePullRequest(
  value: unknown,
  filePath: string,
  field: string,
): FactoryPullRequestStatus | null {
  if (value === null || value === undefined) {
    return null;
  }
  const pullRequest = expectObject(value, filePath, field);
  return {
    number: expectInteger(pullRequest.number, filePath, `${field}.number`),
    url: expectString(pullRequest.url, filePath, `${field}.url`),
    headSha: expectNullableString(
      pullRequest.headSha,
      filePath,
      `${field}.headSha`,
    ),
    latestCommitAt: expectNullableString(
      pullRequest.latestCommitAt,
      filePath,
      `${field}.latestCommitAt`,
    ),
  };
}

function parseCheckStatus(
  value: unknown,
  filePath: string,
  field: string,
): FactoryCheckStatus {
  const checks = expectObject(value, filePath, field);
  return {
    pendingNames: expectStringArray(
      checks.pendingNames,
      filePath,
      `${field}.pendingNames`,
    ),
    failingNames: expectStringArray(
      checks.failingNames,
      filePath,
      `${field}.failingNames`,
    ),
  };
}

function parseReviewStatus(
  value: unknown,
  filePath: string,
  field: string,
): FactoryReviewStatus {
  const review = expectObject(value, filePath, field);
  return {
    actionableCount: expectInteger(
      review.actionableCount,
      filePath,
      `${field}.actionableCount`,
    ),
    unresolvedThreadCount: expectInteger(
      review.unresolvedThreadCount,
      filePath,
      `${field}.unresolvedThreadCount`,
    ),
  };
}

function parseRetry(
  value: unknown,
  filePath: string,
  field: string,
): FactoryRetrySnapshot {
  const retry = expectObject(value, filePath, field);
  return {
    issueNumber: expectInteger(
      retry.issueNumber,
      filePath,
      `${field}.issueNumber`,
    ),
    issueIdentifier: expectString(
      retry.issueIdentifier,
      filePath,
      `${field}.issueIdentifier`,
    ),
    title: expectString(retry.title, filePath, `${field}.title`),
    nextAttempt: expectInteger(
      retry.nextAttempt,
      filePath,
      `${field}.nextAttempt`,
    ),
    retryClass: expectRetryClass(
      retry.retryClass,
      filePath,
      `${field}.retryClass`,
    ),
    scheduledAt: expectString(
      retry.scheduledAt,
      filePath,
      `${field}.scheduledAt`,
    ),
    backoffMs: expectInteger(retry.backoffMs, filePath, `${field}.backoffMs`),
    dueAt: expectString(retry.dueAt, filePath, `${field}.dueAt`),
    lastError: expectString(retry.lastError, filePath, `${field}.lastError`),
  };
}

function expectRetryClass(
  value: unknown,
  filePath: string,
  field: string,
): RetryClass {
  const retryClass = expectString(value, filePath, field);
  if (
    retryClass !== "run-failure" &&
    retryClass !== "provider-rate-limit" &&
    retryClass !== "provider-account-pressure" &&
    retryClass !== "missing-target" &&
    retryClass !== "watchdog-abort" &&
    retryClass !== "unexpected-orchestrator-failure"
  ) {
    throw invalidSnapshot(
      filePath,
      `expected ${field} to be a supported retry class`,
    );
  }
  return retryClass;
}

function expectRecoveryPostureFamily(
  value: unknown,
  filePath: string,
  field: string,
): FactoryRecoveryPostureFamily {
  return expectEnum(
    value,
    [
      "healthy",
      "waiting-expected",
      "restart-recovery",
      "retry-backoff",
      "watchdog-recovery",
      "cleanup-terminal",
      "degraded-observability",
      "degraded",
    ],
    filePath,
    field,
  );
}

function expectObject(
  value: unknown,
  filePath: string,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSnapshot(filePath, `expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== "string") {
    throw invalidSnapshot(filePath, `expected ${field} to be a string`);
  }
  return value;
}

function expectNullableString(
  value: unknown,
  filePath: string,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return expectString(value, filePath, field);
}

function expectInteger(
  value: unknown,
  filePath: string,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidSnapshot(filePath, `expected ${field} to be an integer`);
  }
  return value;
}

function expectPositiveInteger(
  value: unknown,
  filePath: string,
  field: string,
): number {
  const integer = expectInteger(value, filePath, field);
  if (integer <= 0) {
    throw invalidSnapshot(
      filePath,
      `expected ${field} to be a positive integer`,
    );
  }
  return integer;
}

function expectNullableInteger(
  value: unknown,
  filePath: string,
  field: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return expectInteger(value, filePath, field);
}

function expectNullableNumber(
  value: unknown,
  filePath: string,
  field: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ObservabilityError(
      `Expected ${field} in ${filePath} to be a finite number or null`,
    );
  }
  return value;
}

function expectNullableBoolean(
  value: unknown,
  filePath: string,
  field: string,
): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw invalidSnapshot(filePath, `expected ${field} to be a boolean`);
  }
  return value;
}

function expectStringArray(
  value: unknown,
  filePath: string,
  field: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalidSnapshot(filePath, `expected ${field} to be a string array`);
  }
  return value;
}

function expectArray<T>(
  value: unknown,
  filePath: string,
  field: string,
  parseEntry: (entry: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw invalidSnapshot(filePath, `expected ${field} to be an array`);
  }
  return value.map((entry, index) => parseEntry(entry, index));
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  filePath: string,
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalidSnapshot(
      filePath,
      `expected ${field} to be one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function expectNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  filePath: string,
  field: string,
): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  return expectEnum(value, allowed, filePath, field);
}

function invalidSnapshot(
  filePath: string,
  message: string,
): ObservabilityError {
  return new ObservabilityError(
    `Invalid factory status snapshot at ${filePath}: ${message}`,
  );
}
