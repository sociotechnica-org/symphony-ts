import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import type { RuntimeInstanceInput } from "../domain/workflow.js";
import { coerceRuntimeInstancePaths } from "../domain/workflow.js";
import type { OperatorInstanceStatePaths } from "../domain/instance-identity.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { writeIssueReport, readIssueReportDocument } from "./issue-report.js";

export const OPERATOR_REPORT_REVIEW_SCHEMA_VERSION = 1 as const;

export type OperatorReportReviewStatus =
  | "report-ready"
  | "reviewed-no-follow-up"
  | "reviewed-follow-up-filed"
  | "review-blocked";

export type OperatorReportReviewBlockedStage =
  | "report-generation"
  | "issue-filing"
  | "publication"
  | "operator-review";

export interface OperatorReportFollowUpIssueReference {
  readonly findingKey: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface OperatorReportDraftFollowUpIssue {
  readonly findingKey: string;
  readonly title: string;
  readonly body: string;
}

export interface OperatorReportReviewRecord {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly issueOutcome: "succeeded" | "failed";
  readonly issueUpdatedAt: string;
  readonly reportGeneratedAt: string;
  readonly reportJsonFile: string;
  readonly reportMarkdownFile: string;
  readonly status: OperatorReportReviewStatus;
  readonly summary: string;
  readonly note: string | null;
  readonly recordedAt: string;
  readonly blockedStage: OperatorReportReviewBlockedStage | null;
  readonly followUpIssues: readonly OperatorReportFollowUpIssueReference[];
  readonly draftFollowUpIssue: OperatorReportDraftFollowUpIssue | null;
}

export interface OperatorReportReviewStateDocument {
  readonly version: typeof OPERATOR_REPORT_REVIEW_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly reviews: readonly OperatorReportReviewRecord[];
}

export interface PendingOperatorReportReview {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly issueOutcome: "succeeded" | "failed";
  readonly issueUpdatedAt: string;
  readonly reportGeneratedAt: string;
  readonly reportJsonFile: string;
  readonly reportMarkdownFile: string;
  readonly status: "report-ready" | "review-blocked";
  readonly summary: string;
  readonly note: string | null;
  readonly blockedStage: OperatorReportReviewBlockedStage | null;
  readonly followUpIssues: readonly OperatorReportFollowUpIssueReference[];
  readonly draftFollowUpIssue: OperatorReportDraftFollowUpIssue | null;
}

interface CompletedIssueSummary {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly currentOutcome: "succeeded" | "failed";
  readonly lastUpdatedAt: string;
}

export interface SyncOperatorReportReviewsResult {
  readonly state: OperatorReportReviewStateDocument;
  readonly pending: readonly PendingOperatorReportReview[];
}

export async function readOperatorReportReviewState(
  filePath: string,
): Promise<OperatorReportReviewStateDocument> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      readonly version?: unknown;
      readonly updatedAt?: unknown;
      readonly reviews?: unknown;
    };
    if (parsed.version !== OPERATOR_REPORT_REVIEW_SCHEMA_VERSION) {
      throw new ObservabilityError(
        `Unsupported operator report review state schema in ${filePath}`,
      );
    }
    if (
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.reviews)
    ) {
      throw new ObservabilityError(
        `Malformed operator report review state in ${filePath}`,
      );
    }
    return parsed as OperatorReportReviewStateDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyOperatorReportReviewState();
    }
    throw error;
  }
}

export async function writeOperatorReportReviewState(
  filePath: string,
  state: OperatorReportReviewStateDocument,
): Promise<void> {
  await writeJsonFileAtomic(filePath, state, {
    tempPrefix: ".operator-report-review",
  });
}

