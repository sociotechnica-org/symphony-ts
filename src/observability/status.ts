import fs from "node:fs/promises";
import path from "node:path";

export type FactoryState = "idle" | "running" | "blocked";

export type FactoryIssueStatus =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting-review"
  | "needs-follow-up";

export interface FactoryWorkerSnapshot {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly pollIntervalMs: number;
  readonly maxConcurrentRuns: number;
}

export interface FactoryStatusCounts {
  readonly ready: number;
  readonly running: number;
  readonly failed: number;
  readonly activeLocalRuns: number;
  readonly retries: number;
}

export interface FactoryStatusAction {
  readonly kind: string;
  readonly summary: string;
  readonly at: string;
  readonly issueNumber: number | null;
}

export interface FactoryPullRequestStatus {
  readonly number: number;
  readonly url: string;
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
  readonly ownerPid: number | null;
  readonly runnerPid: number | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly pullRequest: FactoryPullRequestStatus | null;
  readonly checks: FactoryCheckStatus;
  readonly review: FactoryReviewStatus;
  readonly blockedReason: string | null;
}

export interface FactoryRetrySnapshot {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly nextAttempt: number;
  readonly dueAt: string;
  readonly lastError: string;
}

export interface FactoryStatusSnapshot {
  readonly version: 1;
  readonly generatedAt: string;
  readonly factoryState: FactoryState;
  readonly worker: FactoryWorkerSnapshot;
  readonly counts: FactoryStatusCounts;
  readonly lastAction: FactoryStatusAction | null;
  readonly activeIssues: readonly FactoryActiveIssueSnapshot[];
  readonly retries: readonly FactoryRetrySnapshot[];
}

export function deriveStatusFilePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "..", "status.json");
}

export async function writeFactoryStatusSnapshot(
  filePath: string,
  snapshot: FactoryStatusSnapshot,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.status.${process.pid.toString()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

export async function readFactoryStatusSnapshot(
  filePath: string,
): Promise<FactoryStatusSnapshot> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as FactoryStatusSnapshot;
}

export function isProcessAlive(pid: number): boolean {
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
    readonly workerAlive?: boolean;
    readonly statusFilePath?: string;
  },
): string {
  const lines: string[] = [];
  const workerAlive = options?.workerAlive;
  const workerState =
    workerAlive === undefined
      ? snapshot.factoryState
      : workerAlive
        ? "online"
        : "offline";

  lines.push(`Factory: ${snapshot.factoryState}`);
  lines.push(
    `Worker: ${workerState} pid=${snapshot.worker.pid.toString()} instance=${snapshot.worker.instanceId}`,
  );
  lines.push(
    `Started: ${snapshot.worker.startedAt}  Snapshot: ${snapshot.generatedAt}`,
  );
  lines.push(
    `Counts: ready=${snapshot.counts.ready.toString()} running=${snapshot.counts.running.toString()} failed=${snapshot.counts.failed.toString()} local=${snapshot.counts.activeLocalRuns.toString()} retries=${snapshot.counts.retries.toString()}`,
  );
  lines.push(
    `Polling: every ${snapshot.worker.pollIntervalMs.toString()}ms, max concurrency ${snapshot.worker.maxConcurrentRuns.toString()}`,
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

  if (workerAlive === false) {
    lines.push(
      "Warning: worker PID is not running; this snapshot may be stale.",
    );
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
      if (issue.blockedReason !== null) {
        lines.push(`    Blocked: ${issue.blockedReason}`);
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
        `  #${retry.issueNumber.toString()} ${retry.title} attempt ${retry.nextAttempt.toString()} at ${retry.dueAt}`,
      );
      lines.push(`    Error: ${retry.lastError}`);
    }
  }

  return lines.join("\n");
}
