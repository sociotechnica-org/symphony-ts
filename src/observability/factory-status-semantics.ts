import type { FactoryHaltSnapshot } from "../domain/factory-halt.js";
import type { DispatchPressureStateSnapshot } from "../domain/transient-failure.js";
import type {
  FactoryHostDispatchSnapshot,
  FactoryReadyQueueIssueSnapshot,
  FactoryRecoveryPostureSnapshot,
  FactoryRestartRecoverySnapshot,
  FactoryStatusPublication,
  FactoryStatusPublicationState,
  FactoryStatusSnapshot,
  FactoryTerminalIssueSnapshot,
} from "./factory-status-snapshot.js";

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

export function getFactoryHaltSnapshot(
  snapshot: FactoryStatusSnapshot,
): FactoryHaltSnapshot {
  return (
    snapshot.factoryHalt ?? {
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    }
  );
}

export function getFactoryDispatchPressure(
  snapshot: FactoryStatusSnapshot,
): DispatchPressureStateSnapshot | null {
  return snapshot.dispatchPressure ?? null;
}

export function getFactoryHostDispatch(
  snapshot: FactoryStatusSnapshot,
): FactoryHostDispatchSnapshot | null {
  return snapshot.hostDispatch ?? null;
}

export function getFactoryReadyQueue(
  snapshot: FactoryStatusSnapshot,
): readonly FactoryReadyQueueIssueSnapshot[] {
  return snapshot.readyQueue ?? [];
}

export function getFactoryTerminalIssues(
  snapshot: FactoryStatusSnapshot,
): readonly FactoryTerminalIssueSnapshot[] {
  return snapshot.terminalIssues ?? [];
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