export async function syncOperatorReportReviews(args: {
  readonly instance: RuntimeInstanceInput;
  readonly reviewStateFile: string;
}): Promise<SyncOperatorReportReviewsResult> {
  const instance = coerceRuntimeInstancePaths(args.instance);
  const completedIssues = await listCompletedIssues(instance);
  let state = await readOperatorReportReviewState(args.reviewStateFile);
  const pending: PendingOperatorReportReview[] = [];

  for (const issue of completedIssues) {
    const existing = findCurrentReview(state, issue.issueNumber);
    if (
      existing !== null &&
      existing.issueUpdatedAt === issue.lastUpdatedAt &&
      (existing.status === "reviewed-no-follow-up" ||
        existing.status === "reviewed-follow-up-filed")
    ) {
      continue;
    }

    if (
      existing !== null &&
      existing.status === "review-blocked" &&
      existing.blockedStage !== "report-generation"
    ) {
      pending.push(toPendingReview(existing));
      continue;
    }

    try {
      const report = await ensureCurrentIssueReport(instance, issue);
      const nextRecord = {
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        issueTitle: issue.title,
        issueOutcome: issue.currentOutcome,
        issueUpdatedAt: issue.lastUpdatedAt,
        reportGeneratedAt: report.report.generatedAt,
        reportJsonFile: report.outputPaths.reportJsonFile,
        reportMarkdownFile: path.join(
          report.outputPaths.issueRoot,
          "report.md",
        ),
        status: "report-ready",
        summary: `Issue #${issue.issueNumber.toString()} has a completed run report ready for operator review.`,
        note: null,
        recordedAt: new Date().toISOString(),
        blockedStage: null,
        followUpIssues: existing?.followUpIssues ?? [],
        draftFollowUpIssue: null,
      } satisfies OperatorReportReviewRecord;
      state = upsertReviewRecord(state, nextRecord);
      pending.push(toPendingReview(nextRecord));
    } catch (error) {
      const nextRecord = {
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        issueTitle: issue.title,
        issueOutcome: issue.currentOutcome,
        issueUpdatedAt: issue.lastUpdatedAt,
        reportGeneratedAt: existing?.reportGeneratedAt ?? issue.lastUpdatedAt,
        reportJsonFile:
          existing?.reportJsonFile ??
          path.join(
            instance.issueReportsRoot,
            issue.issueNumber.toString(),
            "report.json",
          ),
        reportMarkdownFile:
          existing?.reportMarkdownFile ??
          path.join(
            instance.issueReportsRoot,
            issue.issueNumber.toString(),
            "report.md",
          ),
        status: "review-blocked",
        summary: `Issue #${issue.issueNumber.toString()} could not prepare a current report for review.`,
        note: error instanceof Error ? error.message : String(error),
        recordedAt: new Date().toISOString(),
        blockedStage: "report-generation",
        followUpIssues: existing?.followUpIssues ?? [],
        draftFollowUpIssue: existing?.draftFollowUpIssue ?? null,
      } satisfies OperatorReportReviewRecord;
      state = upsertReviewRecord(state, nextRecord);
      pending.push(toPendingReview(nextRecord));
    }
  }

  if (
    pending.length > 0 ||
    state.reviews.length > 0 ||
    (await fileExists(args.reviewStateFile))
  ) {
    await writeOperatorReportReviewState(args.reviewStateFile, state);
  }

  return {
    state,
    pending: pending.sort(comparePendingReviews),
  };
}

export async function recordOperatorReportReviewDecision(args: {
  readonly instance: RuntimeInstanceInput;
  readonly reviewStateFile: string;
  readonly issueNumber: number;
  readonly status: "reviewed-no-follow-up" | "review-blocked";
  readonly summary: string;
  readonly note?: string | null | undefined;
  readonly blockedStage?: OperatorReportReviewBlockedStage | null | undefined;
}): Promise<OperatorReportReviewRecord> {
  const current = await loadCurrentReviewContext({
    instance: args.instance,
    reviewStateFile: args.reviewStateFile,
    issueNumber: args.issueNumber,
  });
  const nextRecord = {
    ...current.record,
    status: args.status,
    summary: args.summary,
    note: args.note ?? null,
    blockedStage:
      args.status === "review-blocked"
        ? (args.blockedStage ?? "operator-review")
        : null,
    draftFollowUpIssue:
      args.status === "review-blocked"
        ? current.record.draftFollowUpIssue
        : null,
    recordedAt: new Date().toISOString(),
  } satisfies OperatorReportReviewRecord;
  const state = upsertReviewRecord(current.state, nextRecord);
  await writeOperatorReportReviewState(args.reviewStateFile, state);
  return nextRecord;
}

