import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import { writeJsonFileAtomic, writeTextFileAtomic } from "./atomic-file.js";
import type { IssueReportEnricher } from "./issue-report-enrichment.js";
import { applyIssueReportEnrichers } from "./issue-report-enrichment.js";
import type {
  IssueArtifactAttemptSnapshot,
  IssueArtifactCheckSnapshot,
  IssueArtifactEvent,
  IssueArtifactLogPointersDocument,
  IssueArtifactOutcome,
  IssueArtifactPullRequestSnapshot,
  IssueArtifactReviewSnapshot,
  IssueArtifactSessionSnapshot,
  IssueArtifactSummary,
} from "./issue-artifacts.js";
import {
  deriveFactoryRuntimeRoot,
  deriveIssueArtifactPaths,
} from "./issue-artifacts.js";
import { renderIssueReportMarkdown } from "./issue-report-markdown.js";

export const ISSUE_REPORT_SCHEMA_VERSION = 2 as const;

export type IssueReportAvailability = "complete" | "partial" | "unavailable";
export type IssueReportTokenUsageStatus =
  | "unavailable"
  | "partial"
  | "estimated"
  | "complete";

export interface IssueReportPaths {
  readonly issueRoot: string;
  readonly reportJsonFile: string;
  readonly reportMarkdownFile: string;
}

export interface StoredIssueReport {
  readonly report: IssueReportDocument;
  readonly rawReportJson: string;
  readonly rawReportMarkdown: string;
  readonly outputPaths: IssueReportPaths;
}

export interface IssueReportSummary {
  readonly status: IssueReportAvailability;
  readonly issueNumber: number;
  readonly issueIdentifier: string | null;
  readonly repo: string | null;
  readonly title: string | null;
  readonly issueUrl: string | null;
  readonly branch: string | null;
  readonly outcome: IssueArtifactOutcome | "unknown";
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly attemptCount: number;
  readonly pullRequestCount: number;
  readonly overallConclusion: string;
  readonly notes: readonly string[];
}

export interface IssueReportTimelineEntry {
  readonly kind: string;
  readonly at: string | null;
  readonly title: string;
  readonly summary: string;
  readonly attemptNumber: number | null;
  readonly sessionId: string | null;
  readonly details: readonly string[];
}

export interface IssueReportPullRequestActivity {
  readonly number: number;
  readonly url: string;
  readonly attemptNumbers: readonly number[];
  readonly firstObservedAt: string | null;
  readonly latestCommitAt: string | null;
  readonly reviewFeedbackRounds: number;
  readonly actionableReviewCount: number | null;
  readonly unresolvedThreadCount: number | null;
  readonly pendingChecks: readonly string[];
  readonly failingChecks: readonly string[];
}

export interface IssueReportGitHubActivity {
  readonly status: IssueReportAvailability;
  readonly issueStateTransitionsStatus: "unavailable";
  readonly issueStateTransitionsNote: string;
  readonly pullRequests: readonly IssueReportPullRequestActivity[];
  readonly reviewFeedbackRounds: number;
  readonly reviewLoopSummary: string;
  readonly mergedAt: string | null;
  readonly mergeNote: string;
  readonly closedAt: string | null;
  readonly closeNote: string;
  readonly notes: readonly string[];
}

export interface IssueReportTokenUsageSession {
  readonly sessionId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: string | null;
  readonly status: IssueReportTokenUsageStatus;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly originator: string | null;
  readonly sessionSource: string | null;
  readonly cliVersion: string | null;
  readonly modelProvider: string | null;
  readonly gitBranch: string | null;
  readonly gitCommit: string | null;
  readonly finalSummary: string | null;
  readonly notes: readonly string[];
  readonly sourceArtifacts: readonly string[];
}

