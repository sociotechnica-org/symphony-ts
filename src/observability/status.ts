import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";

let snapshotWriteSequence = 0;

export type FactoryState = "idle" | "running" | "blocked";

export type FactoryIssueStatus =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting-plan-review"
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
    readonly workerAlive?: boolean;
    readonly statusFilePath?: string;
  },
): string {
  const lines: string[] = [];
  const workerAlive = options?.workerAlive;
  const workerState =
    workerAlive === undefined ? "unknown" : workerAlive ? "online" : "offline";

  lines.push(`Factory: ${snapshot.factoryState}`);
  lines.push(
    `Worker: ${workerState} pid=${snapshot.worker.pid.toString()} instance=${snapshot.worker.instanceId}`,
  );
  lines.push(
    `Started: ${snapshot.worker.startedAt}  Snapshot: ${snapshot.generatedAt}`,
  );
  lines.push(
    `Counts: ready=${snapshot.counts.ready.toString()} tracker_running=${snapshot.counts.running.toString()} failed=${snapshot.counts.failed.toString()} local=${snapshot.counts.activeLocalRuns.toString()} retries=${snapshot.counts.retries.toString()}`,
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
        "awaiting-plan-review",
        "awaiting-review",
        "needs-follow-up",
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
  };
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
    dueAt: expectString(retry.dueAt, filePath, `${field}.dueAt`),
    lastError: expectString(retry.lastError, filePath, `${field}.lastError`),
  };
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

function invalidSnapshot(
  filePath: string,
  message: string,
): ObservabilityError {
  return new ObservabilityError(
    `Invalid factory status snapshot at ${filePath}: ${message}`,
  );
}
