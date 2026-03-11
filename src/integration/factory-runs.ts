import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IntegrationError } from "../domain/errors.js";
import type { IssueArtifactLogPointer } from "../observability/issue-artifacts.js";
import {
  loadIssueArtifacts,
  readIssueReport,
  type IssueReportDocument,
  type LoadedIssueArtifacts,
} from "../observability/issue-report.js";

const execFileAsync = promisify(execFile);

export const FACTORY_RUNS_PUBLICATION_SCHEMA_VERSION = 1 as const;

export type FactoryRunsLogPublicationStatus =
  | "copied"
  | "referenced"
  | "unavailable";

export interface FactoryRunsSourceRevision {
  readonly checkoutPath: string;
  readonly currentBranch: string | null;
  readonly relevantSha: string | null;
  readonly baseSha: string | null;
  readonly commitRange: string | null;
}

export interface FactoryRunsPublicationPaths {
  readonly repoRoot: string;
  readonly issueRoot: string;
  readonly publicationRoot: string;
  readonly reportJsonFile: string;
  readonly reportMarkdownFile: string;
  readonly metadataFile: string;
  readonly logsDir: string;
}

export interface FactoryRunsLogPublicationResult {
  readonly sessionId: string;
  readonly logName: string;
  readonly status: FactoryRunsLogPublicationStatus;
  readonly sourceLocation: string | null;
  readonly sourceArchiveLocation: string | null;
  readonly archivePath: string | null;
  readonly pointerFile: string | null;
  readonly note: string | null;
}

export interface FactoryRunsPublicationMetadata {
  readonly version: typeof FACTORY_RUNS_PUBLICATION_SCHEMA_VERSION;
  readonly publicationId: string;
  readonly publishedAt: string;
  readonly publicationStatus: "complete" | "partial";
  readonly notes: readonly string[];
  readonly repo: string | null;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
  readonly issueUrl: string | null;
  readonly branchName: string | null;
  readonly pullRequests: readonly {
    readonly number: number;
    readonly url: string;
  }[];
  readonly reportGeneratedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly latestSessionId: string | null;
  readonly sessionIds: readonly string[];
  readonly attempts: readonly {
    readonly attemptNumber: number;
    readonly sessionId: string | null;
    readonly runnerPid: number | null;
  }[];
  readonly sourceRevision: FactoryRunsSourceRevision;
  readonly sourceArtifacts: {
    readonly rawIssueRoot: string;
    readonly issueFile: string | null;
    readonly eventsFile: string | null;
    readonly attemptFiles: readonly string[];
    readonly sessionFiles: readonly string[];
    readonly logPointersFile: string | null;
    readonly reportJsonFile: string;
    readonly reportMarkdownFile: string;
  };
  readonly logs: {
    readonly status: "complete" | "partial" | "unavailable";
    readonly copiedCount: number;
    readonly referencedCount: number;
    readonly unavailableCount: number;
    readonly entries: readonly FactoryRunsLogPublicationResult[];
  };
}

export interface PublishIssueToFactoryRunsOptions {
  readonly workspaceRoot: string;
  readonly sourceRoot: string;
  readonly archiveRoot: string;
  readonly issueNumber: number;
  readonly publishedAt?: string | undefined;
}

export interface PublishedIssueToFactoryRuns {
  readonly publicationId: string;
  readonly status: "complete" | "partial";
  readonly paths: FactoryRunsPublicationPaths;
  readonly metadata: FactoryRunsPublicationMetadata;
}

interface SessionLogSource {
  readonly sessionId: string;
  readonly logName: string;
  readonly pointer: IssueArtifactLogPointer;
}

export function deriveFactoryRunsPublicationId(
  reportGeneratedAt: string,
  relevantSha: string | null,
): string {
  const normalizedTimestamp = normalizePublicationTimestamp(reportGeneratedAt);
  const shortSha =
    relevantSha !== null && /^[0-9a-f]{7,40}$/u.test(relevantSha)
      ? relevantSha.slice(0, 8)
      : null;
  return shortSha === null
    ? normalizedTimestamp
    : `${normalizedTimestamp}-${shortSha}`;
}

