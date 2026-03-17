import type {
  FactoryActiveIssueSnapshot,
  FactoryRecoveryPostureEntry,
  FactoryRecoveryPostureFamily,
  FactoryRecoveryPostureSnapshot,
  FactoryRestartRecoverySnapshot,
  FactoryRetrySnapshot,
  FactoryStatusPublication,
} from "../observability/status.js";
import type { WorkspaceRetentionOutcome } from "./workspace-retention.js";

const RECOVERY_POSTURE_PRECEDENCE: readonly FactoryRecoveryPostureFamily[] = [
  "degraded-observability",
  "degraded",
  "watchdog-recovery",
  "restart-recovery",
  "cleanup-terminal",
  "retry-backoff",
  "waiting-expected",
  "healthy",
];

const WAITING_STATUSES = new Set([
  "awaiting-human-handoff",
  "awaiting-human-review",
  "awaiting-system-checks",
  "awaiting-landing-command",
  "awaiting-landing",
  "rework-required",
]);

export interface RuntimeWatchdogPosture {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly summary: string;
  readonly observedAt: string;
  readonly recoveryExhausted: boolean;
}

export interface RuntimeTerminalCleanupPosture {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly branchName: string;
  readonly terminalOutcome: "success" | "failure";
  readonly summary: string;
  readonly observedAt: string;
  readonly workspaceRetention: WorkspaceRetentionOutcome;
}

export function noteTerminalCleanupPosture(
  entries: readonly RuntimeTerminalCleanupPosture[],
  entry: RuntimeTerminalCleanupPosture,
  limit = 10,
): readonly RuntimeTerminalCleanupPosture[] {
  return [
    entry,
    ...entries.filter((item) => item.issueNumber !== entry.issueNumber),
  ].slice(0, limit);
}

export function projectRecoveryPosture(input: {
  readonly publication: FactoryStatusPublication;
  readonly restartRecovery: FactoryRestartRecoverySnapshot;
  readonly activeIssues: readonly FactoryActiveIssueSnapshot[];
  readonly retries: readonly FactoryRetrySnapshot[];
  readonly watchdogIssues: ReadonlyMap<number, RuntimeWatchdogPosture>;
  readonly terminalIssues: readonly RuntimeTerminalCleanupPosture[];
}): FactoryRecoveryPostureSnapshot {
  const issueEntries = new Map<number, FactoryRecoveryPostureEntry>();
  const otherEntries: FactoryRecoveryPostureEntry[] = [];

  if (input.publication.state === "initializing") {
    otherEntries.push({
      family: "degraded-observability",
      issueNumber: null,
      issueIdentifier: null,
      title: null,
      source: "snapshot",
      summary:
        input.publication.detail ??
        "Factory startup is still publishing a current runtime snapshot.",
      observedAt: null,
    });
  }

  const restartRecoveryFamily =
    input.restartRecovery.state === "degraded"
      ? "degraded"
      : "restart-recovery";
  if (
    input.restartRecovery.state !== "idle" ||
    input.restartRecovery.issues.length > 0
  ) {
    otherEntries.push({
      family: restartRecoveryFamily,
      issueNumber: null,
      issueIdentifier: null,
      title: null,
      source: "restart-recovery",
      summary:
        input.restartRecovery.summary ??
        (input.restartRecovery.state === "reconciling"
          ? "Restart reconciliation is still running."
          : input.restartRecovery.state === "degraded"
            ? "Restart reconciliation is degraded."
            : "Restart reconciliation completed with visible recovery decisions."),
      observedAt:
        input.restartRecovery.completedAt ?? input.restartRecovery.startedAt,
    });
  }

  for (const issue of input.restartRecovery.issues) {
    upsertIssueEntry(issueEntries, {
      family: restartRecoveryFamily,
      issueNumber: issue.issueNumber,
      issueIdentifier: issue.issueIdentifier,
      title: null,
      source: "restart-recovery",
      summary: issue.summary,
      observedAt: issue.observedAt,
    });
  }

  for (const issue of input.activeIssues) {
    const watchdog = input.watchdogIssues.get(issue.issueNumber);
    if (watchdog !== undefined) {
      upsertIssueEntry(issueEntries, {
        family: watchdog.recoveryExhausted ? "degraded" : "watchdog-recovery",
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        title: issue.title,
        source: "watchdog",
        summary: watchdog.summary,
        observedAt: watchdog.observedAt,
      });
      continue;
    }

    if (WAITING_STATUSES.has(issue.status)) {
      upsertIssueEntry(issueEntries, {
        family: "waiting-expected",
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        title: issue.title,
        source: "active-issue",
        summary: issue.blockedReason ?? issue.summary,
        observedAt: issue.updatedAt,
      });
      continue;
    }

    upsertIssueEntry(issueEntries, {
      family: "healthy",
      issueNumber: issue.issueNumber,
      issueIdentifier: issue.issueIdentifier,
      title: issue.title,
      source: "active-issue",
      summary: issue.summary,
      observedAt: issue.updatedAt,
    });
  }

  for (const retry of input.retries) {
    upsertIssueEntry(issueEntries, {
      family:
        retry.retryClass === "watchdog-abort"
          ? "watchdog-recovery"
          : "retry-backoff",
      issueNumber: retry.issueNumber,
      issueIdentifier: retry.issueIdentifier,
      title: retry.title,
      source: "retry-queue",
      summary:
        retry.retryClass === "watchdog-abort"
          ? `Watchdog scheduled retry attempt ${retry.nextAttempt.toString()} for ${retry.issueIdentifier}.`
          : `Retry attempt ${retry.nextAttempt.toString()} is queued until ${retry.dueAt}.`,
      observedAt: retry.scheduledAt,
    });
  }

  for (const issue of input.terminalIssues) {
    upsertIssueEntry(issueEntries, {
      family:
        issue.workspaceRetention.state === "cleanup-failed"
          ? "degraded"
          : "cleanup-terminal",
      issueNumber: issue.issueNumber,
      issueIdentifier: issue.issueIdentifier,
      title: issue.title,
      source: "terminal-cleanup",
      summary: issue.summary,
      observedAt: issue.observedAt,
    });
  }

  const entries = [...otherEntries, ...sortIssueEntries(issueEntries)];
  const family =
    entries.length === 0
      ? "healthy"
      : entries.reduce(
          (current, entry) =>
            compareFamilies(entry.family, current) < 0 ? entry.family : current,
          entries[0]!.family,
        );

  return {
    summary: {
      family,
      summary: summarizeRecoveryPosture(family, entries),
      issueCount: entries.filter((entry) => entry.issueNumber !== null).length,
    },
    entries,
  };
}

