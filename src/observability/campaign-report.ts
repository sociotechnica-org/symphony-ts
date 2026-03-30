import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import {
  coerceRuntimeInstancePaths,
  type RuntimeInstanceInput,
} from "../domain/workflow.js";
import { writeTextFileAtomic } from "./atomic-file.js";
import type {
  IssueReportAvailability,
  IssueReportDocument,
  IssueReportTokenUsageStatus,
  StoredIssueReportDocument,
} from "./issue-report.js";
import {
  deriveIssueReportsRoot,
  readIssueReportDocument,
} from "./issue-report.js";
import {
  renderCampaignGitHubActivityMarkdown,
  renderCampaignLearningsMarkdown,
  renderCampaignSummaryMarkdown,
  renderCampaignTimelineMarkdown,
  renderCampaignTokenUsageMarkdown,
} from "./campaign-report-markdown.js";
import {
  renderCampaignIssueLabel,
  renderCampaignNameList,
} from "./campaign-report-format.js";

export type CampaignSelection =
  | {
      readonly kind: "issues";
      readonly issueNumbers: readonly number[];
    }
  | {
      readonly kind: "date-window";
      readonly from: string;
      readonly to: string;
    };

export type CampaignIssueOutcome =
  | "succeeded"
  | "failed"
  | "partial"
  | "unknown";

export interface CampaignReportPaths {
  readonly campaignRoot: string;
  readonly summaryFile: string;
  readonly timelineFile: string;
  readonly githubActivityFile: string;
  readonly tokenUsageFile: string;
  readonly learningsFile: string;
}

export interface CampaignSummaryIssue {
  readonly issueNumber: number;
  readonly title: string | null;
  readonly classifiedOutcome: CampaignIssueOutcome;
  readonly reportStatus: IssueReportAvailability;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly attemptCount: number;
  readonly pullRequestCount: number;
  readonly overallConclusion: string;
  readonly reportJsonFile: string;
}

export interface CampaignSummarySection {
  readonly issueCount: number;
  readonly outcomeCounts: Readonly<Record<CampaignIssueOutcome, number>>;
  readonly attemptCount: number;
  readonly pullRequestCount: number;
  readonly overallOutcome: string;
  readonly notableConclusions: readonly string[];
  readonly issues: readonly CampaignSummaryIssue[];
}

export interface CampaignTimelineEntry {
  readonly at: string | null;
  readonly issueNumber: number;
  readonly issueTitle: string | null;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly attemptNumber: number | null;
  readonly sessionId: string | null;
  readonly details: readonly string[];
  readonly sourceReport: string;
}

export interface CampaignCheckPattern {
  readonly name: string;
  readonly count: number;
}

