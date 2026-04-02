import fs from "node:fs/promises";
import path from "node:path";
import type {
  PullRequestRequiredReviewerState,
  PullRequestReviewerVerdict,
} from "../domain/handoff.js";
import { ObservabilityError } from "../domain/errors.js";
import {
  coerceRuntimeInstancePaths,
  type RuntimeInstanceInput,
} from "../domain/workflow.js";
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
  IssueArtifactTransition,
} from "./issue-artifacts.js";
import {
  deriveIssueArtifactPaths,
  readIssueArtifactSummary,
} from "./issue-artifacts.js";
import { createRunnerAccountingSnapshot } from "../runner/accounting.js";
import { renderIssueReportMarkdown } from "./issue-report-markdown.js";
import {
  deriveGitHubActivityAvailability,
  type GitHubActivityAvailability,
} from "./github-activity-completeness.js";
import { applyIssueReportProviderPricing } from "./issue-report-pricing.js";
import { rollupIssueReportTokenUsageSessions } from "./issue-report-token-usage.js";

export const ISSUE_REPORT_SCHEMA_VERSION = 6 as const;

export type IssueReportAvailability = GitHubActivityAvailability;
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

export interface StoredIssueReportDocument {
  readonly report: IssueReportDocument;
  readonly rawReportJson: string;
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
  readonly reviewerVerdict: PullRequestReviewerVerdict | null;
  readonly blockingReviewerKeys: readonly string[];
  readonly requiredReviewerState: PullRequestRequiredReviewerState | null;
  readonly pendingChecks: readonly string[];
  readonly failingChecks: readonly string[];
}

export interface IssueReportGitHubActivity {
  readonly status: IssueReportAvailability;
  readonly issueStateTransitionsStatus: IssueReportAvailability;
  readonly issueStateTransitionsNote: string;
  readonly issueTransitions: readonly IssueReportTrackerTransition[];
  readonly pullRequests: readonly IssueReportPullRequestActivity[];
  readonly reviewFeedbackRounds: number;
  readonly reviewLoopSummary: string;
  readonly mergeTimingRelevant: boolean;
  readonly mergedAt: string | null;
  readonly mergeNote: string;
  readonly closeTimingRelevant: boolean;
  readonly closedAt: string | null;
  readonly closeNote: string;
  readonly notes: readonly string[];
}

