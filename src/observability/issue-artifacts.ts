import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import type { RunnerAccountingSnapshot } from "../runner/accounting.js";
import {
  createRunnerTransportMetadata,
  type RunnerTransportMetadata,
  withRunnerTransportLocalProcess,
} from "../runner/service.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

export const ISSUE_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type IssueArtifactEventKind =
  | "claimed"
  | "plan-ready"
  | "approved"
  | "waived"
  | "shutdown-requested"
  | "shutdown-terminated"
  | "runner-spawned"
  | "pr-opened"
  | "landing-blocked"
  | "landing-failed"
  | "landing-requested"
  | "review-feedback"
  | "retry-scheduled"
  | "succeeded"
  | "failed";

export type IssueArtifactOutcome =
  | "claimed"
  | "running"
  | "shutdown-terminated"
  | "shutdown-forced"
  | "attempt-failed"
  | "awaiting-plan-review"
  | "merged"
  | "awaiting-human-review"
  | "awaiting-system-checks"
  | "awaiting-landing-command"
  | "awaiting-landing"
  | "rework-required"
  | "retry-scheduled"
  | "succeeded"
  | "failed";

export interface IssueArtifactPaths {
  readonly issueRoot: string;
  readonly issueFile: string;
  readonly eventsFile: string;
  readonly attemptsDir: string;
  readonly sessionsDir: string;
  readonly logsDir: string;
  readonly logPointersFile: string;
}

export interface IssueArtifactSummary {
  readonly version: typeof ISSUE_ARTIFACT_SCHEMA_VERSION;
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly repo: string;
  readonly title: string;
  readonly issueUrl: string;
  readonly branch: string | null;
  readonly currentOutcome: IssueArtifactOutcome;
  readonly currentSummary: string;
  readonly firstObservedAt: string;
  readonly lastUpdatedAt: string;
  readonly latestAttemptNumber: number | null;
  readonly latestSessionId: string | null;
}

export interface IssueArtifactEvent {
  readonly version: typeof ISSUE_ARTIFACT_SCHEMA_VERSION;
  readonly kind: IssueArtifactEventKind;
  readonly issueNumber: number;
  readonly observedAt: string;
  readonly attemptNumber: number | null;
  readonly sessionId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface IssueArtifactPullRequestSnapshot {
  readonly number: number;
  readonly url: string;
  readonly headSha?: string | null;
  readonly latestCommitAt: string | null;
}

export interface IssueArtifactReviewSnapshot {
  readonly actionableCount: number;
  readonly unresolvedThreadCount: number;
}

export interface IssueArtifactCheckSnapshot {
  readonly pendingNames: readonly string[];
  readonly failingNames: readonly string[];
}

export interface IssueArtifactAttemptSnapshot {
  readonly version: typeof ISSUE_ARTIFACT_SCHEMA_VERSION;
  readonly issueNumber: number;
  readonly attemptNumber: number;
  readonly branch: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly outcome: IssueArtifactOutcome;
  readonly summary: string;
  readonly sessionId: string | null;
  readonly latestTurnNumber: number | null;
  readonly runnerPid: number | null;
  readonly pullRequest: IssueArtifactPullRequestSnapshot | null;
  readonly review: IssueArtifactReviewSnapshot | null;
  readonly checks: IssueArtifactCheckSnapshot | null;
}

export interface IssueArtifactLogPointer {
  readonly name: string;
  readonly location: string | null;
  readonly archiveLocation: string | null;
}

export interface IssueArtifactSessionSnapshot {
  readonly version: typeof ISSUE_ARTIFACT_SCHEMA_VERSION;
  readonly issueNumber: number;
  readonly attemptNumber: number;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly transport: RunnerTransportMetadata;
  readonly backendSessionId: string | null;
  readonly backendThreadId: string | null;
  readonly latestTurnId: string | null;
  readonly latestTurnNumber: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly workspacePath: string | null;
  readonly branch: string | null;
  readonly accounting?: RunnerAccountingSnapshot | undefined;
  readonly logPointers: readonly IssueArtifactLogPointer[];
}

interface LegacyIssueArtifactSessionSnapshot extends Omit<
  IssueArtifactSessionSnapshot,
  "transport"
> {
  readonly transport?: RunnerTransportMetadata | undefined;
  readonly appServerPid?: number | null | undefined;
}

export interface IssueArtifactLogPointerSessionEntry {
  readonly sessionId: string;
  readonly pointers: readonly IssueArtifactLogPointer[];
  readonly archiveLocation: string | null;
}

export interface IssueArtifactLogPointersDocument {
  readonly version: typeof ISSUE_ARTIFACT_SCHEMA_VERSION;
  readonly issueNumber: number;
  readonly sessions: Readonly<
    Record<string, IssueArtifactLogPointerSessionEntry | undefined>
  >;
}

export interface IssueArtifactIssueUpdate {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly repo: string;
  readonly title: string;
  readonly issueUrl: string;
  readonly branch?: string | null | undefined;
  readonly currentOutcome: IssueArtifactOutcome;
  readonly currentSummary: string;
  readonly observedAt: string;
  readonly latestAttemptNumber?: number | null | undefined;
  readonly latestSessionId?: string | null | undefined;
}

export interface IssueArtifactObservation {
  readonly issue: IssueArtifactIssueUpdate;
  readonly events?: readonly IssueArtifactEvent[] | undefined;
  readonly attempt?: IssueArtifactAttemptSnapshot | undefined;
  readonly session?: IssueArtifactSessionSnapshot | undefined;
  readonly logPointers?: IssueArtifactLogPointerSessionEntry | undefined;
}

export interface IssueArtifactStore {
  recordObservation(observation: IssueArtifactObservation): Promise<void>;
}

export class LocalIssueArtifactStore implements IssueArtifactStore {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  async recordObservation(
    observation: IssueArtifactObservation,
  ): Promise<void> {
    const paths = deriveIssueArtifactPaths(
      this.#workspaceRoot,
      observation.issue.issueNumber,
    );

    await this.#ensureLayout(paths, observation.issue.issueNumber);

    const summary = await this.#writeIssueSummary(
      paths.issueFile,
      observation.issue,
    );