export interface CampaignPullRequestActivity {
  readonly issueNumber: number;
  readonly issueTitle: string | null;
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

export interface CampaignGitHubActivity {
  readonly status: IssueReportAvailability;
  readonly summary: string;
  readonly pullRequests: readonly CampaignPullRequestActivity[];
  readonly reviewFeedbackRounds: number;
  readonly actionableReviewCount: number | null;
  readonly unresolvedThreadCount: number | null;
  readonly pendingChecks: readonly CampaignCheckPattern[];
  readonly failingChecks: readonly CampaignCheckPattern[];
  readonly mergeAvailabilityNote: string;
  readonly closeAvailabilityNote: string;
  readonly notes: readonly string[];
}

export interface CampaignTokenUsageIssue {
  readonly issueNumber: number;
  readonly title: string | null;
  readonly status: IssueReportTokenUsageStatus;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly observedTokenSubtotal: number | null;
  readonly observedCostSubtotal: number | null;
  readonly sessionCount: number;
  readonly notes: readonly string[];
}

export interface CampaignTokenUsage {
  readonly status: IssueReportTokenUsageStatus;
  readonly explanation: string;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly observedTokenSubtotal: number | null;
  readonly observedCostSubtotal: number | null;
  readonly issueCounts: Readonly<Record<IssueReportTokenUsageStatus, number>>;
  readonly issues: readonly CampaignTokenUsageIssue[];
  readonly notes: readonly string[];
}

export interface CampaignLearningCluster {
  readonly title: string;
  readonly summary: string;
  readonly issueNumbers: readonly number[];
  readonly evidence: readonly string[];
}

export interface CampaignLearnings {
  readonly crossIssueConclusions: readonly CampaignLearningCluster[];
  readonly recurringFailureModes: readonly CampaignLearningCluster[];
  readonly changesToMake: readonly string[];
  readonly gaps: readonly string[];
}

export interface CampaignDigest {
  readonly generatedAt: string;
  readonly campaignId: string;
  readonly selection: CampaignSelection;
  readonly reports: readonly StoredIssueReportDocument[];
  readonly summary: CampaignSummarySection;
  readonly timeline: readonly CampaignTimelineEntry[];
  readonly githubActivity: CampaignGitHubActivity;
  readonly tokenUsage: CampaignTokenUsage;
  readonly learnings: CampaignLearnings;
}

export interface CampaignMarkdownFiles {
  readonly summary: string;
  readonly timeline: string;
  readonly githubActivity: string;
  readonly tokenUsage: string;
  readonly learnings: string;
}

export interface GeneratedCampaignDigest {
  readonly digest: CampaignDigest;
  readonly markdown: CampaignMarkdownFiles;
  readonly outputPaths: CampaignReportPaths;
}

export function deriveCampaignReportsRoot(
  instance: RuntimeInstanceInput,
): string {
  return coerceRuntimeInstancePaths(instance).campaignReportsRoot;
}

export function deriveCampaignId(selection: CampaignSelection): string {
  if (selection.kind === "issues") {
    return `issues-${normalizeIssueNumbers(selection.issueNumbers).join("-")}`;
  }
  return `window-${selection.from}-to-${selection.to}`;
}

export function deriveCampaignReportPaths(
  instance: RuntimeInstanceInput,
  campaignId: string,
): CampaignReportPaths {
  const campaignRoot = path.join(
    deriveCampaignReportsRoot(instance),
    campaignId,
  );
  return {
    campaignRoot,
    summaryFile: path.join(campaignRoot, "summary.md"),
    timelineFile: path.join(campaignRoot, "timeline.md"),
    githubActivityFile: path.join(campaignRoot, "github-activity.md"),
    tokenUsageFile: path.join(campaignRoot, "token-usage.md"),
    learningsFile: path.join(campaignRoot, "learnings.md"),
  };
}

export async function generateCampaignDigest(
  instance: RuntimeInstanceInput,
  selection: CampaignSelection,
  options?: {
    readonly generatedAt?: string | undefined;
  },
): Promise<GeneratedCampaignDigest> {
  const normalizedSelection = normalizeCampaignSelection(selection);
  const reports = await loadCampaignIssueReports(instance, normalizedSelection);
  const digest = buildCampaignDigest(
    normalizedSelection,
    reports,
    options?.generatedAt ?? new Date().toISOString(),
  );
  const outputPaths = deriveCampaignReportPaths(instance, digest.campaignId);
  const markdown = {
    summary: renderCampaignSummaryMarkdown(digest),
    timeline: renderCampaignTimelineMarkdown(digest),
    githubActivity: renderCampaignGitHubActivityMarkdown(digest),
    tokenUsage: renderCampaignTokenUsageMarkdown(digest),
    learnings: renderCampaignLearningsMarkdown(digest),
  };

  return {
    digest,
    markdown,
    outputPaths,
  };
}

export async function writeCampaignDigest(
  instance: RuntimeInstanceInput,
  selection: CampaignSelection,
  options?: {
    readonly generatedAt?: string | undefined;
  },
): Promise<GeneratedCampaignDigest> {
  const generated = await generateCampaignDigest(instance, selection, options);
  await Promise.all([
    writeTextFileAtomic(
      generated.outputPaths.summaryFile,
      generated.markdown.summary,
      {
        tempPrefix: ".campaign-report",
      },
    ),
    writeTextFileAtomic(
      generated.outputPaths.timelineFile,
      generated.markdown.timeline,
      {
        tempPrefix: ".campaign-report",
      },
    ),
    writeTextFileAtomic(
      generated.outputPaths.githubActivityFile,
      generated.markdown.githubActivity,
      {
        tempPrefix: ".campaign-report",
      },
    ),
    writeTextFileAtomic(
      generated.outputPaths.tokenUsageFile,
      generated.markdown.tokenUsage,
      {
        tempPrefix: ".campaign-report",
      },
    ),
    writeTextFileAtomic(
      generated.outputPaths.learningsFile,
      generated.markdown.learnings,
      {
        tempPrefix: ".campaign-report",
      },
    ),
  ]);
  return generated;
}

export async function loadCampaignIssueReports(
  instance: RuntimeInstanceInput,
  selection: CampaignSelection,
): Promise<readonly StoredIssueReportDocument[]> {
  if (selection.kind === "issues") {
    const issueNumbers = normalizeIssueNumbers(selection.issueNumbers);
    return Promise.all(
      issueNumbers.map((issueNumber) =>
        readIssueReportDocument(instance, issueNumber),
      ),
    );
  }

  const issueNumbers = await listStoredIssueReportNumbers(instance);
  if (issueNumbers.length === 0) {
    throw new ObservabilityError(
      `No generated issue reports were found under ${deriveIssueReportsRoot(instance)}; run 'symphony-report issue --issue <number>' first.`,
    );
  }

  const reports = await Promise.all(
    issueNumbers.map((issueNumber) =>
      readIssueReportDocument(instance, issueNumber),
    ),
  );
  const selectedReports = reports.filter((report) =>
    matchesCampaignDateWindow(report.report, selection),
  );

  if (selectedReports.length === 0) {
    throw new ObservabilityError(
      `No generated issue reports overlapped ${selection.from} to ${selection.to} under ${deriveIssueReportsRoot(instance)}; generate or regenerate the relevant issue reports first.`,
    );
  }

  return selectedReports.sort(compareStoredReportsByIssueNumber);
}

export function buildCampaignDigest(
  selection: CampaignSelection,
  reports: readonly StoredIssueReportDocument[],
  generatedAt: string,
): CampaignDigest {
  const normalizedSelection = normalizeCampaignSelection(selection);
  const orderedReports = [...reports].sort(compareStoredReportsByIssueNumber);
  const summary = buildCampaignSummary(orderedReports);
  const timeline = buildCampaignTimeline(orderedReports);
  const githubActivity = buildCampaignGitHubActivity(orderedReports);
  const tokenUsage = buildCampaignTokenUsage(orderedReports);
  const learnings = buildCampaignLearnings(
    orderedReports,
    summary,
    githubActivity,
    tokenUsage,
  );

  return {
    generatedAt,
    campaignId: deriveCampaignId(normalizedSelection),
    selection: normalizedSelection,
    reports: orderedReports,
    summary,
    timeline,
    githubActivity,
    tokenUsage,
    learnings,
  };
}

export function matchesCampaignDateWindow(
  report: IssueReportDocument,
  selection: Extract<CampaignSelection, { kind: "date-window" }>,
): boolean {
  const reportWindow = deriveReportWindow(report);
  const requestedStart = parseDateWindowBoundary(selection.from, "start");
  const requestedEnd = parseDateWindowBoundary(selection.to, "end");
  return (
    reportWindow.start <= requestedEnd && reportWindow.end >= requestedStart
  );
}

function buildCampaignSummary(
  reports: readonly StoredIssueReportDocument[],
): CampaignSummarySection {
  const outcomeCounts: Record<CampaignIssueOutcome, number> = {
    succeeded: 0,
    failed: 0,
    partial: 0,
    unknown: 0,
  };

  const issues = reports.map((storedReport) => {
    const classifiedOutcome = classifyCampaignIssueOutcome(storedReport.report);
    outcomeCounts[classifiedOutcome] += 1;
    return {
      issueNumber: storedReport.report.summary.issueNumber,
      title: storedReport.report.summary.title,
      classifiedOutcome,
      reportStatus: storedReport.report.summary.status,
      startedAt: storedReport.report.summary.startedAt,
      endedAt: storedReport.report.summary.endedAt,
      attemptCount: storedReport.report.summary.attemptCount,
      pullRequestCount: storedReport.report.summary.pullRequestCount,
      overallConclusion: storedReport.report.summary.overallConclusion,
      reportJsonFile: storedReport.outputPaths.reportJsonFile,
    };
  });

  const attemptCount = issues.reduce(
    (sum, issue) => sum + issue.attemptCount,
    0,
  );
  const pullRequestCount = issues.reduce(
    (sum, issue) => sum + issue.pullRequestCount,
    0,
  );
  const notableConclusions = buildNotableConclusions(reports, outcomeCounts);

  return {
    issueCount: issues.length,
    outcomeCounts,
    attemptCount,
    pullRequestCount,
    overallOutcome: buildOverallCampaignOutcome(issues.length, outcomeCounts),
    notableConclusions,
    issues,
  };
}

function buildCampaignTimeline(
  reports: readonly StoredIssueReportDocument[],
): readonly CampaignTimelineEntry[] {
  const entries = reports.flatMap((storedReport) => {
    const issueNumber = storedReport.report.summary.issueNumber;
    const issueTitle = storedReport.report.summary.title;
    return storedReport.report.timeline.map((entry) => ({
      at: entry.at,
      issueNumber,
      issueTitle,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      attemptNumber: entry.attemptNumber,
      sessionId: entry.sessionId,
      details: entry.details,
      sourceReport: storedReport.outputPaths.reportJsonFile,
    }));
  });

  return entries.sort(compareCampaignTimelineEntries);
}

function buildCampaignGitHubActivity(
  reports: readonly StoredIssueReportDocument[],
): CampaignGitHubActivity {
  const pullRequests = reports.flatMap((storedReport) =>
    storedReport.report.githubActivity.pullRequests.map((pullRequest) => ({
      issueNumber: storedReport.report.summary.issueNumber,
      issueTitle: storedReport.report.summary.title,
      number: pullRequest.number,
      url: pullRequest.url,
      attemptNumbers: pullRequest.attemptNumbers,
      firstObservedAt: pullRequest.firstObservedAt,
      latestCommitAt: pullRequest.latestCommitAt,
      reviewFeedbackRounds: pullRequest.reviewFeedbackRounds,
      actionableReviewCount: pullRequest.actionableReviewCount,
      unresolvedThreadCount: pullRequest.unresolvedThreadCount,
      pendingChecks: pullRequest.pendingChecks,
      failingChecks: pullRequest.failingChecks,
    })),
  );

  const reviewFeedbackRounds = reports.reduce(
    (sum, storedReport) =>
      sum + storedReport.report.githubActivity.reviewFeedbackRounds,
    0,
  );
  const actionableReviewValues = pullRequests
    .map((pullRequest) => pullRequest.actionableReviewCount)
    .filter((value): value is number => value !== null);
  const unresolvedThreadValues = pullRequests
    .map((pullRequest) => pullRequest.unresolvedThreadCount)
    .filter((value): value is number => value !== null);
  const actionableReviewCount =
    pullRequests.length === 0 ||
    actionableReviewValues.length !== pullRequests.length
      ? null
      : actionableReviewValues.reduce((sum, value) => sum + value, 0);
  const unresolvedThreadCount =
    pullRequests.length === 0 ||
    unresolvedThreadValues.length !== pullRequests.length
      ? null
      : unresolvedThreadValues.reduce((sum, value) => sum + value, 0);
  const pendingChecks = countNamedPatterns(
    pullRequests.flatMap((pullRequest) => pullRequest.pendingChecks),
  );
  const failingChecks = countNamedPatterns(
    pullRequests.flatMap((pullRequest) => pullRequest.failingChecks),
  );
  const unavailableReportCount = reports.filter(
    (storedReport) =>
      storedReport.report.githubActivity.status === "unavailable",
  ).length;
  const partialReportCount = reports.filter(
    (storedReport) => storedReport.report.githubActivity.status !== "complete",
  ).length;
  const notes = dedupeStrings([
    partialReportCount === 0
      ? ""
      : `${partialReportCount.toString()} selected issue reports contained partial GitHub activity facts.`,
    pullRequests.length === 0
      ? "No pull requests were observed in the selected issue reports."
      : "",
    pendingChecks.length === 0
      ? ""
      : `Pending checks were observed for ${pullRequests.filter((pullRequest) => pullRequest.pendingChecks.length > 0).length.toString()} pull requests.`,
    failingChecks.length === 0
      ? ""
      : `Failing checks were observed for ${pullRequests.filter((pullRequest) => pullRequest.failingChecks.length > 0).length.toString()} pull requests.`,
  ]);
  const mergeAvailabilityCount = reports.filter(
    (storedReport) => storedReport.report.githubActivity.mergedAt !== null,
  ).length;
  const closeAvailabilityCount = reports.filter(
    (storedReport) => storedReport.report.githubActivity.closedAt !== null,
  ).length;

  return {
    status:
      reports.length === 0 || unavailableReportCount === reports.length
        ? "unavailable"
        : partialReportCount === 0
          ? "complete"
          : "partial",
    summary: buildGitHubSummary(
      pullRequests.length,
      reviewFeedbackRounds,
      pendingChecks,
      failingChecks,
    ),
    pullRequests,
    reviewFeedbackRounds,
    actionableReviewCount,
    unresolvedThreadCount,
    pendingChecks,
    failingChecks,
    mergeAvailabilityNote:
      mergeAvailabilityCount === reports.length
        ? "Merge timing was available for all selected issue reports."
        : `Merge timing was unavailable for ${(reports.length - mergeAvailabilityCount).toString()} of ${reports.length.toString()} selected issue reports.`,
    closeAvailabilityNote:
      closeAvailabilityCount === reports.length
        ? "Issue close timing was available for all selected issue reports."
        : `Issue close timing was unavailable for ${(reports.length - closeAvailabilityCount).toString()} of ${reports.length.toString()} selected issue reports.`,
    notes,
  };
}

function buildCampaignTokenUsage(
  reports: readonly StoredIssueReportDocument[],
): CampaignTokenUsage {
  const issueCounts: Record<IssueReportTokenUsageStatus, number> = {
    unavailable: 0,
    partial: 0,
    estimated: 0,
    complete: 0,
  };
  const issues = reports.map((storedReport) => {
    const issueTokenUsage = storedReport.report.tokenUsage;
    issueCounts[issueTokenUsage.status] += 1;
    return {
      issueNumber: storedReport.report.summary.issueNumber,
      title: storedReport.report.summary.title,
      status: issueTokenUsage.status,
      totalTokens: issueTokenUsage.totalTokens,
      costUsd: issueTokenUsage.costUsd,
      observedTokenSubtotal: issueTokenUsage.observedTokenSubtotal,
      observedCostSubtotal: issueTokenUsage.observedCostSubtotal,
      sessionCount: issueTokenUsage.sessions.length,
      notes: issueTokenUsage.notes,
    };
  });

  const status = deriveCampaignTokenStatus(issues.map((issue) => issue.status));
  const totalTokens = issues.every((issue) => issue.totalTokens !== null)
    ? issues.reduce((sum, issue) => sum + (issue.totalTokens ?? 0), 0)
    : null;
  const costUsd = issues.every((issue) => issue.costUsd !== null)
    ? issues.reduce((sum, issue) => sum + (issue.costUsd ?? 0), 0)
    : null;
  const observedTokenIssues = issues.filter(
    (issue) => issue.observedTokenSubtotal !== null,
  );
  const observedCostIssues = issues.filter(
    (issue) => issue.observedCostSubtotal !== null,
  );
  const observedTokenSubtotal =
    observedTokenIssues.length === 0
      ? null
      : observedTokenIssues.reduce(
          (sum, issue) => sum + (issue.observedTokenSubtotal ?? 0),
          0,
        );
  const observedCostSubtotal =
    observedCostIssues.length === 0
      ? null
      : observedCostIssues.reduce(
          (sum, issue) => sum + (issue.observedCostSubtotal ?? 0),
          0,
        );
  const explanation = buildCampaignTokenExplanation(
    issues.length,
    issueCounts,
    status,
  );
  const notes = dedupeStrings([
    observedTokenIssues.length === issues.length
      ? ""
      : `${observedTokenIssues.length.toString()} of ${issues.length.toString()} selected issue reports supplied token totals.`,
    observedCostIssues.length === issues.length
      ? ""
      : `${observedCostIssues.length.toString()} of ${issues.length.toString()} selected issue reports supplied cost totals.`,
  ]);

  return {
    status,
    explanation,
    totalTokens,
    costUsd,
    observedTokenSubtotal,
    observedCostSubtotal,
    issueCounts,
    issues,
    notes,
  };
}

function buildCampaignLearnings(
  reports: readonly StoredIssueReportDocument[],
  summary: CampaignSummarySection,
  githubActivity: CampaignGitHubActivity,
  tokenUsage: CampaignTokenUsage,
): CampaignLearnings {
  const crossIssueConclusions = buildCrossIssueConclusions(
    reports,
    summary,
    githubActivity,
    tokenUsage,
  );
  const recurringFailureModes = buildRecurringFailureModes(
    reports,
    summary,
    githubActivity,
    tokenUsage,
  );
  const changesToMake = dedupeStrings([
    tokenUsage.status === "complete"
      ? ""
      : `Expand token-usage capture or enrichment; campaign token coverage was ${tokenUsage.status} across ${summary.issueCount.toString()} issue reports.`,
    reports.every(
      (storedReport) => storedReport.report.githubActivity.mergedAt === null,
    )
      ? "Record merge timing in canonical local artifacts so campaign digests can distinguish shipped work from PR-open state."
      : "",
    reports.every(
      (storedReport) => storedReport.report.githubActivity.closedAt === null,
    )
      ? "Record exact issue-close timing in canonical local artifacts so campaign windows can compare tracker closure against report completion."
      : "",
    summary.outcomeCounts.partial > 0
      ? `Preserve fuller canonical event ledgers for partial issues; ${summary.outcomeCounts.partial.toString()} selected reports remained partial or in-flight.`
      : "",
    githubActivity.failingChecks.length > 0
      ? `Stabilize recurring failing checks: ${renderPatternSummary(githubActivity.failingChecks)}.`
      : "",
  ]);
  const repeatedObservationCount = collectObservationClusters(reports).filter(
    (cluster) => cluster.issueNumbers.length > 1,
  ).length;
  const gaps = dedupeStrings([
    repeatedObservationCount === 0
      ? "No repeated issue-level learning titles appeared across the selected reports."
      : "",
    reports.some(
      (storedReport) => storedReport.report.summary.status !== "complete",
    )
      ? "Some selected reports were partial, so the campaign digest may undercount lifecycle events."
      : "",
    tokenUsage.status === "unavailable"
      ? "No selected report supplied campaign-usable token totals."
      : "",
  ]);

  return {
    crossIssueConclusions,
    recurringFailureModes,
    changesToMake,
    gaps,
  };
}

function buildCrossIssueConclusions(
  reports: readonly StoredIssueReportDocument[],
  summary: CampaignSummarySection,
  githubActivity: CampaignGitHubActivity,
  tokenUsage: CampaignTokenUsage,
): readonly CampaignLearningCluster[] {
  const observationClusters = collectObservationClusters(reports).filter(
    (cluster) => cluster.issueNumbers.length > 1,
  );
  const derivedClusters: CampaignLearningCluster[] = [
    {
      title: "Campaign delivery outcomes",
      summary: summary.overallOutcome,
      issueNumbers: summary.issues.map((issue) => issue.issueNumber),
      evidence: summary.issues.map(
        (issue) =>
          `${renderIssueLabel(issue.issueNumber, issue.title)}: ${issue.overallConclusion}`,
      ),
    },
  ];

  if (
    githubActivity.reviewFeedbackRounds > 0 ||
    githubActivity.pullRequests.length > 0
  ) {
    derivedClusters.push({
      title: "GitHub activity patterns",
      summary: githubActivity.summary,
      issueNumbers: dedupeNumbers(
        githubActivity.pullRequests.map(
          (pullRequest) => pullRequest.issueNumber,
        ),
      ),
      evidence: githubActivity.pullRequests.map(
        (pullRequest) =>
          `${renderIssueLabel(pullRequest.issueNumber, pullRequest.issueTitle)}: PR #${pullRequest.number.toString()} recorded ${pullRequest.reviewFeedbackRounds.toString()} review rounds, pending checks ${renderNameList(pullRequest.pendingChecks)}, failing checks ${renderNameList(pullRequest.failingChecks)}.`,
      ),
    });
  }

  if (tokenUsage.status !== "complete") {
    derivedClusters.push({
      title: "Token coverage limits",
      summary: tokenUsage.explanation,
      issueNumbers: tokenUsage.issues.map((issue) => issue.issueNumber),
      evidence: tokenUsage.issues.map(
        (issue) =>
          `${renderIssueLabel(issue.issueNumber, issue.title)}: token status ${issue.status}.`,
      ),
    });
  }

  return [...observationClusters, ...derivedClusters].map(
    normalizeLearningCluster,
  );
}

function buildRecurringFailureModes(
  reports: readonly StoredIssueReportDocument[],
  summary: CampaignSummarySection,
  githubActivity: CampaignGitHubActivity,
  tokenUsage: CampaignTokenUsage,
): readonly CampaignLearningCluster[] {
  const clusters: CampaignLearningCluster[] = [];
  const failedIssues = summary.issues.filter(
    (issue) => issue.classifiedOutcome === "failed",
  );
  if (failedIssues.length > 0) {
    clusters.push({
      title: "Failed issues",
      summary: `${failedIssues.length.toString()} selected issues ended in a failed terminal outcome.`,
      issueNumbers: failedIssues.map((issue) => issue.issueNumber),
      evidence: failedIssues.map(
        (issue) =>
          `${renderIssueLabel(issue.issueNumber, issue.title)}: ${issue.overallConclusion}`,
      ),
    });
  }

  const partialIssues = summary.issues.filter(
    (issue) => issue.classifiedOutcome === "partial",
  );
  if (partialIssues.length > 0) {
    clusters.push({
      title: "Partial or unresolved issues",
      summary: `${partialIssues.length.toString()} selected issues remained partial or non-terminal in their stored issue reports.`,
      issueNumbers: partialIssues.map((issue) => issue.issueNumber),
      evidence: partialIssues.map(
        (issue) =>
          `${renderIssueLabel(issue.issueNumber, issue.title)}: ${issue.overallConclusion}`,
      ),
    });
  }

  if (githubActivity.failingChecks.length > 0) {
    clusters.push({
      title: "Failing check patterns",
      summary: `Recurring failing checks were recorded: ${renderPatternSummary(githubActivity.failingChecks)}.`,
      issueNumbers: dedupeNumbers(
        githubActivity.pullRequests
          .filter((pullRequest) => pullRequest.failingChecks.length > 0)
          .map((pullRequest) => pullRequest.issueNumber),
      ),
      evidence: githubActivity.pullRequests
        .filter((pullRequest) => pullRequest.failingChecks.length > 0)
        .map(
          (pullRequest) =>
            `${renderIssueLabel(pullRequest.issueNumber, pullRequest.issueTitle)}: PR #${pullRequest.number.toString()} failed ${renderNameList(pullRequest.failingChecks)}.`,
        ),
    });
  }

  if (
    tokenUsage.issueCounts.unavailable > 0 ||
    tokenUsage.issueCounts.partial > 0
  ) {
    clusters.push({
      title: "Token-usage blind spots",
      summary: `${(tokenUsage.issueCounts.unavailable + tokenUsage.issueCounts.partial).toString()} selected issue reports did not provide complete token accounting.`,
      issueNumbers: tokenUsage.issues
        .filter(
          (issue) =>
            issue.status === "unavailable" || issue.status === "partial",
        )
        .map((issue) => issue.issueNumber),
      evidence: tokenUsage.issues
        .filter(
          (issue) =>
            issue.status === "unavailable" || issue.status === "partial",
        )
        .map(
          (issue) =>
            `${renderIssueLabel(issue.issueNumber, issue.title)}: token status ${issue.status}.`,
        ),
    });
  }

  return clusters.map(normalizeLearningCluster);
}

function collectObservationClusters(
  reports: readonly StoredIssueReportDocument[],
): readonly CampaignLearningCluster[] {
  const clusters = new Map<
    string,
    {
      title: string;
      summary: string;
      issueNumbers: Set<number>;
      evidence: string[];
    }
  >();

  for (const storedReport of reports) {
    for (const observation of storedReport.report.learnings.observations) {
      const key = observation.title.trim().toLowerCase();
      const existing = clusters.get(key) ?? {
        title: observation.title,
        summary: observation.summary,
        issueNumbers: new Set<number>(),
        evidence: [],
      };
      existing.issueNumbers.add(storedReport.report.summary.issueNumber);
      existing.evidence.push(
        `${renderIssueLabel(storedReport.report.summary.issueNumber, storedReport.report.summary.title)}: ${observation.evidence.join(" ") || observation.summary}`,
      );
      clusters.set(key, existing);
    }
  }

  return [...clusters.values()].map((cluster) => ({
    title: cluster.title,
    summary: cluster.summary,
    issueNumbers: [...cluster.issueNumbers].sort(compareNumbersAscending),
    evidence: dedupeStrings(cluster.evidence),
  }));
}

function buildNotableConclusions(
  reports: readonly StoredIssueReportDocument[],
  outcomeCounts: Readonly<Record<CampaignIssueOutcome, number>>,
): readonly string[] {
  const conclusions = [
    outcomeCounts.failed === 0
      ? ""
      : `${outcomeCounts.failed.toString()} selected issues ended in failure and should be reviewed for retry or follow-up patterns.`,
    outcomeCounts.partial === 0
      ? ""
      : `${outcomeCounts.partial.toString()} selected issues remained partial or non-terminal in their stored reports.`,
    `${reports.filter((storedReport) => storedReport.report.operatorInterventions.entries.length > 0).length.toString()} selected issues recorded explicit operator plan-review interventions.`,
    `${reports.reduce((sum, storedReport) => sum + storedReport.report.githubActivity.reviewFeedbackRounds, 0).toString()} review-feedback rounds were recorded across the selected issue reports.`,
    `${reports.filter((storedReport) => storedReport.report.tokenUsage.status === "complete").length.toString()} of ${reports.length.toString()} selected issue reports provided complete token totals.`,
  ];

  return dedupeStrings(conclusions);
}

function buildOverallCampaignOutcome(
  issueCount: number,
  outcomeCounts: Readonly<Record<CampaignIssueOutcome, number>>,
): string {
  if (issueCount === 0) {
    return "No issue reports were selected.";
  }
  if (outcomeCounts.succeeded === issueCount) {
    return `All ${issueCount.toString()} selected issues completed successfully.`;
  }

  const lead = `Completed ${outcomeCounts.succeeded.toString()} of ${issueCount.toString()} selected issues.`;
  const qualifiers: string[] = [];
  if (outcomeCounts.failed > 0) {
    qualifiers.push(`${outcomeCounts.failed.toString()} failed`);
  }
  if (outcomeCounts.partial > 0) {
    qualifiers.push(`${outcomeCounts.partial.toString()} remained partial`);
  }
  if (outcomeCounts.unknown > 0) {
    qualifiers.push(`${outcomeCounts.unknown.toString()} remained unknown`);
  }
  return qualifiers.length === 0 ? lead : `${lead} ${qualifiers.join(", ")}.`;
}

function buildGitHubSummary(
  pullRequestCount: number,
  reviewFeedbackRounds: number,
  pendingChecks: readonly CampaignCheckPattern[],
  failingChecks: readonly CampaignCheckPattern[],
): string {
  const parts = [
    `${pullRequestCount.toString()} pull requests were observed`,
    `${reviewFeedbackRounds.toString()} review-feedback rounds were recorded`,
  ];
  if (pendingChecks.length > 0) {
    parts.push(
      `pending checks included ${renderPatternSummary(pendingChecks)}`,
    );
  }
  if (failingChecks.length > 0) {
    parts.push(
      `failing checks included ${renderPatternSummary(failingChecks)}`,
    );
  }
  return `${parts.join("; ")}.`;
}

function buildCampaignTokenExplanation(
  issueCount: number,
  issueCounts: Readonly<Record<IssueReportTokenUsageStatus, number>>,
  status: IssueReportTokenUsageStatus,
): string {
  if (status === "complete") {
    return `All ${issueCount.toString()} selected issue reports supplied complete token totals.`;
  }
  if (status === "estimated") {
    return `All ${issueCount.toString()} selected issue reports supplied token totals, but at least one total remained estimated.`;
  }
  if (status === "unavailable") {
    return `None of the ${issueCount.toString()} selected issue reports supplied campaign-usable token totals.`;
  }
  return `${issueCounts.complete.toString()} complete, ${issueCounts.estimated.toString()} estimated, ${issueCounts.partial.toString()} partial, and ${issueCounts.unavailable.toString()} unavailable token-usage reports were selected.`;
}

function normalizeCampaignSelection(
  selection: CampaignSelection,
): CampaignSelection {
  if (selection.kind === "issues") {
    return {
      kind: "issues",
      issueNumbers: normalizeIssueNumbers(selection.issueNumbers),
    };
  }
  return selection;
}

function normalizeIssueNumbers(
  issueNumbers: readonly number[],
): readonly number[] {
  const uniqueNumbers = new Set<number>();
  for (const issueNumber of issueNumbers) {
    uniqueNumbers.add(issueNumber);
  }
  return [...uniqueNumbers].sort(compareNumbersAscending);
}

async function listStoredIssueReportNumbers(
  instance: RuntimeInstanceInput,
): Promise<readonly number[]> {
  const reportsRoot = deriveIssueReportsRoot(instance);
  const entries = await fs
    .readdir(reportsRoot, {
      withFileTypes: true,
    })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [] as Dirent[];
      }
      throw error;
    });

  return entries
    .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/u.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort(compareNumbersAscending);
}