export function deriveFactoryRunsPublicationPaths(args: {
  readonly archiveRoot: string;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly publicationId: string;
}): FactoryRunsPublicationPaths {
  const repoRoot = path.join(args.archiveRoot, args.repoName);
  const issueRoot = path.join(repoRoot, "issues", args.issueNumber.toString());
  const publicationRoot = path.join(issueRoot, args.publicationId);
  return {
    repoRoot,
    issueRoot,
    publicationRoot,
    reportJsonFile: path.join(publicationRoot, "report.json"),
    reportMarkdownFile: path.join(publicationRoot, "report.md"),
    metadataFile: path.join(publicationRoot, "metadata.json"),
    logsDir: path.join(publicationRoot, "logs"),
  };
}

export async function publishIssueToFactoryRuns(
  options: PublishIssueToFactoryRunsOptions,
): Promise<PublishedIssueToFactoryRuns> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const archiveRoot = path.resolve(options.archiveRoot);
  const publishedAt = options.publishedAt ?? new Date().toISOString();

  await validateArchiveRoot(archiveRoot);

  const [reportInput, loadedArtifacts, sourceRevision] = await Promise.all([
    readIssueReport(options.workspaceRoot, options.issueNumber),
    loadIssueArtifacts(options.workspaceRoot, options.issueNumber),
    collectSourceRevision(sourceRoot),
  ]);

  const repoName = deriveRepoName(reportInput.report, sourceRoot);
  const publicationId = deriveFactoryRunsPublicationId(
    reportInput.report.generatedAt,
    sourceRevision.relevantSha,
  );
  const paths = deriveFactoryRunsPublicationPaths({
    archiveRoot,
    repoName,
    issueNumber: options.issueNumber,
    publicationId,
  });
  const stagingRoot = path.join(
    paths.issueRoot,
    `.factory-runs.${publicationId}.${process.pid.toString()}.tmp`,
  );

  await fs
    .rm(stagingRoot, { recursive: true, force: true })
    .catch(() => undefined);
  await fs.mkdir(stagingRoot, { recursive: true });

  try {
    await fs.writeFile(
      path.join(stagingRoot, "report.json"),
      reportInput.rawReportJson,
      "utf8",
    );
    await fs.writeFile(
      path.join(stagingRoot, "report.md"),
      reportInput.rawReportMarkdown,
      "utf8",
    );

    const logEntries = await publishSessionLogs({
      stagingRoot,
      archiveRoot,
      publicationPaths: paths,
      loadedArtifacts,
    });
    const metadata = buildFactoryRunsPublicationMetadata({
      report: reportInput.report,
      reportJsonFile: reportInput.outputPaths.reportJsonFile,
      reportMarkdownFile: reportInput.outputPaths.reportMarkdownFile,
      loadedArtifacts,
      publishedAt,
      publicationId,
      repoName,
      sourceRevision,
      logEntries,
    });

    await fs.writeFile(
      path.join(stagingRoot, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    await replacePublicationDirectory(stagingRoot, paths.publicationRoot);

    return {
      publicationId,
      status: metadata.publicationStatus,
      paths,
      metadata,
    };
  } catch (error) {
    await fs
      .rm(stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

export function buildFactoryRunsPublicationMetadata(args: {
  readonly report: IssueReportDocument;
  readonly reportJsonFile: string;
  readonly reportMarkdownFile: string;
  readonly loadedArtifacts: LoadedIssueArtifacts;
  readonly publishedAt: string;
  readonly publicationId: string;
  readonly repoName: string;
  readonly sourceRevision: FactoryRunsSourceRevision;
  readonly logEntries: readonly FactoryRunsLogPublicationResult[];
}): FactoryRunsPublicationMetadata {
  const copiedCount = args.logEntries.filter(
    (entry) => entry.status === "copied",
  ).length;
  const referencedCount = args.logEntries.filter(
    (entry) => entry.status === "referenced",
  ).length;
  const unavailableCount = args.logEntries.filter(
    (entry) => entry.status === "unavailable",
  ).length;
  const logStatus =
    args.logEntries.length === 0
      ? "unavailable"
      : referencedCount > 0 || unavailableCount > 0
        ? "partial"
        : "complete";
  const notes: string[] = [];

  if (args.logEntries.length === 0) {
    notes.push("No session logs were available for publication.");
  } else if (logStatus === "partial") {
    notes.push(
      "Publication completed with partial log coverage; see logs.entries for per-log outcomes.",
    );
  }

  return {
    version: FACTORY_RUNS_PUBLICATION_SCHEMA_VERSION,
    publicationId: args.publicationId,
    publishedAt: args.publishedAt,
    publicationStatus: logStatus === "partial" ? "partial" : "complete",
    notes,
    repo: args.report.summary.repo,
    repoName: args.repoName,
    issueNumber: args.report.summary.issueNumber,
    issueIdentifier: args.report.summary.issueIdentifier,
    title: args.report.summary.title,
    issueUrl: args.report.summary.issueUrl,
    branchName: args.report.summary.branch,
    pullRequests: args.report.githubActivity.pullRequests.map(
      (pullRequest) => ({
        number: pullRequest.number,
        url: pullRequest.url,
      }),
    ),
    reportGeneratedAt: args.report.generatedAt,
    startedAt: args.report.summary.startedAt,
    endedAt: args.report.summary.endedAt,
    latestSessionId: args.loadedArtifacts.issue?.latestSessionId ?? null,
    sessionIds: collectSessionIds(args.loadedArtifacts),
    attempts: args.loadedArtifacts.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      sessionId: attempt.sessionId,
      runnerPid: attempt.runnerPid,
    })),
    sourceRevision: args.sourceRevision,
    sourceArtifacts: {
      rawIssueRoot: args.report.artifacts.rawIssueRoot,
      issueFile: args.report.artifacts.issueFile,
      eventsFile: args.report.artifacts.eventsFile,
      attemptFiles: args.report.artifacts.attemptFiles,
      sessionFiles: args.report.artifacts.sessionFiles,
      logPointersFile: args.report.artifacts.logPointersFile,
      reportJsonFile: args.reportJsonFile,
      reportMarkdownFile: args.reportMarkdownFile,
    },
    logs: {
      status: logStatus,
      copiedCount,
      referencedCount,
      unavailableCount,
      entries: args.logEntries,
    },
  };
}

function normalizePublicationTimestamp(reportGeneratedAt: string): string {
  const parsed = new Date(reportGeneratedAt);
  if (Number.isNaN(parsed.valueOf())) {
    throw new IntegrationError(
      `Generated report timestamp is not a valid ISO date: ${reportGeneratedAt}`,
    );
  }

  return parsed.toISOString().replace(/[-:]/gu, "").replace(/\./gu, "");
}

function deriveRepoName(
  report: IssueReportDocument,
  sourceRoot: string,
): string {
  const repo = report.summary.repo?.trim();
  if (repo !== undefined && repo !== "") {
    const segments = repo.split("/").filter((segment) => segment.length > 0);
    if (segments.length > 0) {
      return segments[segments.length - 1] ?? path.basename(sourceRoot);
    }
  }
  return path.basename(sourceRoot);
}

async function validateArchiveRoot(archiveRoot: string): Promise<void> {
  const stat = await fs.stat(archiveRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IntegrationError(
        `Archive root does not exist at ${archiveRoot}; provide a checked-out factory-runs worktree.`,
      );
    }
    throw error;
  });

  if (!stat.isDirectory()) {
    throw new IntegrationError(
      `Archive root ${archiveRoot} is not a directory; provide a checked-out factory-runs worktree.`,
    );
  }

  await fs.access(archiveRoot, fsConstants.W_OK).catch((error) => {
    throw new IntegrationError(`Archive root ${archiveRoot} is not writable.`, {
      cause: error as Error,
    });
  });

  const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: archiveRoot,
  }).catch((error) => {
    throw new IntegrationError(
      `Archive root ${archiveRoot} must be the root of a checked-out git worktree.`,
      { cause: error as Error },
    );
  });

  const [resolvedArchiveRoot, resolvedTopLevel] = await Promise.all([
    fs.realpath(archiveRoot),
    fs.realpath(result.stdout.trim()),
  ]);

  if (resolvedTopLevel !== resolvedArchiveRoot) {
    throw new IntegrationError(
      `Archive root ${archiveRoot} must point at the git worktree root, not a nested subdirectory.`,
    );
  }
}

