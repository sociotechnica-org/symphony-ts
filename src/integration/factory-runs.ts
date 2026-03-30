import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IntegrationError } from "../domain/errors.js";
import type { RuntimeInstanceInput } from "../domain/workflow.js";
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
  readonly instance?: RuntimeInstanceInput;
  readonly workspaceRoot?: string;
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
  readonly origin: "session-pointer" | "pointer-document" | "report-artifact";
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
  const instance = options.instance ?? options.workspaceRoot;
  if (instance === undefined) {
    throw new IntegrationError(
      "publishIssueToFactoryRuns requires either instance or workspaceRoot",
    );
  }

  await validateArchiveRoot(archiveRoot);

  const [reportInput, loadedArtifacts, sourceRevision] = await Promise.all([
    readIssueReport(instance, options.issueNumber),
    loadIssueArtifacts(instance, options.issueNumber),
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

  try {
    await fs.mkdir(stagingRoot, { recursive: true });

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
      report: reportInput.report,
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
    await cleanupEmptyPublicationDirectories(paths);
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
    args.logEntries.length === 0 || unavailableCount === args.logEntries.length
      ? "unavailable"
      : referencedCount > 0 || unavailableCount > 0
        ? "partial"
        : "complete";
  const notes: string[] = [];

  if (logStatus === "unavailable") {
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
    publicationStatus: logStatus === "complete" ? "complete" : "partial",
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
    const segments = repo
      .split(/[/\\]/u)
      .filter(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      );
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
  const remoteBaseRef = await resolveRemoteBaseRef(sourceRoot);
  const baseSha =
    relevantSha !== null && remoteBaseRef !== null
      ? await readGitValue(sourceRoot, ["merge-base", "HEAD", remoteBaseRef])
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

async function resolveRemoteBaseRef(
  sourceRoot: string,
): Promise<string | null> {
  const remoteHead = await readGitValue(sourceRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  const candidates = [
    remoteHead?.replace(/^refs\/remotes\//u, "") ?? null,
    "origin/main",
    "origin/master",
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const resolved = await readGitValue(sourceRoot, [
      "rev-parse",
      "--verify",
      candidate,
    ]);
    if (resolved !== null) {
      return candidate;
    }
  }

  return null;
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
  readonly report: IssueReportDocument;
  readonly loadedArtifacts: LoadedIssueArtifacts;
}): Promise<readonly FactoryRunsLogPublicationResult[]> {
  const logSources = collectSessionLogSources(
    args.loadedArtifacts,
    args.report,
  );
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
    const selectedCopySource = await selectReadableLogSource(source.sources);
    let referenceSource: SessionLogSource | null =
      selectedCopySource ?? selectReferenceLogSource(source.sources);
    let pointerNoteOverride: string | null = null;

    if (selectedCopySource !== null) {
      try {
        await fs.mkdir(stagedSessionDir, { recursive: true });
        await fs.copyFile(
          selectedCopySource.pointer.location as string,
          stagedCopiedPath,
        );
        results.push({
          sessionId: source.sessionId,
          logName: source.logName,
          status: "copied",
          sourceLocation: selectedCopySource.pointer.location,
          sourceArchiveLocation: selectedCopySource.pointer.archiveLocation,
          archivePath: toArchiveRelativePath(args.archiveRoot, finalCopiedPath),
          pointerFile: null,
          note: null,
        });
        continue;
      } catch {
        await fs.rm(stagedCopiedPath, { force: true }).catch(() => undefined);
        referenceSource =
          selectReferenceLogSource(source.sources) ?? selectedCopySource;
        pointerNoteOverride = buildCopyFailureNote(referenceSource);
      }
    }

    if (
      referenceSource !== null &&
      (referenceSource.pointer.location !== null ||
        referenceSource.pointer.archiveLocation !== null)
    ) {
      const note = pointerNoteOverride ?? buildReferenceNote(referenceSource);
      await fs.mkdir(stagedSessionDir, { recursive: true });
      await fs.writeFile(
        stagedPointerFile,
        `${JSON.stringify(
          {
            version: FACTORY_RUNS_PUBLICATION_SCHEMA_VERSION,
            sessionId: source.sessionId,
            logName: source.logName,
            evidenceSource: referenceSource.origin,
            pointer: referenceSource.pointer,
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
        sourceLocation: referenceSource.pointer.location,
        sourceArchiveLocation: referenceSource.pointer.archiveLocation,
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
  report: IssueReportDocument,
): readonly {
  readonly sessionId: string;
  readonly logName: string;
  readonly sources: readonly SessionLogSource[];
}[] {
  const candidates = new Map<string, SessionLogSource[]>();
  const pushPointer = (
    sessionId: string,
    pointers: readonly IssueArtifactLogPointer[],
    origin: SessionLogSource["origin"],
  ): void => {
    for (const pointer of pointers) {
      const key = `${sessionId}\u0000${pointer.name}`;
      const existing = candidates.get(key) ?? [];
      existing.push({
        sessionId,
        logName: pointer.name,
        pointer,
        origin,
      });
      candidates.set(key, existing);
    }
  };

  for (const session of loadedArtifacts.sessions) {
    pushPointer(session.sessionId, session.logPointers, "session-pointer");
  }

  for (const sessionEntry of Object.values(
    loadedArtifacts.logPointers?.sessions ?? {},
  )) {
    if (sessionEntry === undefined) {
      continue;
    }
    pushPointer(
      sessionEntry.sessionId,
      sessionEntry.pointers,
      "pointer-document",
    );
  }

  for (const source of collectReportDerivedLogSources(
    loadedArtifacts,
    report,
  )) {
    pushPointer(source.sessionId, [source.pointer], source.origin);
  }

  const entries = [...candidates.entries()]
    .map(([key, sources]) => {
      const [sessionId, logName] = key.split("\u0000");
      return {
        sessionId: sessionId ?? "",
        logName: logName ?? "",
        sources,
      };
    })
    .sort((left, right) => {
      if (left.sessionId !== right.sessionId) {
        return left.sessionId.localeCompare(right.sessionId);
      }
      return left.logName.localeCompare(right.logName);
    });

  const coveredSessionIds = new Set(entries.map((entry) => entry.sessionId));
  for (const sessionId of collectEvidenceSessionIds(loadedArtifacts, report)) {
    if (coveredSessionIds.has(sessionId)) {
      continue;
    }
    entries.push({
      sessionId,
      logName: "raw-log",
      sources: [],
    });
  }

  return entries.sort((left, right) => {
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    return left.logName.localeCompare(right.logName);
  });
}

function collectReportDerivedLogSources(
  loadedArtifacts: LoadedIssueArtifacts,
  report: IssueReportDocument,
): readonly SessionLogSource[] {
  const canonicalSessionArtifacts = new Map(
    loadedArtifacts.sessions.map((session) => [
      session.sessionId,
      path.resolve(
        path.join(
          loadedArtifacts.paths.sessionsDir,
          `${encodeURIComponent(session.sessionId)}.json`,
        ),
      ),
    ]),
  );
  const entries: SessionLogSource[] = [];

  for (const session of report.tokenUsage.sessions) {
    const canonicalArtifact =
      canonicalSessionArtifacts.get(session.sessionId) ?? null;
    for (const artifact of session.sourceArtifacts) {
      if (artifact.trim() === "") {
        continue;
      }
      if (
        canonicalArtifact !== null &&
        path.resolve(artifact) === canonicalArtifact
      ) {
        continue;
      }
      entries.push({
        sessionId: session.sessionId,
        logName: path.basename(artifact),
        pointer: {
          name: path.basename(artifact),
          location: artifact,
          archiveLocation: null,
        },
        origin: "report-artifact",
      });
    }
  }

  return entries;
}

function collectEvidenceSessionIds(
  loadedArtifacts: LoadedIssueArtifacts,
  report: IssueReportDocument,
): readonly string[] {
  return [
    ...new Set([
      ...collectSessionIds(loadedArtifacts),
      ...report.tokenUsage.sessions.map((session) => session.sessionId),
    ]),
  ];
}

async function selectReadableLogSource(
  sources: readonly SessionLogSource[],
): Promise<SessionLogSource | null> {
  const ranked = rankSessionLogSources(sources);
  for (const source of ranked) {
    if (await isReadableFile(source.pointer.location)) {
      return source;
    }
  }
  return null;
}

function selectReferenceLogSource(
  sources: readonly SessionLogSource[],
): SessionLogSource | null {
  for (const source of rankSessionLogSources(sources)) {
    if (
      source.pointer.location !== null ||
      source.pointer.archiveLocation !== null
    ) {
      return source;
    }
  }
  return null;
}

function rankSessionLogSources(
  sources: readonly SessionLogSource[],
): readonly SessionLogSource[] {
  return [...sources].sort((left, right) => {
    if (left.origin !== right.origin) {
      return (
        rankSessionLogOrigin(left.origin) - rankSessionLogOrigin(right.origin)
      );
    }
    const leftLocation = left.pointer.location ?? "";
    const rightLocation = right.pointer.location ?? "";
    if (leftLocation !== rightLocation) {
      return leftLocation.localeCompare(rightLocation);
    }
    return (left.pointer.archiveLocation ?? "").localeCompare(
      right.pointer.archiveLocation ?? "",
    );
  });
}

function rankSessionLogOrigin(origin: SessionLogSource["origin"]): number {
  switch (origin) {
    case "session-pointer":
      return 0;
    case "pointer-document":
      return 1;
    case "report-artifact":
      return 2;
  }
}

function buildCopyFailureNote(source: SessionLogSource): string {
  return source.origin === "report-artifact"
    ? "A report-derived raw log file could not be copied during publication; preserved the discovered raw log path."
    : "Local log file could not be copied during publication; preserved the original pointer metadata.";
}

function buildReferenceNote(source: SessionLogSource): string {
  if (source.origin === "report-artifact") {
    return source.pointer.location === null
      ? "A report-derived raw log path was not recorded; no durable raw log reference could be preserved."
      : "A report-derived raw log file was not readable during publication; preserved the discovered raw log path.";
  }
  return source.pointer.location === null
    ? "Local log file was not recorded; preserved the original pointer metadata."
    : "Local log file was not readable during publication; preserved the original pointer metadata.";
}

async function isReadableFile(filePath: string | null): Promise<boolean> {
  if (filePath === null) {
    return false;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return false;
  }
  return await fs
    .access(filePath, fsConstants.R_OK)
    .then(() => true)
    .catch(() => false);
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

async function cleanupEmptyPublicationDirectories(
  paths: FactoryRunsPublicationPaths,
): Promise<void> {
  const candidates = [
    paths.issueRoot,
    path.dirname(paths.issueRoot),
    paths.repoRoot,
  ];

  for (const directory of candidates) {
    await fs.rmdir(directory).catch(() => undefined);
  }
}

function toArchiveRelativePath(
  archiveRoot: string,
  targetPath: string,
): string {
  return path.relative(archiveRoot, targetPath).split(path.sep).join("/");
}