export interface IssueReportTokenUsageAttempt {
  readonly attemptNumber: number;
  readonly sessionIds: readonly string[];
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface IssueReportTokenUsageAgent {
  readonly agent: string;
  readonly sessionCount: number;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface IssueReportTokenUsage {
  readonly status: IssueReportTokenUsageStatus;
  readonly explanation: string;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly sessions: readonly IssueReportTokenUsageSession[];
  readonly attempts: readonly IssueReportTokenUsageAttempt[];
  readonly agents: readonly IssueReportTokenUsageAgent[];
  readonly rawArtifacts: readonly string[];
  readonly notes: readonly string[];
}

export interface IssueReportLearningItem {
  readonly title: string;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface IssueReportLearnings {
  readonly status: IssueReportAvailability;
  readonly observations: readonly IssueReportLearningItem[];
  readonly gaps: readonly string[];
}

export interface IssueReportArtifacts {
  readonly rawIssueRoot: string;
  readonly issueFile: string | null;
  readonly eventsFile: string | null;
  readonly attemptFiles: readonly string[];
  readonly sessionFiles: readonly string[];
  readonly logPointersFile: string | null;
  readonly missingArtifacts: readonly string[];
  readonly generatedReportJson: string;
  readonly generatedReportMarkdown: string;
}

export interface IssueReportOperatorInterventionEntry {
  readonly kind: "approved" | "waived";
  readonly at: string | null;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface IssueReportOperatorInterventions {
  readonly status: IssueReportAvailability;
  readonly summary: string;
  readonly entries: readonly IssueReportOperatorInterventionEntry[];
  readonly note: string;
}

export interface IssueReportDocument {
  readonly version: typeof ISSUE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly summary: IssueReportSummary;
  readonly timeline: readonly IssueReportTimelineEntry[];
  readonly githubActivity: IssueReportGitHubActivity;
  readonly tokenUsage: IssueReportTokenUsage;
  readonly learnings: IssueReportLearnings;
  readonly artifacts: IssueReportArtifacts;
  readonly operatorInterventions: IssueReportOperatorInterventions;
}

export interface LoadedIssueArtifacts {
  readonly issueNumber: number;
  readonly paths: ReturnType<typeof deriveIssueArtifactPaths>;
  readonly issue: IssueArtifactSummary | null;
  readonly events: readonly IssueArtifactEvent[];
  readonly hasEventsFile: boolean;
  readonly attempts: readonly IssueArtifactAttemptSnapshot[];
  readonly sessions: readonly IssueArtifactSessionSnapshot[];
  readonly logPointers: IssueArtifactLogPointersDocument | null;
}

export interface GeneratedIssueReport {
  readonly report: IssueReportDocument;
  readonly markdown: string;
  readonly outputPaths: IssueReportPaths;
}

function deriveIssueReportsRoot(workspaceRoot: string): string {
  return path.join(
    path.dirname(deriveFactoryRuntimeRoot(workspaceRoot)),
    "reports",
    "issues",
  );
}

export function deriveIssueReportPaths(
  workspaceRoot: string,
  issueNumber: number,
): IssueReportPaths {
  const issueRoot = path.join(
    deriveIssueReportsRoot(workspaceRoot),
    issueNumber.toString(),
  );
  return {
    issueRoot,
    reportJsonFile: path.join(issueRoot, "report.json"),
    reportMarkdownFile: path.join(issueRoot, "report.md"),
  };
}

export async function generateIssueReport(
  workspaceRoot: string,
  issueNumber: number,
  options?: {
    readonly generatedAt?: string | undefined;
    readonly enrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<GeneratedIssueReport> {
  const loaded = await loadIssueArtifacts(workspaceRoot, issueNumber);
  const outputPaths = deriveIssueReportPaths(workspaceRoot, issueNumber);
  const generatedAt = options?.generatedAt ?? new Date().toISOString();
  const canonicalReport = buildIssueReport(loaded, outputPaths, generatedAt);
  const report = await applyIssueReportEnrichers(
    canonicalReport,
    {
      workspaceRoot,
      loaded,
    },
    options?.enrichers ?? [],
  );
  const markdown = renderIssueReportMarkdown(report);
  return {
    report,
    markdown,
    outputPaths,
  };
}

export async function writeIssueReport(
  workspaceRoot: string,
  issueNumber: number,
  options?: {
    readonly generatedAt?: string | undefined;
    readonly enrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<GeneratedIssueReport> {
  const generated = await generateIssueReport(workspaceRoot, issueNumber, {
    generatedAt: options?.generatedAt,
    enrichers: options?.enrichers,
  });
  await writeJsonFileAtomic(
    generated.outputPaths.reportJsonFile,
    generated.report,
    { tempPrefix: ".issue-report" },
  );
  await writeTextFileAtomic(
    generated.outputPaths.reportMarkdownFile,
    generated.markdown,
    { tempPrefix: ".issue-report" },
  );
  return generated;
}

export async function readIssueReport(
  workspaceRoot: string,
  issueNumber: number,
): Promise<StoredIssueReport> {
  const outputPaths = deriveIssueReportPaths(workspaceRoot, issueNumber);
  const [rawReportJson, rawReportMarkdown] = await Promise.all([
    readRequiredIssueReportFile(
      outputPaths.reportJsonFile,
      issueNumber,
      "JSON",
    ),
    readRequiredIssueReportFile(
      outputPaths.reportMarkdownFile,
      issueNumber,
      "markdown",
    ),
  ]);

  let report: IssueReportDocument;
  try {
    report = JSON.parse(rawReportJson) as IssueReportDocument;
  } catch (error) {
    throw new ObservabilityError(
      `Failed to parse generated issue report JSON at ${outputPaths.reportJsonFile}`,
      {
        cause: error as Error,
      },
    );
  }

  return {
    report,
    rawReportJson,
    rawReportMarkdown,
    outputPaths,
  };
}

async function readRequiredIssueReportFile(
  filePath: string,
  issueNumber: number,
  fileKind: "JSON" | "markdown",
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ObservabilityError(
        `No generated issue report ${fileKind} found for issue #${issueNumber.toString()} at ${filePath}; run 'symphony-report issue --issue ${issueNumber.toString()}' first.`,
        {
          cause: error as Error,
        },
      );
    }
    throw error;
  }
}

export async function loadIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
): Promise<LoadedIssueArtifacts> {
  const paths = deriveIssueArtifactPaths(workspaceRoot, issueNumber);

  const issueRootStat = await fs.stat(paths.issueRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (issueRootStat === null || !issueRootStat.isDirectory()) {
    throw new ObservabilityError(
      `No local issue artifacts found for issue #${issueNumber.toString()} at ${paths.issueRoot}`,
    );
  }

  const [issue, eventLedger, attempts, sessions, logPointers] =
    await Promise.all([
      readOptionalJson<IssueArtifactSummary>(paths.issueFile),
      readOptionalJsonLines(paths.eventsFile),
      readJsonArrayFromDir<IssueArtifactAttemptSnapshot>(
        paths.attemptsDir,
        compareNumberNamedFiles,
        isNumberNamedJsonFile,
      ),
      readJsonArrayFromDir<IssueArtifactSessionSnapshot>(
        paths.sessionsDir,
        compareTextNamedFiles,
      ),
      readOptionalJson<IssueArtifactLogPointersDocument>(paths.logPointersFile),
    ]);
  const events = eventLedger ?? [];

  if (
    issue === null &&
    events.length === 0 &&
    attempts.length === 0 &&
    sessions.length === 0 &&
    logPointers === null
  ) {
    throw new ObservabilityError(
      `Issue artifact directory ${paths.issueRoot} does not contain readable canonical artifacts for issue #${issueNumber.toString()}`,
    );
  }

  return {
    issueNumber,
    paths,
    issue,
    events,
    hasEventsFile: eventLedger !== null,
    attempts,
    sessions,
    logPointers,
  };
}

function buildIssueReport(
  loaded: LoadedIssueArtifacts,
  outputPaths: IssueReportPaths,
  generatedAt: string,
): IssueReportDocument {
  const pullRequests = collectPullRequests(loaded);
  const attemptNumbers = collectAttemptNumbers(loaded);
  const summary = buildSummary(loaded, attemptNumbers, pullRequests);
  const timeline = buildTimeline(loaded, summary);
  const githubActivity = buildGitHubActivity(loaded, pullRequests);
  const tokenUsage = buildTokenUsage(loaded, attemptNumbers);
  const learnings = buildLearnings(loaded, summary, timeline, pullRequests);
  const artifacts = buildArtifacts(loaded, outputPaths);
  const operatorInterventions = buildOperatorInterventions(loaded);

  return {
    version: ISSUE_REPORT_SCHEMA_VERSION,
    generatedAt,
    summary,
    timeline,
    githubActivity,
    tokenUsage,
    learnings,
    artifacts,
    operatorInterventions,
  };
}

function buildSummary(
  loaded: LoadedIssueArtifacts,
  attemptNumbers: readonly number[],
  pullRequests: readonly IssueReportPullRequestActivity[],
): IssueReportSummary {
  const summary = loaded.issue;
  const startedAt = earliestTimestamp([
    summary?.firstObservedAt ?? null,
    ...loaded.events.map((event) => event.observedAt),
    ...loaded.attempts.map((attempt) => attempt.startedAt),
    ...loaded.sessions.map((session) => session.startedAt),
  ]);
  const endedAt = latestTimestamp([
    isTerminalOutcome(summary?.currentOutcome)
      ? (summary?.lastUpdatedAt ?? null)
      : null,
    ...loaded.attempts.map((attempt) =>
      isTerminalOutcome(attempt.outcome) ? attempt.finishedAt : null,
    ),
    ...loaded.events
      .filter((event) => event.kind === "succeeded" || event.kind === "failed")
      .map((event) => event.observedAt),
  ]);
  const notes: string[] = [];

  if (summary === null) {
    notes.push(
      "Canonical issue summary metadata is unavailable; this report is anchored from remaining local artifacts.",
    );
  }
  if (!loaded.hasEventsFile) {
    notes.push(
      "No canonical lifecycle event ledger was available; the timeline is reconstructed from attempt and session snapshots where possible.",
    );
  } else if (loaded.events.length === 0) {
    notes.push(
      "The canonical lifecycle event ledger was present but contained no recorded lifecycle events.",
    );
  }
  if (loaded.sessions.length > 0 && loaded.issue === null) {
    notes.push(
      "Session metadata preserved the issue anchor, but title, repo, and issue URL could not be recovered from the canonical summary artifact.",
    );
  }

  const eventOutcome = inferOutcomeFromEvents(loaded.events);
  const summaryOutcome = summary?.currentOutcome ?? null;
  const outcome =
    (summaryOutcome !== null &&
    !(
      eventOutcome !== null &&
      isTerminalOutcome(eventOutcome) &&
      !isTerminalOutcome(summaryOutcome)
    )
      ? summaryOutcome
      : null) ??
    eventOutcome ??
    loaded.attempts.at(-1)?.outcome ??
    "unknown";
  const status =
    summary !== null && loaded.events.length > 0 ? "complete" : "partial";

  return {
    status,
    issueNumber: loaded.issueNumber,
    issueIdentifier: summary?.issueIdentifier ?? null,
    repo: summary?.repo ?? null,
    title: summary?.title ?? null,
    issueUrl: summary?.issueUrl ?? null,
    branch:
      summary?.branch ??
      loaded.attempts.at(-1)?.branch ??
      loaded.sessions.at(-1)?.branch ??
      null,
    outcome,
    startedAt,
    endedAt,
    attemptCount: attemptNumbers.length,
    pullRequestCount: pullRequests.length,
    overallConclusion: buildOverallConclusion({
      issueNumber: loaded.issueNumber,
      outcome,
      attemptCount: attemptNumbers.length,
      pullRequestCount: pullRequests.length,
      isPartial: status !== "complete",
    }),
    notes,
  };
}

function buildTimeline(
  loaded: LoadedIssueArtifacts,
  summary: IssueReportSummary,
): readonly IssueReportTimelineEntry[] {
  const eventEntries = loaded.events.map((event) => buildTimelineEntry(event));
  const derivedEntries: IssueReportTimelineEntry[] = [];
  const runnerSpawnedAttempts = new Set(
    loaded.events
      .filter((event) => event.kind === "runner-spawned")
      .map((event) => event.attemptNumber)
      .filter(
        (attemptNumber): attemptNumber is number => attemptNumber !== null,
      ),
  );

  for (const attempt of loaded.attempts) {
    if (
      !runnerSpawnedAttempts.has(attempt.attemptNumber) &&
      attempt.startedAt
    ) {
      derivedEntries.push({
        kind: "attempt-started",
        at: attempt.startedAt,
        title: `Attempt ${attempt.attemptNumber.toString()} observed`,
        summary: attempt.summary,
        attemptNumber: attempt.attemptNumber,
        sessionId: attempt.sessionId,
        details: [
          `Outcome: ${attempt.outcome}`,
          ...(attempt.branch ? [`Branch: ${attempt.branch}`] : []),
        ],
      });
    }
  }

  if (
    isTerminalOutcome(summary.outcome) &&
    !loaded.events.some((event) =>
      summary.outcome === "succeeded"
        ? event.kind === "succeeded"
        : event.kind === "failed",
    )
  ) {
    derivedEntries.push({
      kind: "terminal-outcome",
      at: summary.endedAt,
      title:
        summary.outcome === "succeeded" ? "Issue completed" : "Issue failed",
      summary: summary.overallConclusion,
      attemptNumber: loaded.attempts.at(-1)?.attemptNumber ?? null,
      sessionId: loaded.attempts.at(-1)?.sessionId ?? null,
      details: summary.notes,
    });
  }

  if (eventEntries.length === 0 && derivedEntries.length === 0) {
    const lastSession = loaded.sessions.at(-1);
    derivedEntries.push({
      kind: "artifacts-observed",
      at: summary.startedAt ?? lastSession?.startedAt ?? null,
      title: "Local artifacts observed",
      summary: !loaded.hasEventsFile
        ? "The canonical event ledger was unavailable; this report is based on the remaining local snapshots."
        : "No lifecycle events were recorded in the canonical event ledger; this report is based on the remaining local snapshots.",
      attemptNumber: lastSession?.attemptNumber ?? null,
      sessionId: lastSession?.sessionId ?? null,
      details: summary.notes,
    });
  }

  return [...eventEntries, ...derivedEntries].sort(compareTimelineEntries);
}

function buildGitHubActivity(
  loaded: LoadedIssueArtifacts,
  pullRequests: readonly IssueReportPullRequestActivity[],
): IssueReportGitHubActivity {
  const reviewFeedbackRounds = loaded.events.filter(
    (event) => event.kind === "review-feedback",
  ).length;
  const notes = [
    "Issue state and label transitions are not part of the canonical local artifact contract yet.",
    "Merge timing and exact issue-close timing remain unavailable until richer raw GitHub lifecycle facts are stored locally.",
  ];

  return {
    status: "partial",
    issueStateTransitionsStatus: "unavailable",
    issueStateTransitionsNote:
      "Canonical local artifacts do not record issue state or label transition history.",
    pullRequests,
    reviewFeedbackRounds,
    reviewLoopSummary: buildReviewLoopSummary(
      pullRequests,
      reviewFeedbackRounds,
    ),
    mergedAt: null,
    mergeNote:
      "Canonical local artifacts do not yet record merge timestamps or merge commits.",
    closedAt: null,
    closeNote:
      "Canonical local artifacts do not yet record exact issue close timing.",
    notes,
  };
}

function buildTokenUsage(
  loaded: LoadedIssueArtifacts,
  attemptNumbers: readonly number[],
): IssueReportTokenUsage {
  const sessions = loaded.sessions.map((session) => ({
    sessionId: session.sessionId,
    attemptNumber: session.attemptNumber,
    provider: session.provider,
    model: session.model,
    status: "unavailable" as const,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    costUsd: null,
    originator: null,
    sessionSource: null,
    cliVersion: null,
    modelProvider: null,
    gitBranch: null,
    gitCommit: null,
    finalSummary: null,
    notes: [],
    sourceArtifacts: [
      path.join(
        loaded.paths.sessionsDir,
        `${encodeURIComponent(session.sessionId)}.json`,
      ),
    ],
  }));
  const attempts = attemptNumbers.map((attemptNumber) => ({
    attemptNumber,
    sessionIds: loaded.sessions
      .filter((session) => session.attemptNumber === attemptNumber)
      .map((session) => session.sessionId),
    totalTokens: null,
    costUsd: null,
  }));
  const agents = aggregateAgents(loaded.sessions);

  return {
    status: "unavailable",
    explanation:
      "Canonical local artifacts include session metadata and raw log pointers, but they do not yet store provider token totals or cost data. Later enrichment is deferred to issue #46.",
    totalTokens: null,
    costUsd: null,
    sessions,
    attempts,
    agents,
    rawArtifacts: [
      ...sessions.flatMap((session) => session.sourceArtifacts),
      ...(loaded.logPointers === null ? [] : [loaded.paths.logPointersFile]),
    ],
    notes: [],
  };
}

function buildLearnings(
  loaded: LoadedIssueArtifacts,
  summary: IssueReportSummary,
  timeline: readonly IssueReportTimelineEntry[],
  pullRequests: readonly IssueReportPullRequestActivity[],
): IssueReportLearnings {
  const observations: IssueReportLearningItem[] = [];
  const retryCount = loaded.events.filter(
    (event) => event.kind === "retry-scheduled",
  ).length;
  const planReadyCount = loaded.events.filter(
    (event) => event.kind === "plan-ready",
  ).length;
  const reviewFeedbackRounds = loaded.events.filter(
    (event) => event.kind === "review-feedback",
  ).length;

  observations.push({
    title: "Outcome",
    summary: summary.overallConclusion,
    evidence: [
      `Derived outcome: ${summary.outcome}`,
      `Attempt count: ${summary.attemptCount.toString()}`,
      `Timeline entries: ${timeline.length.toString()}`,
    ],
  });

  if (planReadyCount > 0) {
    observations.push({
      title: "Plan review station",
      summary:
        "The issue passed through the explicit plan review handoff before implementation continued.",
      evidence: [`Plan-ready events observed: ${planReadyCount.toString()}`],
    });
  }

  if (pullRequests.length > 0) {
    observations.push({
      title: "Pull request loop",
      summary: buildReviewLoopSummary(pullRequests, reviewFeedbackRounds),
      evidence: [
        `Pull requests observed: ${pullRequests.length.toString()}`,
        `Review feedback rounds: ${reviewFeedbackRounds.toString()}`,
      ],
    });
  }

  if (retryCount > 0) {
    observations.push({
      title: "Retries",
      summary:
        "The issue required at least one retry or follow-up attempt before reaching its latest recorded state.",
      evidence: [`Retry events observed: ${retryCount.toString()}`],
    });
  }

  const gaps = [
    ...(loaded.issue === null
      ? [
          "Issue summary metadata was missing, so this report could not recover the canonical title, repo, or issue URL from local artifacts alone.",
        ]
      : []),
    ...(!loaded.hasEventsFile
      ? [
          "The canonical lifecycle event ledger was unavailable, so lifecycle learnings are necessarily incomplete.",
        ]
      : loaded.events.length === 0
        ? [
            "The canonical lifecycle event ledger was present but empty, so lifecycle learnings are necessarily incomplete.",
          ]
        : []),
  ];

  return {
    status: gaps.length > 0 ? "partial" : "complete",
    observations,
    gaps,
  };
}

function buildArtifacts(
  loaded: LoadedIssueArtifacts,
  outputPaths: IssueReportPaths,
): IssueReportArtifacts {
  const missingArtifacts = [
    ...(loaded.issue === null ? [loaded.paths.issueFile] : []),
    ...(!loaded.hasEventsFile ? [loaded.paths.eventsFile] : []),
    ...(loaded.logPointers === null ? [loaded.paths.logPointersFile] : []),
  ];

  return {
    rawIssueRoot: loaded.paths.issueRoot,
    issueFile: loaded.issue === null ? null : loaded.paths.issueFile,
    eventsFile: loaded.hasEventsFile ? loaded.paths.eventsFile : null,
    attemptFiles: loaded.attempts.map((attempt) =>
      path.join(
        loaded.paths.attemptsDir,
        `${attempt.attemptNumber.toString()}.json`,
      ),
    ),
    sessionFiles: loaded.sessions.map((session) =>
      path.join(
        loaded.paths.sessionsDir,
        `${encodeURIComponent(session.sessionId)}.json`,
      ),
    ),
    logPointersFile:
      loaded.logPointers === null ? null : loaded.paths.logPointersFile,
    missingArtifacts,
    generatedReportJson: outputPaths.reportJsonFile,
    generatedReportMarkdown: outputPaths.reportMarkdownFile,
  };
}

function buildOperatorInterventions(
  loaded: LoadedIssueArtifacts,
): IssueReportOperatorInterventions {
  if (!loaded.hasEventsFile) {
    return {
      status: "unavailable",
      summary:
        "Operator interventions could not be assessed because the canonical event ledger was unavailable.",
      entries: [],
      note: "Only explicit approved or waived handoff events would appear here.",
    };
  }

  const entries = loaded.events
    .filter(
      (
        event,
      ): event is IssueArtifactEvent & {
        readonly kind: "approved" | "waived";
      } => event.kind === "approved" || event.kind === "waived",
    )
    .map((event) => ({
      kind: event.kind,
      at: event.observedAt,
      summary:
        event.kind === "approved" ? "Plan approved" : "Plan review waived",
      details: formatEventDetails(event.details),
    }));

  return {
    status: "partial",
    summary:
      entries.length > 0
        ? `Observed ${entries.length.toString()} explicit operator handoff event(s) in canonical local artifacts.`
        : "No explicit operator handoff events were recorded in canonical local artifacts.",
    entries,
    note: "This section only reflects explicit approved or waived handoff events preserved in local artifacts; it does not prove that no manual action occurred elsewhere.",
  };
}

function buildTimelineEntry(
  event: IssueArtifactEvent,
): IssueReportTimelineEntry {
  switch (event.kind) {
    case "claimed":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Issue claimed",
        summary:
          "Symphony claimed the issue and prepared it for local execution.",
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "plan-ready":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Plan ready for review",
        summary: readEventSummary(event.details, "Plan review handoff posted."),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "approved":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Plan approved",
        summary: readEventSummary(
          event.details,
          "Human review approved implementation.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "waived":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Plan review waived",
        summary: readEventSummary(
          event.details,
          "Plan review was explicitly waived.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "runner-spawned":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: `Attempt ${renderAttemptNumber(event.attemptNumber)} started`,
        summary: "A local coding-agent session started for this issue.",
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "pr-opened":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Pull request opened",
        summary: readEventSummary(
          event.details,
          "A pull request was observed for the issue branch.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "review-feedback":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Review feedback observed",
        summary: readEventSummary(
          event.details,
          "Actionable review feedback or unresolved review threads were observed.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "retry-scheduled":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Retry scheduled",
        summary: readEventSummary(
          event.details,
          "The runtime scheduled another attempt for the issue.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "succeeded":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Issue completed",
        summary: readEventSummary(
          event.details,
          "The issue reached a successful terminal outcome.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "failed":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Issue failed",
        summary: readEventSummary(
          event.details,
          "The issue reached a failed terminal outcome.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
  }
}

function collectAttemptNumbers(
  loaded: LoadedIssueArtifacts,
): readonly number[] {
  return [
    ...new Set([
      ...loaded.attempts.map((attempt) => attempt.attemptNumber),
      ...loaded.sessions.map((session) => session.attemptNumber),
      ...loaded.events
        .map((event) => event.attemptNumber)
        .filter(
          (attemptNumber): attemptNumber is number => attemptNumber !== null,
        ),
      ...(loaded.issue?.latestAttemptNumber === null || loaded.issue === null
        ? []
        : [loaded.issue.latestAttemptNumber]),
    ]),
  ].sort((left, right) => left - right);
}

function collectPullRequests(
  loaded: LoadedIssueArtifacts,
): readonly IssueReportPullRequestActivity[] {
  const collected = new Map<
    number,
    {
      url: string;
      attemptNumbers: Set<number>;
      firstObservedAt: string | null;
      latestCommitAt: string | null;
      reviewFeedbackRounds: number;
      actionableReviewCount: number | null;
      unresolvedThreadCount: number | null;
      pendingChecks: readonly string[];
      failingChecks: readonly string[];
    }
  >();

  for (const attempt of loaded.attempts) {
    if (attempt.pullRequest === null) {
      continue;
    }
    const existing = collected.get(attempt.pullRequest.number);
    collected.set(attempt.pullRequest.number, {
      url: attempt.pullRequest.url,
      attemptNumbers: new Set([
        ...(existing?.attemptNumbers ?? []),
        attempt.attemptNumber,
      ]),
      firstObservedAt:
        earliestTimestamp([
          existing?.firstObservedAt ?? null,
          attempt.finishedAt,
        ]) ?? attempt.finishedAt,
      latestCommitAt:
        latestTimestamp([
          existing?.latestCommitAt ?? null,
          attempt.pullRequest.latestCommitAt,
        ]) ?? attempt.pullRequest.latestCommitAt,
      reviewFeedbackRounds: existing?.reviewFeedbackRounds ?? 0,
      actionableReviewCount:
        attempt.review?.actionableCount ??
        existing?.actionableReviewCount ??
        null,
      unresolvedThreadCount:
        attempt.review?.unresolvedThreadCount ??
        existing?.unresolvedThreadCount ??
        null,
      pendingChecks:
        attempt.checks?.pendingNames ?? existing?.pendingChecks ?? [],
      failingChecks:
        attempt.checks?.failingNames ?? existing?.failingChecks ?? [],
    });
  }

  for (const event of loaded.events) {
    const pullRequest = readPullRequestFromDetails(event.details);
    if (pullRequest === null) {
      continue;
    }
    const existing = collected.get(pullRequest.number);
    collected.set(pullRequest.number, {
      url: pullRequest.url,
      attemptNumbers: new Set([
        ...(existing?.attemptNumbers ?? []),
        ...(event.attemptNumber === null ? [] : [event.attemptNumber]),
      ]),
      firstObservedAt:
        earliestTimestamp([
          existing?.firstObservedAt ?? null,
          event.observedAt,
        ]) ?? event.observedAt,
      latestCommitAt:
        latestTimestamp([
          existing?.latestCommitAt ?? null,
          pullRequest.latestCommitAt,
        ]) ?? pullRequest.latestCommitAt,
      reviewFeedbackRounds:
        (existing?.reviewFeedbackRounds ?? 0) +
        (event.kind === "review-feedback" ? 1 : 0),
      actionableReviewCount:
        readReviewFromDetails(event.details)?.actionableCount ??
        existing?.actionableReviewCount ??
        null,
      unresolvedThreadCount:
        readReviewFromDetails(event.details)?.unresolvedThreadCount ??
        existing?.unresolvedThreadCount ??
        null,
      pendingChecks:
        readChecksFromDetails(event.details)?.pendingNames ??
        existing?.pendingChecks ??
        [],
      failingChecks:
        readChecksFromDetails(event.details)?.failingNames ??
        existing?.failingChecks ??
        [],
    });
  }

  return [...collected.entries()]
    .map(([number, value]) => ({
      number,
      url: value.url,
      attemptNumbers: [...value.attemptNumbers].sort(
        (left, right) => left - right,
      ),
      firstObservedAt: value.firstObservedAt,
      latestCommitAt: value.latestCommitAt,
      reviewFeedbackRounds: value.reviewFeedbackRounds,
      actionableReviewCount: value.actionableReviewCount,
      unresolvedThreadCount: value.unresolvedThreadCount,
      pendingChecks: value.pendingChecks,
      failingChecks: value.failingChecks,
    }))
    .sort((left, right) => left.number - right.number);
}

function buildOverallConclusion(input: {
  readonly issueNumber: number;
  readonly outcome: IssueArtifactOutcome | "unknown";
  readonly attemptCount: number;
  readonly pullRequestCount: number;
  readonly isPartial: boolean;
}): string {
  const attempts = `${input.attemptCount.toString()} attempt(s)`;
  const pullRequests = `${input.pullRequestCount.toString()} pull request(s)`;
  const prefix =
    input.outcome === "succeeded"
      ? `Issue #${input.issueNumber.toString()} succeeded after ${attempts} and ${pullRequests}.`
      : input.outcome === "failed"
        ? `Issue #${input.issueNumber.toString()} failed after ${attempts} and ${pullRequests}.`
        : input.outcome === "unknown"
          ? `Issue #${input.issueNumber.toString()} has only partial local artifacts; the latest outcome could not be determined conclusively.`
          : `Issue #${input.issueNumber.toString()} is currently recorded as ${input.outcome} after ${attempts} and ${pullRequests}.`;
  return input.isPartial ? `${prefix} The report is partial.` : prefix;
}

function buildReviewLoopSummary(
  pullRequests: readonly IssueReportPullRequestActivity[],
  reviewFeedbackRounds: number,
): string {
  if (pullRequests.length === 0) {
    return "No pull request was observed in canonical local artifacts.";
  }
  if (reviewFeedbackRounds === 0) {
    return "A pull request was observed with no recorded actionable review-feedback rounds in canonical local artifacts.";
  }
  return `Observed ${reviewFeedbackRounds.toString()} recorded review-feedback round(s) across ${pullRequests.length.toString()} pull request(s).`;
}

function aggregateAgents(
  sessions: readonly IssueArtifactSessionSnapshot[],
): readonly IssueReportTokenUsageAgent[] {
  const grouped = new Map<string, number>();
  for (const session of sessions) {
    const label =
      session.model === null
        ? session.provider
        : `${session.provider} (${session.model})`;
    grouped.set(label, (grouped.get(label) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .map(([agent, sessionCount]) => ({
      agent,
      sessionCount,
      totalTokens: null,
      costUsd: null,
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));
}

function readPullRequestFromDetails(
  details: Readonly<Record<string, unknown>>,
): IssueArtifactPullRequestSnapshot | null {
  const pullRequest = details["pullRequest"];
  if (pullRequest === null || typeof pullRequest !== "object") {
    return null;
  }
  const value = pullRequest as Record<string, unknown>;
  if (typeof value["number"] !== "number" || typeof value["url"] !== "string") {
    return null;
  }
  return {
    number: value["number"],
    url: value["url"],
    latestCommitAt:
      typeof value["latestCommitAt"] === "string"
        ? value["latestCommitAt"]
        : null,
  };
}

function readReviewFromDetails(
  details: Readonly<Record<string, unknown>>,
): IssueArtifactReviewSnapshot | null {
  const review = details["review"];
  if (review === null || typeof review !== "object") {
    return null;
  }
  const value = review as Record<string, unknown>;
  if (
    typeof value["actionableCount"] !== "number" ||
    typeof value["unresolvedThreadCount"] !== "number"
  ) {
    return null;
  }
  return {
    actionableCount: value["actionableCount"],
    unresolvedThreadCount: value["unresolvedThreadCount"],
  };
}

function readChecksFromDetails(
  details: Readonly<Record<string, unknown>>,
): IssueArtifactCheckSnapshot | null {
  const checks = details["checks"];
  if (checks === null || typeof checks !== "object") {
    return null;
  }
  const value = checks as Record<string, unknown>;
  const pendingNames = asStringArray(value["pendingNames"]);
  const failingNames = asStringArray(value["failingNames"]);
  if (pendingNames === null || failingNames === null) {
    return null;
  }
  return {
    pendingNames,
    failingNames,
  };
}

function readEventSummary(
  details: Readonly<Record<string, unknown>>,
  fallback: string,
): string {
  const summary = details["summary"];
  return typeof summary === "string" && summary.length > 0 ? summary : fallback;
}

function formatEventDetails(
  details: Readonly<Record<string, unknown>>,
): readonly string[] {
  const rendered: string[] = [];
  const branch = details["branch"];
  if (typeof branch === "string" && branch.length > 0) {
    rendered.push(`Branch: ${branch}`);
  }

  const pullRequest = readPullRequestFromDetails(details);
  if (pullRequest !== null) {
    rendered.push(`PR #${pullRequest.number.toString()}: ${pullRequest.url}`);
  }

  const review = readReviewFromDetails(details);
  if (review !== null) {
    rendered.push(
      `Review: ${review.actionableCount.toString()} actionable, ${review.unresolvedThreadCount.toString()} unresolved thread(s)`,
    );
  }

  const checks = readChecksFromDetails(details);
  if (checks !== null) {
    if (checks.pendingNames.length > 0) {
      rendered.push(`Pending checks: ${checks.pendingNames.join(", ")}`);
    }
    if (checks.failingNames.length > 0) {
      rendered.push(`Failing checks: ${checks.failingNames.join(", ")}`);
    }
  }

  const pid = details["pid"];
  if (typeof pid === "number") {
    rendered.push(`Runner PID: ${pid.toString()}`);
  }

  const summary = details["summary"];
  if (typeof summary === "string" && summary.length > 0) {
    rendered.push(`Summary: ${summary}`);
  }

  return rendered;
}

function compareTimelineEntries(
  left: IssueReportTimelineEntry,
  right: IssueReportTimelineEntry,
): number {
  const leftTimestamp = left.at ?? "";
  const rightTimestamp = right.at ?? "";
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp.localeCompare(rightTimestamp);
  }
  return timelineKindOrder(left.kind) - timelineKindOrder(right.kind);
}

function timelineKindOrder(kind: string): number {
  switch (kind) {
    case "claimed":
      return 1;
    case "plan-ready":
      return 2;
    case "approved":
    case "waived":
      return 3;
    case "runner-spawned":
    case "attempt-started":
      return 4;
    case "pr-opened":
      return 5;
    case "review-feedback":
      return 6;
    case "retry-scheduled":
      return 7;
    case "succeeded":
    case "failed":
    case "terminal-outcome":
      return 8;
    default:
      return 99;
  }
}

function renderAttemptNumber(attemptNumber: number | null): string {
  return attemptNumber === null ? "unknown" : attemptNumber.toString();
}

function inferOutcomeFromEvents(
  events: readonly IssueArtifactEvent[],
): IssueArtifactOutcome | null {
  for (const event of [...events].reverse()) {
    if (event.kind === "succeeded") {
      return "succeeded";
    }
    if (event.kind === "failed") {
      return "failed";
    }
    if (event.kind === "retry-scheduled") {
      return "retry-scheduled";
    }
    if (event.kind === "review-feedback") {
      return "needs-follow-up";
    }
    if (event.kind === "pr-opened") {
      return "awaiting-review";
    }
    if (event.kind === "runner-spawned") {
      return "running";
    }
    if (event.kind === "approved" || event.kind === "waived") {
      return "claimed";
    }
    if (event.kind === "plan-ready") {
      return "awaiting-plan-review";
    }
    if (event.kind === "claimed") {
      return "claimed";
    }
  }
  return null;
}

function isTerminalOutcome(
  outcome: IssueArtifactOutcome | "unknown" | null | undefined,
): outcome is "succeeded" | "failed" {
  return outcome === "succeeded" || outcome === "failed";
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  return await readJsonFile<T>(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

async function readOptionalJsonLines(
  filePath: string,
): Promise<readonly IssueArtifactEvent[] | null> {
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return null;
  }

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as IssueArtifactEvent;
      } catch (error) {
        throw new ObservabilityError(
          `Failed to parse JSONL artifact at ${filePath}`,
          { cause: error as Error },
        );
      }
    });
}

async function readJsonArrayFromDir<T>(
  dirPath: string,
  compareNames: (left: string, right: string) => number,
  includeName?: (fileName: string) => boolean,
): Promise<readonly T[]> {
  const entries = await fs
    .readdir(dirPath, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
  if (entries === null) {
    return [];
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => includeName?.(entry.name) ?? true)
    .map((entry) => entry.name)
    .sort(compareNames);
  return await Promise.all(
    jsonFiles.map((entry) => readJsonFile<T>(path.join(dirPath, entry))),
  );
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

function earliestTimestamp(
  timestamps: readonly (string | null | undefined)[],
): string | null {
  const values = timestamps.filter(
    (timestamp): timestamp is string => typeof timestamp === "string",
  );
  return values.length === 0 ? null : ([...values].sort()[0] ?? null);
}

function latestTimestamp(
  timestamps: readonly (string | null | undefined)[],
): string | null {
  const values = timestamps.filter(
    (timestamp): timestamp is string => typeof timestamp === "string",
  );
  return values.length === 0 ? null : ([...values].sort().at(-1) ?? null);
}

function compareNumberNamedFiles(left: string, right: string): number {
  const leftNumber = Number.parseInt(path.parse(left).name, 10);
  const rightNumber = Number.parseInt(path.parse(right).name, 10);
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
    return left.localeCompare(right);
  }
  return leftNumber - rightNumber;
}

function compareTextNamedFiles(left: string, right: string): number {
  return left.localeCompare(right);
}

function isNumberNamedJsonFile(fileName: string): boolean {
  return /^\d+\.json$/u.test(fileName);
}

function asStringArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  return value;
}