export async function recordOperatorReportFollowUpIssue(args: {
  readonly instance: RuntimeInstanceInput;
  readonly reviewStateFile: string;
  readonly issueNumber: number;
  readonly findingKey: string;
  readonly createdIssue: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
  };
  readonly summary: string;
  readonly note?: string | null | undefined;
}): Promise<OperatorReportReviewRecord> {
  const current = await loadCurrentReviewContext({
    instance: args.instance,
    reviewStateFile: args.reviewStateFile,
    issueNumber: args.issueNumber,
  });
  const findingKey = normalizeFindingKey(
    args.findingKey || args.createdIssue.title,
  );
  const existing = current.record.followUpIssues.find(
    (issue) => issue.findingKey === findingKey,
  );
  const followUpIssues = existing
    ? current.record.followUpIssues
    : [
        ...current.record.followUpIssues,
        {
          findingKey,
          number: args.createdIssue.number,
          url: args.createdIssue.url,
          title: args.createdIssue.title,
          createdAt: new Date().toISOString(),
        },
      ];
  const nextRecord = {
    ...current.record,
    status: "reviewed-follow-up-filed",
    summary: args.summary,
    note: args.note ?? null,
    blockedStage: null,
    followUpIssues,
    draftFollowUpIssue: null,
    recordedAt: new Date().toISOString(),
  } satisfies OperatorReportReviewRecord;
  const state = upsertReviewRecord(current.state, nextRecord);
  await writeOperatorReportReviewState(args.reviewStateFile, state);
  return nextRecord;
}

export async function blockOperatorReportFollowUpIssue(args: {
  readonly instance: RuntimeInstanceInput;
  readonly reviewStateFile: string;
  readonly issueNumber: number;
  readonly findingKey: string;
  readonly draft: {
    readonly title: string;
    readonly body: string;
  };
  readonly summary: string;
  readonly note: string;
}): Promise<OperatorReportReviewRecord> {
  const current = await loadCurrentReviewContext({
    instance: args.instance,
    reviewStateFile: args.reviewStateFile,
    issueNumber: args.issueNumber,
  });
  const nextRecord = {
    ...current.record,
    status: "review-blocked",
    summary: args.summary,
    note: args.note,
    blockedStage: "issue-filing",
    draftFollowUpIssue: {
      findingKey: normalizeFindingKey(args.findingKey || args.draft.title),
      title: args.draft.title,
      body: args.draft.body,
    },
    recordedAt: new Date().toISOString(),
  } satisfies OperatorReportReviewRecord;
  const state = upsertReviewRecord(current.state, nextRecord);
  await writeOperatorReportReviewState(args.reviewStateFile, state);
  return nextRecord;
}

export function createEmptyOperatorReportReviewState(): OperatorReportReviewStateDocument {
  return {
    version: OPERATOR_REPORT_REVIEW_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    reviews: [],
  };
}

export function deriveOperatorReportReviewStateFile(
  paths: OperatorInstanceStatePaths,
): string {
  return paths.reportReviewStatePath;
}

function upsertReviewRecord(
  state: OperatorReportReviewStateDocument,
  record: OperatorReportReviewRecord,
): OperatorReportReviewStateDocument {
  const reviews = state.reviews.filter(
    (entry) =>
      !(
        entry.issueNumber === record.issueNumber &&
        entry.reportGeneratedAt === record.reportGeneratedAt
      ),
  );
  reviews.push(record);
  reviews.sort(compareReviewRecords);
  return {
    version: OPERATOR_REPORT_REVIEW_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    reviews,
  };
}

function compareReviewRecords(
  left: OperatorReportReviewRecord,
  right: OperatorReportReviewRecord,
): number {
  return comparePendingReviews(toPendingReview(left), toPendingReview(right));
}

function comparePendingReviews(
  left: PendingOperatorReportReview,
  right: PendingOperatorReportReview,
): number {
  if (left.issueUpdatedAt !== right.issueUpdatedAt) {
    return right.issueUpdatedAt.localeCompare(left.issueUpdatedAt);
  }
  if (left.reportGeneratedAt !== right.reportGeneratedAt) {
    return right.reportGeneratedAt.localeCompare(left.reportGeneratedAt);
  }
  return right.issueNumber - left.issueNumber;
}