function deriveReportWindow(report: IssueReportDocument): {
  readonly start: number;
  readonly end: number;
} {
  const startedAt = parseTimestamp(report.summary.startedAt);
  const endedAt = parseTimestamp(report.summary.endedAt);
  const generatedAt = parseTimestamp(report.generatedAt);
  const start = startedAt ?? endedAt ?? generatedAt;
  const end = endedAt ?? startedAt ?? generatedAt;

  if (start === null || end === null) {
    throw new ObservabilityError(
      `Issue report #${report.summary.issueNumber.toString()} did not contain a usable reporting window.`,
    );
  }

  return start <= end ? { start, end } : { start: end, end: start };
}

function parseDateWindowBoundary(
  value: string,
  boundary: "start" | "end",
): number {
  const timestamp = Date.parse(
    `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`,
  );
  if (Number.isNaN(timestamp)) {
    throw new ObservabilityError(`Invalid campaign date boundary: ${value}`);
  }
  return timestamp;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function classifyCampaignIssueOutcome(
  report: IssueReportDocument,
): CampaignIssueOutcome {
  if (report.summary.outcome === "succeeded") {
    return "succeeded";
  }
  if (report.summary.outcome === "failed") {
    return "failed";
  }
  if (report.summary.outcome === "unknown") {
    return "unknown";
  }
  return "partial";
}

function deriveCampaignTokenStatus(
  statuses: readonly IssueReportTokenUsageStatus[],
): IssueReportTokenUsageStatus {
  if (statuses.every((status) => status === "complete")) {
    return "complete";
  }
  if (
    statuses.every((status) => status === "complete" || status === "estimated")
  ) {
    return "estimated";
  }
  if (statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }
  return "partial";
}

function countNamedPatterns(
  values: readonly string[],
): readonly CampaignCheckPattern[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) =>
      right.count === left.count
        ? left.name.localeCompare(right.name)
        : right.count - left.count,
    );
}