async function collectSourceRevision(
  sourceRoot: string,
): Promise<FactoryRunsSourceRevision> {
  const currentBranch = await readGitValue(sourceRoot, [
    "branch",
    "--show-current",
  ]);
  const relevantSha = await readGitValue(sourceRoot, ["rev-parse", "HEAD"]);
  const originMainSha = await readGitValue(sourceRoot, [
    "rev-parse",
    "--verify",
    "origin/main",
  ]);
  const baseSha =
    relevantSha !== null && originMainSha !== null
      ? await readGitValue(sourceRoot, ["merge-base", "HEAD", "origin/main"])
      : null;

  return {
    checkoutPath: sourceRoot,
    currentBranch,
    relevantSha,
    baseSha,
    commitRange:
      baseSha !== null && relevantSha !== null
        ? `${baseSha}..${relevantSha}`
        : null,
  };
}

async function readGitValue(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await execFileAsync("git", [...args], { cwd }).catch(
    () => null,
  );
  if (result === null) {
    return null;
  }
  const value = result.stdout.trim();
  return value === "" ? null : value;
}

async function publishSessionLogs(args: {
  readonly stagingRoot: string;
  readonly archiveRoot: string;
  readonly publicationPaths: FactoryRunsPublicationPaths;
  readonly loadedArtifacts: LoadedIssueArtifacts;
}): Promise<readonly FactoryRunsLogPublicationResult[]> {
  const logSources = collectSessionLogSources(args.loadedArtifacts);
  const results: FactoryRunsLogPublicationResult[] = [];

  for (const source of logSources) {
    const encodedSessionId = encodeURIComponent(source.sessionId);
    const encodedLogName = encodeURIComponent(source.logName);
    const stagedSessionDir = path.join(
      args.stagingRoot,
      "logs",
      encodedSessionId,
    );
    const stagedCopiedPath = path.join(stagedSessionDir, encodedLogName);
    const stagedPointerFile = path.join(
      stagedSessionDir,
      `${encodedLogName}.pointer.json`,
    );
    const finalCopiedPath = path.join(
      args.publicationPaths.logsDir,
      encodedSessionId,
      encodedLogName,
    );
    const finalPointerFile = path.join(
      args.publicationPaths.logsDir,
      encodedSessionId,
      `${encodedLogName}.pointer.json`,
    );

    if (await isReadableFile(source.pointer.location)) {
      await fs.mkdir(stagedSessionDir, { recursive: true });
      await fs.copyFile(source.pointer.location as string, stagedCopiedPath);
      results.push({
        sessionId: source.sessionId,
        logName: source.logName,
        status: "copied",
        sourceLocation: source.pointer.location,
        sourceArchiveLocation: source.pointer.archiveLocation,
        archivePath: toArchiveRelativePath(args.archiveRoot, finalCopiedPath),
        pointerFile: null,
        note: null,
      });
      continue;
    }

    if (
      source.pointer.location !== null ||
      source.pointer.archiveLocation !== null
    ) {
      const note =
        source.pointer.location === null
          ? "Local log file was not recorded; preserved the original pointer metadata."
          : "Local log file was not readable during publication; preserved the original pointer metadata.";
      await fs.mkdir(stagedSessionDir, { recursive: true });
      await fs.writeFile(
        stagedPointerFile,
        `${JSON.stringify(
          {
            version: FACTORY_RUNS_PUBLICATION_SCHEMA_VERSION,
            sessionId: source.sessionId,
            logName: source.logName,
            pointer: source.pointer,
            note,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      results.push({
        sessionId: source.sessionId,
        logName: source.logName,
        status: "referenced",
        sourceLocation: source.pointer.location,
        sourceArchiveLocation: source.pointer.archiveLocation,
        archivePath: null,
        pointerFile: toArchiveRelativePath(args.archiveRoot, finalPointerFile),
        note,
      });
      continue;
    }

    results.push({
      sessionId: source.sessionId,
      logName: source.logName,
      status: "unavailable",
      sourceLocation: null,
      sourceArchiveLocation: null,
      archivePath: null,
      pointerFile: null,
      note: "No local or archived log reference was available for this session log.",
    });
  }

  return results;
}

function collectSessionIds(
  loadedArtifacts: LoadedIssueArtifacts,
): readonly string[] {
  const sessionIds = new Set<string>();
  if (loadedArtifacts.issue?.latestSessionId !== undefined) {
    const latestSessionId = loadedArtifacts.issue.latestSessionId;
    if (latestSessionId !== null) {
      sessionIds.add(latestSessionId);
    }
  }
  for (const attempt of loadedArtifacts.attempts) {
    if (attempt.sessionId !== null) {
      sessionIds.add(attempt.sessionId);
    }
  }
  for (const session of loadedArtifacts.sessions) {
    sessionIds.add(session.sessionId);
  }
  for (const sessionEntry of Object.values(
    loadedArtifacts.logPointers?.sessions ?? {},
  )) {
    if (sessionEntry !== undefined) {
      sessionIds.add(sessionEntry.sessionId);
    }
  }
  return [...sessionIds];
}

function collectSessionLogSources(
  loadedArtifacts: LoadedIssueArtifacts,
): readonly SessionLogSource[] {
  const seen = new Set<string>();
  const entries: SessionLogSource[] = [];
  const pushPointer = (
    sessionId: string,
    pointers: readonly IssueArtifactLogPointer[],
  ): void => {
    for (const pointer of pointers) {
      const key = `${sessionId}\u0000${pointer.name}\u0000${pointer.location ?? ""}\u0000${pointer.archiveLocation ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({
        sessionId,
        logName: pointer.name,
        pointer,
      });
    }
  };

  for (const session of loadedArtifacts.sessions) {
    pushPointer(session.sessionId, session.logPointers);
  }

  for (const sessionEntry of Object.values(
    loadedArtifacts.logPointers?.sessions ?? {},
  )) {
    if (sessionEntry === undefined) {
      continue;
    }
    pushPointer(sessionEntry.sessionId, sessionEntry.pointers);
  }

  return entries;
}

async function isReadableFile(filePath: string | null): Promise<boolean> {
  if (filePath === null) {
    return false;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ?? false;
}

async function replacePublicationDirectory(
  stagingRoot: string,
  publicationRoot: string,
): Promise<void> {
  await fs.mkdir(path.dirname(publicationRoot), { recursive: true });
  const backupRoot = `${publicationRoot}.backup.${process.pid.toString()}.${Date.now().toString()}`;
  let replacedExisting = false;

  try {
    await fs.rename(publicationRoot, backupRoot);
    replacedExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.rename(stagingRoot, publicationRoot);
  } catch (error) {
    if (replacedExisting) {
      await fs.rename(backupRoot, publicationRoot).catch(() => undefined);
    }
    throw new IntegrationError(
      `Failed to finalize publication at ${publicationRoot}`,
      { cause: error as Error },
    );
  }

  if (replacedExisting) {
    await fs
      .rm(backupRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

function toArchiveRelativePath(
  archiveRoot: string,
  targetPath: string,
): string {
  return path.relative(archiveRoot, targetPath).split(path.sep).join("/");
}