    if (observation.attempt !== undefined) {
      const attemptFile = path.join(
        paths.attemptsDir,
        `${observation.attempt.attemptNumber.toString()}.json`,
      );
      await writeJsonFile(attemptFile, observation.attempt);
    } else if (
      (summary.currentOutcome === "succeeded" ||
        summary.currentOutcome === "failed") &&
      summary.latestAttemptNumber !== null
    ) {
      await this.#finalizeLatestAttempt(paths, summary);
    }

    if (observation.session !== undefined) {
      const sessionFile = path.join(
        paths.sessionsDir,
        `${encodeSessionFileName(observation.session.sessionId)}.json`,
      );
      await writeJsonFile(sessionFile, observation.session);
    }

    if (observation.logPointers !== undefined) {
      await this.#writeLogPointers(
        paths.logPointersFile,
        observation.issue.issueNumber,
        observation.logPointers,
      );
    }

    for (const event of observation.events ?? []) {
      await appendJsonLineIfChanged(paths.eventsFile, event);
    }
  }

  async #ensureLayout(
    paths: IssueArtifactPaths,
    issueNumber: number,
  ): Promise<void> {
    await Promise.all([
      fs.mkdir(paths.attemptsDir, { recursive: true }),
      fs.mkdir(paths.sessionsDir, { recursive: true }),
      fs.mkdir(paths.logsDir, { recursive: true }),
    ]);

    await fs.writeFile(paths.eventsFile, "", { flag: "a" });

    const logPointers = await readJsonFile<IssueArtifactLogPointersDocument>(
      paths.logPointersFile,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (logPointers === null) {
      await writeJsonFile(paths.logPointersFile, {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber,
        sessions: {},
      } satisfies IssueArtifactLogPointersDocument);
    }
  }

  async #writeIssueSummary(
    issueFile: string,
    update: IssueArtifactIssueUpdate,
  ): Promise<IssueArtifactSummary> {
    const existing = await readJsonFile<IssueArtifactSummary>(issueFile).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      },
    );

    const next: IssueArtifactSummary = {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber: update.issueNumber,
      issueIdentifier: update.issueIdentifier,
      repo: update.repo,
      title: update.title,
      issueUrl: update.issueUrl,
      branch: update.branch ?? existing?.branch ?? null,
      currentOutcome: update.currentOutcome,
      currentSummary: update.currentSummary,
      firstObservedAt: existing?.firstObservedAt ?? update.observedAt,
      lastUpdatedAt: update.observedAt,
      latestAttemptNumber:
        update.latestAttemptNumber === undefined
          ? (existing?.latestAttemptNumber ?? null)
          : update.latestAttemptNumber,
      latestSessionId:
        update.latestSessionId === undefined
          ? (existing?.latestSessionId ?? null)
          : update.latestSessionId,
    };

    await writeJsonFile(issueFile, next);
    return next;
  }

  async #writeLogPointers(
    filePath: string,
    issueNumber: number,
    entry: IssueArtifactLogPointerSessionEntry,
  ): Promise<void> {
    const existing =
      (await readJsonFile<IssueArtifactLogPointersDocument>(filePath).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        },
      )) ??
      ({
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber,
        sessions: {},
      } satisfies IssueArtifactLogPointersDocument);

    await writeJsonFile(filePath, {
      ...existing,
      issueNumber,
      sessions: {
        ...existing.sessions,
        [entry.sessionId]: entry,
      },
    } satisfies IssueArtifactLogPointersDocument);
  }

  async #finalizeLatestAttempt(
    paths: IssueArtifactPaths,
    summary: IssueArtifactSummary,
  ): Promise<void> {
    const attemptNumber = summary.latestAttemptNumber;
    if (attemptNumber === null) {
      return;
    }

    const attemptFile = path.join(
      paths.attemptsDir,
      `${attemptNumber.toString()}.json`,
    );
    const existing = await readJsonFile<IssueArtifactAttemptSnapshot>(
      attemptFile,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });

    const latestTurnNumber =
      existing?.latestTurnNumber ??
      (await this.#readLatestSessionTurnNumber(paths, summary.latestSessionId));

    await writeJsonFile(attemptFile, {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber: summary.issueNumber,
      attemptNumber,
      branch: existing?.branch ?? summary.branch,
      startedAt: existing?.startedAt ?? null,
      finishedAt: summary.lastUpdatedAt,
      outcome: summary.currentOutcome,
      summary: summary.currentSummary,
      sessionId: existing?.sessionId ?? summary.latestSessionId,
      latestTurnNumber,
      runnerPid: existing?.runnerPid ?? null,
      pullRequest: existing?.pullRequest ?? null,
      review: existing?.review ?? null,
      checks: existing?.checks ?? null,
    } satisfies IssueArtifactAttemptSnapshot);
  }

  async #readLatestSessionTurnNumber(
    paths: IssueArtifactPaths,
    sessionId: string | null,
  ): Promise<number | null> {
    if (sessionId === null) {
      return null;
    }

    const sessionFile = path.join(
      paths.sessionsDir,
      `${encodeSessionFileName(sessionId)}.json`,
    );
    const snapshot = await readIssueArtifactSessionFile(sessionFile).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      },
    );

    return snapshot?.latestTurnNumber ?? null;
  }
}

export function deriveFactoryRuntimeRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  let current = resolved;

  for (;;) {
    const parent = path.dirname(current);
    if (path.basename(parent) === ".tmp") {
      return path.join(path.dirname(parent), ".var", "factory");
    }
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const repoRoot = path.dirname(resolved);
  return path.join(repoRoot, ".var", "factory");
}

export function deriveIssueArtifactsRoot(workspaceRoot: string): string {
  return path.join(deriveFactoryRuntimeRoot(workspaceRoot), "issues");
}

export function deriveIssueArtifactPaths(
  workspaceRoot: string,
  issueNumber: number,
): IssueArtifactPaths {
  const issueRoot = path.join(
    deriveIssueArtifactsRoot(workspaceRoot),
    issueNumber.toString(),
  );
  return {
    issueRoot,
    issueFile: path.join(issueRoot, "issue.json"),
    eventsFile: path.join(issueRoot, "events.jsonl"),
    attemptsDir: path.join(issueRoot, "attempts"),
    sessionsDir: path.join(issueRoot, "sessions"),
    logsDir: path.join(issueRoot, "logs"),
    logPointersFile: path.join(issueRoot, "logs", "pointers.json"),
  };
}

export async function readIssueArtifactSummary(
  workspaceRoot: string,
  issueNumber: number,
): Promise<IssueArtifactSummary> {
  return await readJsonFile<IssueArtifactSummary>(
    deriveIssueArtifactPaths(workspaceRoot, issueNumber).issueFile,
  );
}