function compareStoredReportsByIssueNumber(
  left: StoredIssueReportDocument,
  right: StoredIssueReportDocument,
): number {
  return compareNumbersAscending(
    left.report.summary.issueNumber,
    right.report.summary.issueNumber,
  );
}

function compareCampaignTimelineEntries(
  left: CampaignTimelineEntry,
  right: CampaignTimelineEntry,
): number {
  const leftAt =
    left.at === null ? Number.POSITIVE_INFINITY : Date.parse(left.at);
  const rightAt =
    right.at === null ? Number.POSITIVE_INFINITY : Date.parse(right.at);
  if (leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  if (left.issueNumber !== right.issueNumber) {
    return compareNumbersAscending(left.issueNumber, right.issueNumber);
  }
  return left.title.localeCompare(right.title);
}

function normalizeLearningCluster(
  cluster: CampaignLearningCluster,
): CampaignLearningCluster {
  return {
    title: cluster.title,
    summary: cluster.summary,
    issueNumbers: dedupeNumbers(cluster.issueNumbers),
    evidence: dedupeStrings(cluster.evidence),
  };
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function dedupeNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort(compareNumbersAscending);
}

function renderIssueLabel(issueNumber: number, title: string | null): string {
  return renderCampaignIssueLabel(issueNumber, title);
}

function renderPatternSummary(
  patterns: readonly CampaignCheckPattern[],
): string {
  if (patterns.length === 0) {
    return "none";
  }
  return patterns
    .map((pattern) => `${pattern.name} (${pattern.count.toString()})`)
    .join(", ");
}

function renderNameList(values: readonly string[]): string {
  return renderCampaignNameList(values);
}

function compareNumbersAscending(left: number, right: number): number {
  return left - right;
}