export interface IssueReportTrackerTransition {
  readonly at: string;
  readonly kind: "state-changed" | "labels-changed";
  readonly summary: string;
  readonly details: readonly string[];
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
  readonly observedTokenSubtotal: number | null;
  readonly observedCostSubtotal: number | null;
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
  readonly kind:
    | "approved"
    | "waived"
    | "landing-command-observed"
    | "report-published"
    | "report-review-recorded"
    | "report-follow-up-filed";
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

interface AttemptStartTimelineState {
  primaryStartEntryIndex: number | null;
  latestVisibleStartEntryIndex: number | null;
  pendingRecoveryCue: IssueArtifactEvent | null;
  closed: boolean;
}

export function deriveIssueReportsRoot(instance: RuntimeInstanceInput): string {
  return coerceRuntimeInstancePaths(instance).issueReportsRoot;
}

export function deriveIssueReportPaths(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): IssueReportPaths {
  const issueRoot = path.join(
    deriveIssueReportsRoot(instance),
    issueNumber.toString(),
  );
  return {
    issueRoot,
    reportJsonFile: path.join(issueRoot, "report.json"),
    reportMarkdownFile: path.join(issueRoot, "report.md"),
  };
}

export async function generateIssueReport(
  instance: RuntimeInstanceInput,
  issueNumber: number,
  options?: {
    readonly generatedAt?: string | undefined;
    readonly enrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<GeneratedIssueReport> {
  const resolvedInstance = coerceRuntimeInstancePaths(instance);
  const loaded = await loadIssueArtifacts(resolvedInstance, issueNumber);
  const outputPaths = deriveIssueReportPaths(resolvedInstance, issueNumber);
  const generatedAt = options?.generatedAt ?? new Date().toISOString();
  const canonicalReport = buildIssueReport(loaded, outputPaths, generatedAt);
  const report = await applyIssueReportEnrichers(
    canonicalReport,
    {
      workspaceRoot: resolvedInstance.workspaceRoot,
      loaded,
    },
    options?.enrichers ?? [],
  );
  const pricedReport = applyIssueReportProviderPricing(report);
  const markdown = renderIssueReportMarkdown(pricedReport);
  return {
    report: pricedReport,
    markdown,
    outputPaths,
  };
}

export async function writeIssueReport(
  instance: RuntimeInstanceInput,
  issueNumber: number,
  options?: {
    readonly generatedAt?: string | undefined;
    readonly enrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<GeneratedIssueReport> {
  const generated = await generateIssueReport(instance, issueNumber, {
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

export async function readIssueReportDocument(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<StoredIssueReportDocument> {
  const outputPaths = deriveIssueReportPaths(instance, issueNumber);
  const rawReportJson = await readRequiredIssueReportFile(
    outputPaths.reportJsonFile,
    issueNumber,
    "JSON",
  );

  let parsedReport: unknown;
  try {
    parsedReport = JSON.parse(rawReportJson);
  } catch (error) {
    throw new ObservabilityError(
      `Failed to parse generated issue report JSON at ${outputPaths.reportJsonFile}`,
      {
        cause: error as Error,
      },
    );
  }
  const report = validateStoredIssueReport(
    parsedReport,
    outputPaths.reportJsonFile,
    issueNumber,
  );

  return {
    report,
    rawReportJson,
    outputPaths,
  };
}

export async function readIssueReport(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<StoredIssueReport> {
  const [storedDocumentResult, rawReportMarkdownResult] =
    await Promise.allSettled([
      readIssueReportDocument(instance, issueNumber),
      readRequiredIssueReportFile(
        deriveIssueReportPaths(instance, issueNumber).reportMarkdownFile,
        issueNumber,
        "markdown",
      ),
    ]);

  if (storedDocumentResult.status === "rejected") {
    throw storedDocumentResult.reason;
  }
  if (rawReportMarkdownResult.status === "rejected") {
    throw rawReportMarkdownResult.reason;
  }

  const storedDocument = storedDocumentResult.value;
  const rawReportMarkdown = rawReportMarkdownResult.value;

  return {
    report: storedDocument.report,
    rawReportJson: storedDocument.rawReportJson,
    rawReportMarkdown,
    outputPaths: storedDocument.outputPaths,
  };
}

function validateStoredIssueReport(
  parsedReport: unknown,
  reportJsonFile: string,
  issueNumber: number,
): IssueReportDocument {
  if (typeof parsedReport !== "object" || parsedReport === null) {
    throw new ObservabilityError(
      `Generated issue report JSON at ${reportJsonFile} did not contain a report document object; run 'symphony-report issue --issue ${issueNumber.toString()}' first to regenerate it.`,
    );
  }

  const versionValue = (parsedReport as { version?: unknown }).version;
  if (typeof versionValue !== "number" || !Number.isInteger(versionValue)) {
    throw new ObservabilityError(
      `Generated issue report JSON at ${reportJsonFile} is missing a supported schema version; run 'symphony-report issue --issue ${issueNumber.toString()}' first to regenerate it.`,
    );
  }
  if (versionValue !== ISSUE_REPORT_SCHEMA_VERSION) {
    throw new ObservabilityError(
      `Generated issue report JSON at ${reportJsonFile} uses schema version ${versionValue.toString()}, but this build expects ${ISSUE_REPORT_SCHEMA_VERSION.toString()}; run 'symphony-report issue --issue ${issueNumber.toString()}' first to regenerate it.`,
    );
  }

  return parsedReport as IssueReportDocument;
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
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<LoadedIssueArtifacts> {
  const paths = deriveIssueArtifactPaths(instance, issueNumber);

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
      readOptionalIssueArtifactSummary(instance, issueNumber),
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
    isTerminalOutcome(summary?.currentOutcome) ? summary.lastUpdatedAt : null,
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
  const eventEntries = buildEventTimelineEntries(loaded.events);
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

function buildEventTimelineEntries(
  events: readonly IssueArtifactEvent[],
): readonly IssueReportTimelineEntry[] {
  const entries: IssueReportTimelineEntry[] = [];
  const attemptStartStates = new Map<number, AttemptStartTimelineState>();

  for (const event of events) {
    if (event.kind === "runner-spawned") {
      appendRunnerSpawnTimelineEntry(entries, attemptStartStates, event);
      continue;
    }

    entries.push(buildTimelineEntry(event));
    updateAttemptStartTimelineState(attemptStartStates, event);
  }

  return entries;
}

function appendRunnerSpawnTimelineEntry(
  entries: IssueReportTimelineEntry[],
  attemptStartStates: Map<number, AttemptStartTimelineState>,
  event: IssueArtifactEvent,
): void {
  if (event.attemptNumber === null) {
    entries.push(buildTimelineEntry(event));
    return;
  }

  const state = getAttemptStartTimelineState(
    attemptStartStates,
    event.attemptNumber,
  );
  if (state.primaryStartEntryIndex === null || state.closed) {
    entries.push(buildTimelineEntry(event));
    const entryIndex = entries.length - 1;
    state.primaryStartEntryIndex = entryIndex;
    state.latestVisibleStartEntryIndex = entryIndex;
    state.pendingRecoveryCue = null;
    state.closed = false;
    return;
  }

  if (state.pendingRecoveryCue !== null) {
    entries.push(
      buildAttemptResumedTimelineEntry(event, state.pendingRecoveryCue),
    );
    state.latestVisibleStartEntryIndex = entries.length - 1;
    state.pendingRecoveryCue = null;
    return;
  }

  const visibleEntryIndex =
    state.latestVisibleStartEntryIndex ?? state.primaryStartEntryIndex;

  const visibleEntry = entries[visibleEntryIndex];
  if (visibleEntry === undefined) {
    entries.push(buildTimelineEntry(event));
    const entryIndex = entries.length - 1;
    state.latestVisibleStartEntryIndex = entryIndex;
    return;
  }
  entries[visibleEntryIndex] = {
    ...visibleEntry,
    summary: summarizeCollapsedAttemptStart(visibleEntry.summary),
    details: [
      ...visibleEntry.details,
      formatCollapsedAttemptStartEvidence(event),
    ],
  };
}

function getAttemptStartTimelineState(
  attemptStartStates: Map<number, AttemptStartTimelineState>,
  attemptNumber: number,
): AttemptStartTimelineState {
  const existing = attemptStartStates.get(attemptNumber);
  if (existing !== undefined) {
    return existing;
  }
  const created: AttemptStartTimelineState = {
    primaryStartEntryIndex: null,
    latestVisibleStartEntryIndex: null,
    pendingRecoveryCue: null,
    closed: false,
  };
  attemptStartStates.set(attemptNumber, created);
  return created;
}

function updateAttemptStartTimelineState(
  attemptStartStates: Map<number, AttemptStartTimelineState>,
  event: IssueArtifactEvent,
): void {
  if (event.attemptNumber === null) {
    return;
  }

  const state = getAttemptStartTimelineState(
    attemptStartStates,
    event.attemptNumber,
  );

  switch (event.kind) {
    case "shutdown-requested":
    case "shutdown-terminated":
      if (state.primaryStartEntryIndex !== null && !state.closed) {
        state.pendingRecoveryCue = event;
      }
      break;
    case "retry-scheduled":
    case "succeeded":
    case "failed":
      state.pendingRecoveryCue = null;
      state.closed = true;
      break;
    case "claimed":
    case "plan-ready":
    case "approved":
    case "waived":
    case "landing-command-observed":
    case "report-published":
    case "report-review-recorded":
    case "report-follow-up-filed":
    case "runner-spawned":
    case "pr-opened":
    case "landing-blocked":
    case "landing-failed":
    case "landing-requested":
    case "review-feedback":
      break;
  }
}

function buildAttemptResumedTimelineEntry(
  event: IssueArtifactEvent,
  recoveryCue: IssueArtifactEvent,
): IssueReportTimelineEntry {
  const summary =
    recoveryCue.kind === "shutdown-requested"
      ? "A local coding-agent session resumed for the same attempt after an intentional shutdown request."
      : "A local coding-agent session resumed for the same attempt after shutdown interrupted the prior run.";

  return {
    kind: "attempt-started",
    at: event.observedAt,
    title: `Attempt ${renderAttemptNumber(event.attemptNumber)} resumed after shutdown`,
    summary,
    attemptNumber: event.attemptNumber,
    sessionId: event.sessionId,
    details: [
      `Recovery cue: ${describeRecoveryCue(recoveryCue)}`,
      `Recovery cue observed at: ${recoveryCue.observedAt}`,
      ...formatEventDetails(event.details),
    ].filter((detail) => detail.length > 0),
  };
}

function describeRecoveryCue(recoveryCue: IssueArtifactEvent): string {
  switch (recoveryCue.kind) {
    case "shutdown-requested":
      return "Shutdown requested";
    case "shutdown-terminated":
      return recoveryCue.details["forced"] === true
        ? "Shutdown forced"
        : "Shutdown completed";
    case "claimed":
    case "plan-ready":
    case "approved":
    case "waived":
    case "landing-command-observed":
    case "report-published":
    case "report-review-recorded":
    case "report-follow-up-filed":
    case "runner-spawned":
    case "pr-opened":
    case "landing-blocked":
    case "landing-failed":
    case "landing-requested":
    case "review-feedback":
    case "retry-scheduled":
    case "succeeded":
    case "failed":
      return recoveryCue.kind;
  }
}

function summarizeCollapsedAttemptStart(summary: string): string {
  if (summary.includes("Additional same-attempt start evidence")) {
    return summary;
  }
  return `${summary} Additional same-attempt start evidence was observed and collapsed into this entry.`;
}

function formatCollapsedAttemptStartEvidence(
  event: IssueArtifactEvent,
): string {
  return `Additional same-attempt start evidence observed at ${event.observedAt}${event.sessionId === null ? "" : ` (session ${event.sessionId})`}.`;
}

function buildGitHubActivity(
  loaded: LoadedIssueArtifacts,
  pullRequests: readonly IssueReportPullRequestActivity[],
): IssueReportGitHubActivity {
  const reviewFeedbackRounds = loaded.events.filter(
    (event) => event.kind === "review-feedback",
  ).length;
  const mergedAt = loaded.issue?.mergedAt ?? null;
  const closedAt = loaded.issue?.closedAt ?? null;
  const issueTransitions = buildIssueTrackerTransitions(
    loaded.issue?.issueTransitions ?? [],
  );
  const issueStateTransitionsStatus =
    issueTransitions.length > 0
      ? "complete"
      : loaded.issue !== null &&
          (loaded.issue.trackerState !== null ||
            loaded.issue.trackerLabels.length > 0)
        ? "complete"
        : "unavailable";
  const issueStateTransitionsNote =
    issueTransitions.length > 0
      ? `Canonical local artifacts preserved ${issueTransitions.length.toString()} observed issue state/label transition${issueTransitions.length === 1 ? "" : "s"}.`
      : issueStateTransitionsStatus === "complete"
        ? "Canonical local artifacts preserved tracker-side issue snapshots, but no state or label change was observed after the initial snapshot."
        : "Canonical local artifacts do not record issue state or label transition history.";
  const pullRequestActivity = derivePullRequestActivityCompleteness(
    loaded,
    pullRequests,
  );
  const mergeTiming = deriveMergeTimingCompleteness(loaded, mergedAt);
  const closeTiming = deriveCloseTimingCompleteness(loaded, closedAt);
  const notes = [
    ...(issueStateTransitionsStatus === "unavailable"
      ? [
          "Issue state and label transitions were unavailable because this issue artifact predates the canonical transition ledger.",
        ]
      : issueTransitions.length === 0
        ? [
            "No issue-side state or label changes were observed after the initial tracker snapshot for this run.",
          ]
        : []),
    ...(pullRequestActivity.note === null ? [] : [pullRequestActivity.note]),
    ...(mergeTiming.note === null ? [] : [mergeTiming.note]),
    ...(closeTiming.note === null ? [] : [closeTiming.note]),
  ];

  return {
    status: deriveGitHubActivityAvailability([
      issueStateTransitionsStatus,
      pullRequestActivity.status,
      mergeTiming.status,
      closeTiming.status,
    ]),
    issueStateTransitionsStatus,
    issueStateTransitionsNote,
    issueTransitions,
    pullRequests,
    reviewFeedbackRounds,
    reviewLoopSummary: buildReviewLoopSummary(
      pullRequests,
      reviewFeedbackRounds,
    ),
    mergeTimingRelevant: mergeTiming.status !== null,
    mergedAt,
    mergeNote:
      mergeTiming.status === null
        ? "No merged pull request was observed, so merge timing was not applicable for this issue."
        : mergedAt === null
          ? "Canonical local artifacts did not preserve a merged pull request timestamp for this issue."
          : "Canonical local artifacts preserved the merged pull request timestamp for this issue.",
    closeTimingRelevant: closeTiming.status !== null,
    closedAt,
    closeNote:
      closeTiming.status === null
        ? "The issue was not observed in a closed tracker state, so exact issue close timing was not applicable for this issue."
        : closedAt === null
          ? "Canonical local artifacts did not preserve exact issue close timing for this issue."
          : "Canonical local artifacts preserved the exact issue close timestamp for this issue.",
    notes,
  };
}

function derivePullRequestActivityCompleteness(
  loaded: LoadedIssueArtifacts,
  pullRequests: readonly IssueReportPullRequestActivity[],
): {
  readonly status: IssueReportAvailability | null;
  readonly note: string | null;
} {
  if (pullRequests.length === 0) {
    return {
      status: null,
      note: null,
    };
  }

  const coverage = collectPullRequestCoverage(loaded);
  const statuses = pullRequests.map((pullRequest) =>
    classifyPullRequestActivity(
      pullRequest,
      coverage.get(pullRequest.number) ?? {
        hasReview: false,
        hasChecks: false,
      },
    ),
  );
  const status = deriveGitHubActivityAvailability(statuses);
  const nonCompleteCount = statuses.filter(
    (entryStatus) => entryStatus !== "complete",
  ).length;

  return {
    status,
    note:
      status === "complete"
        ? null
        : status === "unavailable"
          ? "Observed pull requests lacked canonical review/check coverage, so pull request activity completeness was unavailable."
          : `Canonical local artifacts preserved incomplete review/check coverage for ${nonCompleteCount.toString()} of ${pullRequests.length.toString()} observed pull request(s).`,
  };
}

function collectPullRequestCoverage(
  loaded: LoadedIssueArtifacts,
): ReadonlyMap<number, { hasReview: boolean; hasChecks: boolean }> {
  const coverage = new Map<
    number,
    { hasReview: boolean; hasChecks: boolean }
  >();

  for (const attempt of loaded.attempts) {
    if (attempt.pullRequest === null) {
      continue;
    }

    const existing = coverage.get(attempt.pullRequest.number) ?? {
      hasReview: false,
      hasChecks: false,
    };
    coverage.set(attempt.pullRequest.number, {
      hasReview: existing.hasReview || attempt.review !== null,
      hasChecks: existing.hasChecks || attempt.checks !== null,
    });
  }

  for (const event of loaded.events) {
    const pullRequest = readPullRequestFromDetails(event.details);
    if (pullRequest === null) {
      continue;
    }

    const existing = coverage.get(pullRequest.number) ?? {
      hasReview: false,
      hasChecks: false,
    };
    coverage.set(pullRequest.number, {
      hasReview:
        existing.hasReview || readReviewFromDetails(event.details) !== null,
      hasChecks:
        existing.hasChecks || readChecksFromDetails(event.details) !== null,
    });
  }

  return coverage;
}

function classifyPullRequestActivity(
  pullRequest: IssueReportPullRequestActivity,
  coverage: {
    readonly hasReview: boolean;
    readonly hasChecks: boolean;
  },
): IssueReportAvailability {
  const reviewComplete =
    coverage.hasReview &&
    pullRequest.actionableReviewCount !== null &&
    pullRequest.unresolvedThreadCount !== null &&
    pullRequest.reviewerVerdict !== null &&
    pullRequest.requiredReviewerState !== null;
  const checksComplete = coverage.hasChecks;
  if (reviewComplete && checksComplete) {
    return "complete";
  }

  const hasAnyReviewFacts =
    coverage.hasReview ||
    pullRequest.actionableReviewCount !== null ||
    pullRequest.unresolvedThreadCount !== null ||
    pullRequest.reviewerVerdict !== null ||
    pullRequest.requiredReviewerState !== null;

  return hasAnyReviewFacts || coverage.hasChecks ? "partial" : "unavailable";
}

function deriveMergeTimingCompleteness(
  loaded: LoadedIssueArtifacts,
  mergedAt: string | null,
): {
  readonly status: IssueReportAvailability | null;
  readonly note: string | null;
} {
  if (!isMergeTimingRelevant(loaded)) {
    return {
      status: null,
      note: null,
    };
  }

  return {
    status: mergedAt === null ? "partial" : "complete",
    note:
      mergedAt === null
        ? "Merge timing was relevant for this issue outcome, but the canonical local artifacts did not preserve it."
        : null,
  };
}

function isMergeTimingRelevant(loaded: LoadedIssueArtifacts): boolean {
  return (
    (loaded.issue?.mergedAt !== null && loaded.issue?.mergedAt !== undefined) ||
    loaded.issue?.currentOutcome === "merged" ||
    loaded.issue?.currentOutcome === "succeeded"
  );
}

function deriveCloseTimingCompleteness(
  loaded: LoadedIssueArtifacts,
  closedAt: string | null,
): {
  readonly status: IssueReportAvailability | null;
  readonly note: string | null;
} {
  if (!isCloseTimingRelevant(loaded)) {
    return {
      status: null,
      note: null,
    };
  }

  return {
    status: closedAt === null ? "partial" : "complete",
    note:
      closedAt === null
        ? "Exact issue close timing was relevant for this issue activity, but the canonical local artifacts did not preserve it."
        : null,
  };
}

function isCloseTimingRelevant(loaded: LoadedIssueArtifacts): boolean {
  if (
    (loaded.issue?.closedAt !== null && loaded.issue?.closedAt !== undefined) ||
    loaded.issue?.trackerState === "closed" ||
    loaded.issue?.currentOutcome === "succeeded"
  ) {
    return true;
  }

  return (loaded.issue?.issueTransitions ?? []).some(
    (transition) =>
      transition.kind === "state-changed" && transition.toState === "closed",
  );
}

function buildIssueTrackerTransitions(
  transitions: readonly IssueArtifactTransition[],
): readonly IssueReportTrackerTransition[] {
  return transitions.map((transition) => {
    if (transition.kind === "state-changed") {
      return {
        at: transition.observedAt,
        kind: transition.kind,
        summary: `Issue state changed from ${renderTransitionValue(transition.fromState)} to ${renderTransitionValue(transition.toState)}.`,
        details: [],
      };
    }

    return {
      at: transition.observedAt,
      kind: transition.kind,
      summary: `Issue labels changed (${transition.addedLabels.length.toString()} added, ${transition.removedLabels.length.toString()} removed).`,
      details: [
        `From: ${renderTransitionLabels(transition.fromLabels)}`,
        `To: ${renderTransitionLabels(transition.toLabels)}`,
        `Added: ${renderTransitionLabels(transition.addedLabels)}`,
        `Removed: ${renderTransitionLabels(transition.removedLabels)}`,
      ],
    };
  });
}

function renderTransitionValue(value: string | null): string {
  return value ?? "(none)";
}

function renderTransitionLabels(labels: readonly string[]): string {
  return labels.length === 0 ? "None" : labels.join(", ");
}

function buildTokenUsage(
  loaded: LoadedIssueArtifacts,
  attemptNumbers: readonly number[],
): IssueReportTokenUsage {
  const sessions = loaded.sessions.map((session) =>
    buildTokenUsageSession(loaded, session),
  );
  const rollup = rollupIssueReportTokenUsageSessions(sessions, attemptNumbers);
  const completeCount = rollup.counts.complete;
  const estimatedCount = rollup.counts.estimated;
  const partialCount = rollup.counts.partial;
  const unavailableCount = rollup.counts.unavailable;
  const status = rollup.status;
  const explanation =
    status === "complete"
      ? `Canonical runner-event accounting supplied complete token and cost totals for all ${sessions.length.toString()} session(s).`
      : status === "estimated"
        ? `All ${sessions.length.toString()} session(s) supplied token totals, but ${estimatedCount.toString()} session(s) remained estimated.`
        : status === "partial"
          ? `Canonical runner-event accounting was complete for ${completeCount.toString()} of ${sessions.length.toString()} session(s); ${[
              estimatedCount > 0
                ? `${estimatedCount.toString()} remained estimated`
                : null,
              partialCount > 0
                ? `${partialCount.toString()} remained partial`
                : null,
              unavailableCount > 0
                ? `${unavailableCount.toString()} remained unavailable`
                : null,
            ]
              .filter((value): value is string => value !== null)
              .join(", ")}.`
          : "Canonical runner-event accounting was unavailable for all recorded sessions.";
  const notes = [
    ...(rollup.totalTokens === null && rollup.observedTokenSubtotal !== null
      ? [
          `${sessions.filter((session) => session.totalTokens !== null).length.toString()} of ${sessions.length.toString()} recorded session(s) supplied token totals, yielding an observed token subtotal of ${rollup.observedTokenSubtotal.toString()} even though the strict aggregate total remained unavailable.`,
        ]
      : []),
    ...(rollup.costUsd === null && rollup.observedCostSubtotal !== null
      ? [
          `${sessions.filter((session) => session.costUsd !== null).length.toString()} of ${sessions.length.toString()} recorded session(s) supplied explicit cost facts, yielding an observed cost subtotal of ${rollup.observedCostSubtotal.toFixed(2)} USD even though the strict aggregate cost remained unavailable.`,
        ]
      : []),
    ...(sessions.some((session) => session.costUsd === null)
      ? [
          "At least one recorded session lacked an explicit backend-provided cost fact, so aggregate cost remained partial or unavailable.",
        ]
      : []),
    ...(sessions.some((session) => session.totalTokens === null)
      ? [
          "At least one recorded session lacked complete backend-provided token totals, so aggregate token usage remained partial or unavailable.",
        ]
      : []),
  ];

  return {
    status,
    explanation,
    totalTokens: rollup.totalTokens,
    costUsd: rollup.costUsd,
    observedTokenSubtotal: rollup.observedTokenSubtotal,
    observedCostSubtotal: rollup.observedCostSubtotal,
    sessions,
    attempts: rollup.attempts,
    agents: rollup.agents,
    rawArtifacts: [
      ...sessions.flatMap((session) => session.sourceArtifacts),
      ...(loaded.logPointers === null ? [] : [loaded.paths.logPointersFile]),
    ],
    notes,
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
      note: "This section only reflects operator interventions preserved in canonical local artifacts.",
    };
  }

  const entries = loaded.events.flatMap((event) => {
    const entry = buildOperatorInterventionEntry(event);
    return entry === null ? [] : [entry];
  });

  return {
    status: "partial",
    summary:
      entries.length > 0
        ? `Observed ${entries.length.toString()} operator intervention event(s) in canonical local artifacts.`
        : "No operator intervention events were recorded in canonical local artifacts.",
    entries,
    note: "This section reflects operator interventions preserved in canonical local artifacts; it does not prove that no manual action occurred elsewhere.",
  };
}

function buildOperatorInterventionEntry(
  event: IssueArtifactEvent,
): IssueReportOperatorInterventionEntry | null {
  switch (event.kind) {
    case "approved":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Plan approved",
        details: formatEventDetails(event.details),
      };
    case "waived":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Plan review waived",
        details: formatEventDetails(event.details),
      };
    case "landing-command-observed":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Landing command observed",
        details: formatEventDetails(event.details),
      };
    case "report-published":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Report published",
        details: formatEventDetails(event.details),
      };
    case "report-review-recorded":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Report review recorded",
        details: formatEventDetails(event.details),
      };
    case "report-follow-up-filed":
      return {
        kind: event.kind,
        at: event.observedAt,
        summary: "Report follow-up filed",
        details: formatEventDetails(event.details),
      };
    case "claimed":
    case "plan-ready":
    case "shutdown-requested":
    case "shutdown-terminated":
    case "runner-spawned":
    case "pr-opened":
    case "landing-blocked":
    case "landing-failed":
    case "landing-requested":
    case "review-feedback":
    case "retry-scheduled":
    case "succeeded":
    case "failed":
      return null;
  }
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
    case "landing-command-observed":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Landing command observed",
        summary: readEventSummary(
          event.details,
          "A /land command was observed for the current pull request head.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "report-published":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Report published",
        summary: readEventSummary(
          event.details,
          "Issue report artifacts were published to the factory-runs archive.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "report-review-recorded":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Report review recorded",
        summary: readEventSummary(
          event.details,
          "An operator recorded a completed-run report review decision.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "report-follow-up-filed":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Report follow-up filed",
        summary: readEventSummary(
          event.details,
          "An operator filed a GitHub follow-up issue from a completed-run report.",
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
    case "shutdown-requested":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Shutdown requested",
        summary: readEventSummary(
          event.details,
          "The local runtime requested an intentional shutdown for the active run.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "shutdown-terminated":
      return {
        kind: event.kind,
        at: event.observedAt,
        title:
          event.details["forced"] === true
            ? "Shutdown forced"
            : "Shutdown completed",
        summary: readEventSummary(
          event.details,
          "The active run stopped because the local runtime shut down intentionally.",
        ),
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
    case "landing-blocked":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Landing blocked",
        summary: readEventSummary(
          event.details,
          "Symphony refused to land the current pull request.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "landing-failed":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Landing failed",
        summary: readEventSummary(
          event.details,
          "Symphony failed before it could dispatch the landing request.",
        ),
        attemptNumber: event.attemptNumber,
        sessionId: event.sessionId,
        details: formatEventDetails(event.details),
      };
    case "landing-requested":
      return {
        kind: event.kind,
        at: event.observedAt,
        title: "Landing requested",
        summary: readEventSummary(
          event.details,
          "Symphony requested landing for the current pull request.",
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
      reviewerVerdict: PullRequestReviewerVerdict | null;
      blockingReviewerKeys: readonly string[];
      requiredReviewerState: PullRequestRequiredReviewerState | null;
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
      reviewerVerdict:
        attempt.review?.reviewerVerdict ?? existing?.reviewerVerdict ?? null,
      blockingReviewerKeys:
        attempt.review?.blockingReviewerKeys ??
        existing?.blockingReviewerKeys ??
        [],
      requiredReviewerState:
        attempt.review?.requiredReviewerState ??
        existing?.requiredReviewerState ??
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
      reviewerVerdict:
        readReviewFromDetails(event.details)?.reviewerVerdict ??
        existing?.reviewerVerdict ??
        null,
      blockingReviewerKeys:
        readReviewFromDetails(event.details)?.blockingReviewerKeys ??
        existing?.blockingReviewerKeys ??
        [],
      requiredReviewerState:
        readReviewFromDetails(event.details)?.requiredReviewerState ??
        existing?.requiredReviewerState ??
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
      reviewerVerdict: value.reviewerVerdict,
      blockingReviewerKeys: value.blockingReviewerKeys,
      requiredReviewerState: value.requiredReviewerState,
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
  const blockingReviewerVerdicts = pullRequests.filter(
    (pullRequest) => pullRequest.reviewerVerdict === "blocking-issues-found",
  );
  if (pullRequests.length === 0) {
    return "No pull request was observed in canonical local artifacts.";
  }
  if (blockingReviewerVerdicts.length > 0) {
    const blockingSummary = `Observed reviewer-app blocking verdicts on ${blockingReviewerVerdicts.length.toString()} pull request(s) in canonical local artifacts.`;
    if (reviewFeedbackRounds === 0) {
      return blockingSummary;
    }
    return `${blockingSummary} Recorded ${reviewFeedbackRounds.toString()} review-feedback round(s) across ${pullRequests.length.toString()} pull request(s).`;
  }
  if (reviewFeedbackRounds === 0) {
    return "A pull request was observed with no recorded actionable review-feedback rounds in canonical local artifacts.";
  }
  return `Observed ${reviewFeedbackRounds.toString()} recorded review-feedback round(s) across ${pullRequests.length.toString()} pull request(s).`;
}

function buildTokenUsageSession(
  loaded: LoadedIssueArtifacts,
  session: IssueArtifactSessionSnapshot,
): IssueReportTokenUsageSession {
  const accounting =
    session.accounting ??
    createRunnerAccountingSnapshot({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });

  return {
    sessionId: session.sessionId,
    attemptNumber: session.attemptNumber,
    provider: session.provider,
    model: session.model,
    status: accounting.status,
    inputTokens: accounting.inputTokens,
    cachedInputTokens: null,
    outputTokens: accounting.outputTokens,
    reasoningOutputTokens: null,
    totalTokens: accounting.totalTokens,
    costUsd: accounting.costUsd,
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
  };
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
    headSha: typeof value["headSha"] === "string" ? value["headSha"] : null,
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
  const reviewerVerdict =
    value["reviewerVerdict"] === "no-blocking-verdict" ||
    value["reviewerVerdict"] === "blocking-issues-found"
      ? value["reviewerVerdict"]
      : undefined;
  const blockingReviewerKeys = asStringArray(value["blockingReviewerKeys"]);
  const requiredReviewerState =
    value["requiredReviewerState"] === "not-required" ||
    value["requiredReviewerState"] === "running" ||
    value["requiredReviewerState"] === "missing" ||
    value["requiredReviewerState"] === "unknown" ||
    value["requiredReviewerState"] === "satisfied"
      ? value["requiredReviewerState"]
      : undefined;
  return {
    actionableCount: value["actionableCount"],
    unresolvedThreadCount: value["unresolvedThreadCount"],
    reviewerVerdict,
    blockingReviewerKeys: blockingReviewerKeys ?? undefined,
    requiredReviewerState,
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

function readLifecycleKindFromDetails(
  details: Readonly<Record<string, unknown>>,
): IssueArtifactOutcome | null {
  // Keep this key in sync with `#createLifecycleEventDetails` in
  // `src/orchestrator/service.ts`, which records the tracker lifecycle kind for
  // lifecycle-derived events such as `pr-opened` and `review-feedback`.
  const lifecycleKind = details["lifecycleKind"];
  return lifecycleKind === "merged" ||
    lifecycleKind === "awaiting-human-review" ||
    lifecycleKind === "awaiting-system-checks" ||
    lifecycleKind === "degraded-review-infrastructure" ||
    lifecycleKind === "rework-required" ||
    lifecycleKind === "awaiting-landing-command" ||
    lifecycleKind === "awaiting-landing"
    ? lifecycleKind
    : null;
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

  const landingCommand = details["landingCommand"];
  if (landingCommand !== null && typeof landingCommand === "object") {
    const value = landingCommand as Record<string, unknown>;
    const authorLogin =
      typeof value["authorLogin"] === "string" ? value["authorLogin"] : null;
    const url = typeof value["url"] === "string" ? value["url"] : null;
    const commentId =
      typeof value["commentId"] === "string" ? value["commentId"] : null;
    const observedAt =
      typeof value["observedAt"] === "string" ? value["observedAt"] : null;
    if (url !== null) {
      rendered.push(
        `Landing command: ${authorLogin === null ? "unknown author" : authorLogin} at ${url}`,
      );
    }
    if (commentId !== null) {
      rendered.push(`Landing command comment id: ${commentId}`);
    }
    if (observedAt !== null) {
      rendered.push(`Landing command observed at: ${observedAt}`);
    }
  }

  const review = readReviewFromDetails(details);
  if (review !== null) {
    rendered.push(
      `Review: ${review.actionableCount.toString()} actionable, ${review.unresolvedThreadCount.toString()} unresolved thread(s)`,
    );
    if (review.reviewerVerdict !== undefined) {
      rendered.push(
        `Reviewer apps: ${renderReviewerVerdict(review.reviewerVerdict, review.blockingReviewerKeys ?? [])}`,
      );
    }
    if (review.requiredReviewerState !== undefined) {
      rendered.push(`Required reviewer state: ${review.requiredReviewerState}`);
    }
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

  const publicationId = details["publicationId"];
  if (typeof publicationId === "string" && publicationId.length > 0) {
    rendered.push(`Publication id: ${publicationId}`);
  }

  const publicationRoot = details["publicationRoot"];
  if (typeof publicationRoot === "string" && publicationRoot.length > 0) {
    rendered.push(`Publication root: ${publicationRoot}`);
  }

  const archiveRoot = details["archiveRoot"];
  if (typeof archiveRoot === "string" && archiveRoot.length > 0) {
    rendered.push(`Archive root: ${archiveRoot}`);
  }

  const reviewStatus = details["reviewStatus"];
  if (typeof reviewStatus === "string" && reviewStatus.length > 0) {
    rendered.push(`Review status: ${reviewStatus}`);
  }

  const blockedStage = details["blockedStage"];
  if (typeof blockedStage === "string" && blockedStage.length > 0) {
    rendered.push(`Blocked stage: ${blockedStage}`);
  }

  const followUpIssueNumber = details["followUpIssueNumber"];
  const followUpIssueUrl = details["followUpIssueUrl"];
  if (
    typeof followUpIssueNumber === "number" &&
    typeof followUpIssueUrl === "string"
  ) {
    rendered.push(
      `Follow-up issue #${followUpIssueNumber.toString()}: ${followUpIssueUrl}`,
    );
  }

  const followUpIssueTitle = details["followUpIssueTitle"];
  if (typeof followUpIssueTitle === "string" && followUpIssueTitle.length > 0) {
    rendered.push(`Follow-up issue title: ${followUpIssueTitle}`);
  }

  const followUpIssueCreatedAt = details["followUpIssueCreatedAt"];
  if (
    typeof followUpIssueCreatedAt === "string" &&
    followUpIssueCreatedAt.length > 0
  ) {
    rendered.push(`Follow-up issue created at: ${followUpIssueCreatedAt}`);
  }

  const note = details["note"];
  if (typeof note === "string" && note.length > 0) {
    rendered.push(`Note: ${note}`);
  }

  return rendered;
}

function renderReviewerVerdict(
  reviewerVerdict: PullRequestReviewerVerdict,
  blockingReviewerKeys: readonly string[],
): string {
  if (reviewerVerdict === "blocking-issues-found") {
    return blockingReviewerKeys.length === 0
      ? "blocking issues found"
      : `blocking issues found (${blockingReviewerKeys.join(", ")})`;
  }
  return "no blocking verdict";
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
    case "shutdown-requested":
      return 5;
    case "shutdown-terminated":
      return 6;
    case "pr-opened":
      return 7;
    case "review-feedback":
      return 8;
    case "landing-command-observed":
      return 9;
    case "landing-blocked":
      return 10;
    case "landing-failed":
      return 11;
    case "landing-requested":
      return 12;
    case "retry-scheduled":
      return 13;
    case "succeeded":
    case "failed":
    case "terminal-outcome":
      return 14;
    case "report-published":
    case "report-review-recorded":
    case "report-follow-up-filed":
      return 15;
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
    switch (event.kind) {
      case "succeeded":
        return "succeeded";
      case "failed":
        return "failed";
      case "retry-scheduled":
        return "retry-scheduled";
      case "shutdown-terminated": {
        const forced = event.details["forced"] === true;
        return forced ? "shutdown-forced" : "shutdown-terminated";
      }
      case "shutdown-requested":
        return "running";
      case "review-feedback":
        return readLifecycleKindFromDetails(event.details) ?? "rework-required";
      case "pr-opened":
        return (
          readLifecycleKindFromDetails(event.details) ??
          "awaiting-system-checks"
        );
      case "landing-blocked":
        return (
          readLifecycleKindFromDetails(event.details) ?? "awaiting-landing"
        );
      case "landing-failed":
        return "attempt-failed";
      case "landing-requested":
        return "awaiting-landing";
      case "landing-command-observed":
        return "awaiting-landing";
      case "report-published":
      case "report-review-recorded":
      case "report-follow-up-filed":
        continue;
      case "runner-spawned":
        return "running";
      case "approved":
      case "waived":
        return "claimed";
      case "plan-ready":
        return "awaiting-plan-review";
      case "claimed":
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

async function readOptionalIssueArtifactSummary(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<IssueArtifactSummary | null> {
  return await readIssueArtifactSummary(instance, issueNumber).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    },
  );
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