export async function readIssueArtifactEvents(
  workspaceRoot: string,
  issueNumber: number,
): Promise<readonly IssueArtifactEvent[]> {
  const filePath = deriveIssueArtifactPaths(
    workspaceRoot,
    issueNumber,
  ).eventsFile;
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as IssueArtifactEvent;
      } catch (error) {
        throw new ObservabilityError(
          `Failed to parse JSONL artifact at ${filePath}`,
          {
            cause: error as Error,
          },
        );
      }
    });
}

export async function readIssueArtifactAttempt(
  workspaceRoot: string,
  issueNumber: number,
  attemptNumber: number,
): Promise<IssueArtifactAttemptSnapshot> {
  return await readJsonFile<IssueArtifactAttemptSnapshot>(
    path.join(
      deriveIssueArtifactPaths(workspaceRoot, issueNumber).attemptsDir,
      `${attemptNumber.toString()}.json`,
    ),
  );
}

export async function readIssueArtifactSession(
  workspaceRoot: string,
  issueNumber: number,
  sessionId: string,
): Promise<IssueArtifactSessionSnapshot> {
  return await readIssueArtifactSessionFile(
    path.join(
      deriveIssueArtifactPaths(workspaceRoot, issueNumber).sessionsDir,
      `${encodeSessionFileName(sessionId)}.json`,
    ),
  );
}

export async function readIssueArtifactLogPointers(
  workspaceRoot: string,
  issueNumber: number,
): Promise<IssueArtifactLogPointersDocument> {
  return await readJsonFile<IssueArtifactLogPointersDocument>(
    deriveIssueArtifactPaths(workspaceRoot, issueNumber).logPointersFile,
  );
}

function encodeSessionFileName(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ObservabilityError(
      `Failed to parse JSON artifact at ${filePath}`,
      {
        cause: error as Error,
      },
    );
  }
}

async function readIssueArtifactSessionFile(
  filePath: string,
): Promise<IssueArtifactSessionSnapshot> {
  const snapshot =
    await readJsonFile<LegacyIssueArtifactSessionSnapshot>(filePath);
  const {
    appServerPid,
    transport,
    backendThreadId,
    latestTurnId,
    ...session
  } = snapshot;
  const legacyTransportKind =
    appServerPid === null || appServerPid === undefined
      ? "local-process"
      : "local-stdio-session";

  return {
    ...session,
    backendThreadId: backendThreadId ?? null,
    latestTurnId: latestTurnId ?? null,
    transport:
      transport ??
      (appServerPid === null || appServerPid === undefined
        ? createRunnerTransportMetadata(legacyTransportKind)
        : withRunnerTransportLocalProcess(
            createRunnerTransportMetadata(legacyTransportKind, {
              canTerminateLocalProcess: true,
            }),
            appServerPid,
          )),
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeJsonFileAtomic(filePath, value, {
    tempPrefix: ".issue-artifact",
  });
}

async function appendJsonLineIfChanged(
  filePath: string,
  value: IssueArtifactEvent,
): Promise<void> {
  const previous = await readLastJsonLine(filePath);
  if (
    previous !== null &&
    eventFingerprint(previous) === eventFingerprint(value)
  ) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readLastJsonLine(
  filePath: string,
): Promise<IssueArtifactEvent | null> {
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (raw === null) {
    return null;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(lines.at(-1)!) as IssueArtifactEvent;
  } catch (error) {
    throw new ObservabilityError(
      `Failed to parse JSONL artifact at ${filePath}`,
      { cause: error as Error },
    );
  }
}

function eventFingerprint(event: IssueArtifactEvent): string {
  return JSON.stringify({
    kind: event.kind,
    issueNumber: event.issueNumber,
    attemptNumber: event.attemptNumber,
    sessionId: event.sessionId,
    details: sortJsonValue(event.details),
  });
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const objectValue = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(objectValue)
      .sort()
      .map((key) => [key, sortJsonValue(objectValue[key])]),
  );
}