function toPendingReview(
  record: OperatorReportReviewRecord,
): PendingOperatorReportReview {
  return {
    issueNumber: record.issueNumber,
    issueIdentifier: record.issueIdentifier,
    issueTitle: record.issueTitle,
    issueOutcome: record.issueOutcome,
    issueUpdatedAt: record.issueUpdatedAt,
    reportGeneratedAt: record.reportGeneratedAt,
    reportJsonFile: record.reportJsonFile,
    reportMarkdownFile: record.reportMarkdownFile,
    status:
      record.status === "report-ready" ? "report-ready" : "review-blocked",
    summary: record.summary,
    note: record.note,
    blockedStage: record.blockedStage,
    followUpIssues: record.followUpIssues,
    draftFollowUpIssue: record.draftFollowUpIssue,
  };
}

async function loadCurrentReviewContext(args: {
  readonly instance: RuntimeInstanceInput;
  readonly reviewStateFile: string;
  readonly issueNumber: number;
}): Promise<{
  readonly state: OperatorReportReviewStateDocument;
  readonly record: OperatorReportReviewRecord;
}> {
  const sync = await syncOperatorReportReviews({
    instance: args.instance,
    reviewStateFile: args.reviewStateFile,
  });
  const current = findCurrentReview(sync.state, args.issueNumber);
  if (current === null) {
    throw new ObservabilityError(
      `Issue #${args.issueNumber.toString()} does not have a completed report review subject yet.`,
    );
  }
  return {
    state: sync.state,
    record: current,
  };
}

function findCurrentReview(
  state: OperatorReportReviewStateDocument,
  issueNumber: number,
): OperatorReportReviewRecord | null {
  const matches = state.reviews.filter(
    (entry) => entry.issueNumber === issueNumber,
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.sort(compareReviewRecords)[0] ?? null;
}

async function listCompletedIssues(
  instance: ReturnType<typeof coerceRuntimeInstancePaths>,
): Promise<readonly CompletedIssueSummary[]> {
  const entries = await fs
    .readdir(instance.issueArtifactsRoot, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const completed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        const issueFile = path.join(
          instance.issueArtifactsRoot,
          entry.name,
          "issue.json",
        );
        const parsed = JSON.parse(
          await fs.readFile(issueFile, "utf8"),
        ) as Record<string, unknown>;
        const currentOutcome = parsed["currentOutcome"];
        if (currentOutcome !== "succeeded" && currentOutcome !== "failed") {
          return null;
        }
        const issueNumber = parsed["issueNumber"];
        const issueIdentifier = parsed["issueIdentifier"];
        const title = parsed["title"];
        const lastUpdatedAt = parsed["lastUpdatedAt"];
        if (
          typeof issueNumber !== "number" ||
          typeof issueIdentifier !== "string" ||
          typeof title !== "string" ||
          typeof lastUpdatedAt !== "string"
        ) {
          throw new ObservabilityError(
            `Malformed issue summary at ${issueFile}; expected completed issue fields.`,
          );
        }
        return {
          issueNumber,
          issueIdentifier,
          title,
          currentOutcome,
          lastUpdatedAt,
        } satisfies CompletedIssueSummary;
      }),
  );
  return completed
    .filter((entry): entry is CompletedIssueSummary => entry !== null)
    .sort((left, right) => {
      if (left.lastUpdatedAt !== right.lastUpdatedAt) {
        return right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
      }
      return right.issueNumber - left.issueNumber;
    });
}

async function ensureCurrentIssueReport(
  instance: ReturnType<typeof coerceRuntimeInstancePaths>,
  issue: CompletedIssueSummary,
) {
  const stored = await readIssueReportDocument(
    instance,
    issue.issueNumber,
  ).catch(() => null);
  if (
    stored !== null &&
    !isIssueReportStale(stored.report.generatedAt, issue)
  ) {
    return stored;
  }
  await writeIssueReport(instance, issue.issueNumber);
  return await readIssueReportDocument(instance, issue.issueNumber);
}

function isIssueReportStale(
  reportGeneratedAt: string,
  issue: CompletedIssueSummary,
): boolean {
  const reportTimestamp = Date.parse(reportGeneratedAt);
  const issueTimestamp = Date.parse(issue.lastUpdatedAt);
  return (
    Number.isFinite(reportTimestamp) &&
    Number.isFinite(issueTimestamp) &&
    reportTimestamp < issueTimestamp
  );
}

function normalizeFindingKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "follow-up";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
