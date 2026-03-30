import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import type { RuntimeInstanceInput } from "../domain/workflow.js";
import { coerceRuntimeInstancePaths } from "../domain/workflow.js";
import { publishIssueToFactoryRuns } from "../integration/factory-runs.js";
import { createDefaultIssueReportEnrichers } from "../runner/codex-report-enricher.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  deriveIssueReportPaths,
  readIssueReportDocument,
  writeIssueReport,
} from "./issue-report.js";

export const TERMINAL_ISSUE_REPORTING_SCHEMA_VERSION = 1 as const;

export type TerminalIssueReportingState =
  | "pending-generation"
  | "report-generated"
  | "pending-publication"
  | "published"
  | "publication-partial"
  | "blocked";

export type TerminalIssueReportingBlockedStage =
  | "report-generation"
  | "publication";

export interface TerminalIssueSummary {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly currentOutcome: "succeeded" | "failed";
  readonly lastUpdatedAt: string;
}

export interface TerminalIssueReportingReceiptPaths {
  readonly issueRoot: string;
  readonly receiptFile: string;
}

export interface TerminalIssueReportingReceipt {
  readonly version: typeof TERMINAL_ISSUE_REPORTING_SCHEMA_VERSION;
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly terminalOutcome: "succeeded" | "failed";
  readonly issueUpdatedAt: string;
  readonly state: TerminalIssueReportingState;
  readonly summary: string;
  readonly note: string | null;
  readonly blockedStage: TerminalIssueReportingBlockedStage | null;
  readonly archiveRoot: string | null;
  readonly reportGeneratedAt: string | null;
  readonly reportJsonFile: string | null;
  readonly reportMarkdownFile: string | null;
  readonly publicationId: string | null;
  readonly publicationRoot: string | null;
  readonly publicationMetadataFile: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

export interface ReconcileTerminalIssueReportingResult {
  readonly receipt: TerminalIssueReportingReceipt;
  readonly changed: boolean;
}

export function deriveTerminalIssueReportingReceiptPaths(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): TerminalIssueReportingReceiptPaths {
  const resolvedInstance = coerceRuntimeInstancePaths(instance);
  const issueRoot = path.join(
    resolvedInstance.issueArtifactsRoot,
    issueNumber.toString(),
  );
  return {
    issueRoot,
    receiptFile: path.join(issueRoot, "terminal-reporting.json"),
  };
}

export async function readTerminalIssueReportingReceipt(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<TerminalIssueReportingReceipt | null> {
  const paths = deriveTerminalIssueReportingReceiptPaths(instance, issueNumber);
  try {
    const raw = await fs.readFile(paths.receiptFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["version"] !== TERMINAL_ISSUE_REPORTING_SCHEMA_VERSION) {
      throw new ObservabilityError(
        `Unsupported terminal issue reporting receipt schema in ${paths.receiptFile}`,
      );
    }
    return parsed as unknown as TerminalIssueReportingReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeTerminalIssueReportingReceipt(
  instance: RuntimeInstanceInput,
  receipt: TerminalIssueReportingReceipt,
): Promise<void> {
  const paths = deriveTerminalIssueReportingReceiptPaths(
    instance,
    receipt.issueNumber,
  );
  await fs.mkdir(paths.issueRoot, { recursive: true });
  await writeJsonFileAtomic(paths.receiptFile, receipt, {
    tempPrefix: ".terminal-reporting",
  });
}

export async function listTerminalIssues(
  instance: RuntimeInstanceInput,
): Promise<readonly TerminalIssueSummary[]> {
  const resolvedInstance = coerceRuntimeInstancePaths(instance);
  const entries = await fs
    .readdir(resolvedInstance.issueArtifactsRoot, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const completed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readTerminalIssue(resolvedInstance, Number(entry.name))),
  );
  return completed
    .filter((entry): entry is TerminalIssueSummary => entry !== null)
    .sort((left, right) => {
      if (left.lastUpdatedAt !== right.lastUpdatedAt) {
        return right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
      }
      return right.issueNumber - left.issueNumber;
    });
}

export async function readTerminalIssue(
  instance: RuntimeInstanceInput,
  issueNumber: number,
): Promise<TerminalIssueSummary | null> {
  const resolvedInstance = coerceRuntimeInstancePaths(instance);
  const issueFile = path.join(
    resolvedInstance.issueArtifactsRoot,
    issueNumber.toString(),
    "issue.json",
  );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(issueFile, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const currentOutcome = parsed["currentOutcome"];
  if (currentOutcome !== "succeeded" && currentOutcome !== "failed") {
    return null;
  }
  const issueIdentifier = parsed["issueIdentifier"];
  const title = parsed["title"];
  const lastUpdatedAt = parsed["lastUpdatedAt"];
  if (
    typeof issueIdentifier !== "string" ||
    typeof title !== "string" ||
    typeof lastUpdatedAt !== "string"
  ) {
    throw new ObservabilityError(
      `Malformed terminal issue summary at ${issueFile}; expected completed issue fields.`,
    );
  }
  return {
    issueNumber,
    issueIdentifier,
    title,
    currentOutcome,
    lastUpdatedAt,
  } satisfies TerminalIssueSummary;
}

export async function reconcileTerminalIssueReporting(args: {
  readonly instance: RuntimeInstanceInput;
  readonly issue: TerminalIssueSummary;
  readonly archiveRoot: string | null;
}): Promise<ReconcileTerminalIssueReportingResult> {
  const resolvedInstance = coerceRuntimeInstancePaths(args.instance);
  const receiptBefore = await readTerminalIssueReportingReceipt(
    resolvedInstance,
    args.issue.issueNumber,
  );
  const now = new Date().toISOString();
  const reportPaths = deriveIssueReportPaths(
    resolvedInstance,
    args.issue.issueNumber,
  );
  let changed = false;

  const reportDocument = await readIssueReportDocument(
    resolvedInstance,
    args.issue.issueNumber,
  ).catch(() => null);
  const hasCurrentReport =
    reportDocument !== null &&
    !isIssueReportStale(reportDocument.report.generatedAt, args.issue);

  if (!hasCurrentReport) {
    await writeTerminalIssueReportingReceipt(
      resolvedInstance,
      buildReceipt({
        issue: args.issue,
        state: "pending-generation",
        archiveRoot: args.archiveRoot,
        summary: "Generating the current terminal issue report.",
        updatedAt: now,
        reportJsonFile: reportPaths.reportJsonFile,
        reportMarkdownFile: reportPaths.reportMarkdownFile,
      }),
    );
    changed = true;
    try {
      const generated = await writeIssueReport(
        resolvedInstance,
        args.issue.issueNumber,
        {
          enrichers: createDefaultIssueReportEnrichers(),
        },
      );
      if (args.archiveRoot === null) {
        const receipt = buildReceipt({
          issue: args.issue,
          state: "report-generated",
          archiveRoot: null,
          summary:
            "Generated the current terminal issue report. Archive publication is not configured.",
          note: "Archive publication is not configured for this workflow.",
          updatedAt: new Date().toISOString(),
          reportGeneratedAt: generated.report.generatedAt,
          reportJsonFile: generated.outputPaths.reportJsonFile,
          reportMarkdownFile: generated.outputPaths.reportMarkdownFile,
        });
        await writeTerminalIssueReportingReceipt(resolvedInstance, receipt);
        return {
          receipt,
          changed: true,
        };
      }
    } catch (error) {
      const receipt = buildReceipt({
        issue: args.issue,
        state: "blocked",
        archiveRoot: args.archiveRoot,
        summary: "Terminal issue report generation is blocked.",
        note: error instanceof Error ? error.message : String(error),
        blockedStage: "report-generation",
        updatedAt: new Date().toISOString(),
        reportJsonFile: reportPaths.reportJsonFile,
        reportMarkdownFile: reportPaths.reportMarkdownFile,
      });
      await writeTerminalIssueReportingReceipt(resolvedInstance, receipt);
      return {
        receipt,
        changed: true,
      };
    }
  }

  const currentReport = await readIssueReportDocument(
    resolvedInstance,
    args.issue.issueNumber,
  );
  if (args.archiveRoot === null) {
    const nextReceipt = buildReceipt({
      issue: args.issue,
      state: "report-generated",
      archiveRoot: null,
      summary:
        "Generated the current terminal issue report. Archive publication is not configured.",
      note: "Archive publication is not configured for this workflow.",
      updatedAt: new Date().toISOString(),
      reportGeneratedAt: currentReport.report.generatedAt,
      reportJsonFile: currentReport.outputPaths.reportJsonFile,
      reportMarkdownFile: currentReport.outputPaths.reportMarkdownFile,
    });
    const equivalent =
      receiptBefore !== null &&
      areReceiptsEquivalent(receiptBefore, nextReceipt);
    if (!equivalent) {
      await writeTerminalIssueReportingReceipt(resolvedInstance, nextReceipt);
      changed = true;
    }
    return {
      receipt: nextReceipt,
      changed,
    };
  }

  if (
    receiptBefore !== null &&
    receiptBefore.issueUpdatedAt === args.issue.lastUpdatedAt &&
    receiptBefore.archiveRoot === args.archiveRoot &&
    receiptBefore.reportGeneratedAt === currentReport.report.generatedAt &&
    (receiptBefore.state === "published" ||
      receiptBefore.state === "publication-partial")
  ) {
    return {
      receipt: receiptBefore,
      changed,
    };
  }

  await writeTerminalIssueReportingReceipt(
    resolvedInstance,
    buildReceipt({
      issue: args.issue,
      state: "pending-publication",
      archiveRoot: args.archiveRoot,
      summary: "Publishing the current terminal issue report to factory-runs.",
      updatedAt: new Date().toISOString(),
      reportGeneratedAt: currentReport.report.generatedAt,
      reportJsonFile: currentReport.outputPaths.reportJsonFile,
      reportMarkdownFile: currentReport.outputPaths.reportMarkdownFile,
    }),
  );
  changed = true;

  try {
    const published = await publishIssueToFactoryRuns({
      instance: resolvedInstance,
      sourceRoot: resolvedInstance.workflowRoot,
      archiveRoot: args.archiveRoot,
      issueNumber: args.issue.issueNumber,
    });
    const receipt = buildReceipt({
      issue: args.issue,
      state:
        published.status === "complete" ? "published" : "publication-partial",
      archiveRoot: args.archiveRoot,
      summary:
        published.status === "complete"
          ? "Generated and published the current terminal issue report."
          : "Generated and published the current terminal issue report with partial log publication.",
      note:
        published.status === "complete"
          ? null
          : "Publication completed, but one or more session logs were referenced or unavailable.",
      updatedAt: new Date().toISOString(),
      reportGeneratedAt: currentReport.report.generatedAt,
      reportJsonFile: currentReport.outputPaths.reportJsonFile,
      reportMarkdownFile: currentReport.outputPaths.reportMarkdownFile,
      publicationId: published.publicationId,
      publicationRoot: published.paths.publicationRoot,
      publicationMetadataFile: published.paths.metadataFile,
      publishedAt: published.metadata.publishedAt,
    });
    await writeTerminalIssueReportingReceipt(resolvedInstance, receipt);
    return {
      receipt,
      changed: true,
    };
  } catch (error) {
    const receipt = buildReceipt({
      issue: args.issue,
      state: "blocked",
      archiveRoot: args.archiveRoot,
      summary: "Terminal issue report publication is blocked.",
      note: error instanceof Error ? error.message : String(error),
      blockedStage: "publication",
      updatedAt: new Date().toISOString(),
      reportGeneratedAt: currentReport.report.generatedAt,
      reportJsonFile: currentReport.outputPaths.reportJsonFile,
      reportMarkdownFile: currentReport.outputPaths.reportMarkdownFile,
    });
    await writeTerminalIssueReportingReceipt(resolvedInstance, receipt);
    return {
      receipt,
      changed: true,
    };
  }
}

export function isIssueReportStale(
  reportGeneratedAt: string,
  issue: TerminalIssueSummary,
): boolean {
  const reportTimestamp = Date.parse(reportGeneratedAt);
  const issueTimestamp = Date.parse(issue.lastUpdatedAt);
  return (
    Number.isFinite(reportTimestamp) &&
    Number.isFinite(issueTimestamp) &&
    reportTimestamp < issueTimestamp
  );
}

export function shouldReconcileTerminalIssue(args: {
  readonly issue: TerminalIssueSummary;
  readonly receipt: TerminalIssueReportingReceipt | null;
  readonly archiveRoot: string | null;
}): boolean {
  const { archiveRoot, issue, receipt } = args;
  if (receipt === null) {
    return true;
  }
  if (receipt.issueUpdatedAt !== issue.lastUpdatedAt) {
    return true;
  }
  if (receipt.archiveRoot !== archiveRoot) {
    return true;
  }

  if (archiveRoot === null) {
    return receipt.state !== "report-generated";
  }

  return (
    receipt.state !== "published" && receipt.state !== "publication-partial"
  );
}

function buildReceipt(args: {
  readonly issue: TerminalIssueSummary;
  readonly state: TerminalIssueReportingState;
  readonly archiveRoot: string | null;
  readonly summary: string;
  readonly updatedAt: string;
  readonly note?: string | null | undefined;
  readonly blockedStage?: TerminalIssueReportingBlockedStage | null | undefined;
  readonly reportGeneratedAt?: string | null | undefined;
  readonly reportJsonFile?: string | null | undefined;
  readonly reportMarkdownFile?: string | null | undefined;
  readonly publicationId?: string | null | undefined;
  readonly publicationRoot?: string | null | undefined;
  readonly publicationMetadataFile?: string | null | undefined;
  readonly publishedAt?: string | null | undefined;
}): TerminalIssueReportingReceipt {
  return {
    version: TERMINAL_ISSUE_REPORTING_SCHEMA_VERSION,
    issueNumber: args.issue.issueNumber,
    issueIdentifier: args.issue.issueIdentifier,
    issueTitle: args.issue.title,
    terminalOutcome: args.issue.currentOutcome,
    issueUpdatedAt: args.issue.lastUpdatedAt,
    state: args.state,
    summary: args.summary,
    note: args.note ?? null,
    blockedStage: args.blockedStage ?? null,
    archiveRoot: args.archiveRoot,
    reportGeneratedAt: args.reportGeneratedAt ?? null,
    reportJsonFile: args.reportJsonFile ?? null,
    reportMarkdownFile: args.reportMarkdownFile ?? null,
    publicationId: args.publicationId ?? null,
    publicationRoot: args.publicationRoot ?? null,
    publicationMetadataFile: args.publicationMetadataFile ?? null,
    publishedAt: args.publishedAt ?? null,
    updatedAt: args.updatedAt,
  };
}

function areReceiptsEquivalent(
  left: TerminalIssueReportingReceipt,
  right: TerminalIssueReportingReceipt,
): boolean {
  return (
    left.issueUpdatedAt === right.issueUpdatedAt &&
    left.state === right.state &&
    left.summary === right.summary &&
    left.note === right.note &&
    left.blockedStage === right.blockedStage &&
    left.archiveRoot === right.archiveRoot &&
    left.reportGeneratedAt === right.reportGeneratedAt &&
    left.reportJsonFile === right.reportJsonFile &&
    left.reportMarkdownFile === right.reportMarkdownFile &&
    left.publicationId === right.publicationId &&
    left.publicationRoot === right.publicationRoot &&
    left.publicationMetadataFile === right.publicationMetadataFile &&
    left.publishedAt === right.publishedAt
  );
}