function upsertIssueEntry(
  entries: Map<number, FactoryRecoveryPostureEntry>,
  candidate: FactoryRecoveryPostureEntry,
): void {
  if (candidate.issueNumber === null) {
    return;
  }
  const existing = entries.get(candidate.issueNumber);
  if (
    existing === undefined ||
    compareFamilies(candidate.family, existing.family) < 0
  ) {
    entries.set(candidate.issueNumber, candidate);
  }
}

function compareFamilies(
  left: FactoryRecoveryPostureFamily,
  right: FactoryRecoveryPostureFamily,
): number {
  return (
    RECOVERY_POSTURE_PRECEDENCE.indexOf(left) -
    RECOVERY_POSTURE_PRECEDENCE.indexOf(right)
  );
}

function sortIssueEntries(
  entries: ReadonlyMap<number, FactoryRecoveryPostureEntry>,
): readonly FactoryRecoveryPostureEntry[] {
  return [...entries.values()].sort((left, right) => {
    const familyOrder = compareFamilies(left.family, right.family);
    if (familyOrder !== 0) {
      return familyOrder;
    }
    return (left.issueNumber ?? 0) - (right.issueNumber ?? 0);
  });
}

function summarizeRecoveryPosture(
  family: FactoryRecoveryPostureFamily,
  entries: readonly FactoryRecoveryPostureEntry[],
): string {
  const issueCount = entries.filter(
    (entry) => entry.issueNumber !== null,
  ).length;
  const factorySummary = entries.find((entry) => entry.issueNumber === null)
    ?.summary;
  switch (family) {
    case "degraded-observability":
      return entries[0]?.summary ?? "Observability is degraded.";
    case "degraded":
      return issueCount === 0
        ? "Recovery posture is degraded."
        : `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} currently need degraded recovery or cleanup attention.`;
    case "watchdog-recovery":
      return `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} currently reflect watchdog recovery or watchdog-driven retry posture.`;
    case "restart-recovery":
      return issueCount === 0
        ? factorySummary ?? "Restart reconciliation posture is active."
        : `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} still show restart reconciliation posture.`;
    case "cleanup-terminal":
      return `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} recently completed terminal cleanup or retention handling.`;
    case "retry-backoff":
      return `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} are queued in retry backoff.`;
    case "waiting-expected":
      return `${issueCount.toString()} issue${issueCount === 1 ? "" : "s"} are waiting on expected human or system gates.`;
    case "healthy":
      return issueCount === 0
        ? "No active recovery posture is present."
        : `${issueCount.toString()} active issue${issueCount === 1 ? "" : "s"} are running without recovery pressure.`;
  }
}
