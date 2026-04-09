import type { RuntimeIssue } from "../domain/issue.js";
import type { ResolvedConfig } from "../domain/workflow.js";
import { getConfigInstancePaths } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import {
  listTerminalIssues,
  readTerminalIssue,
  readTerminalIssueReportingReceipt,
  reconcileTerminalIssueReporting,
  shouldReconcileTerminalIssue,
  type TerminalIssueReportingReceipt,
} from "../observability/terminal-reporting.js";
import {
  clearTerminalIssueReportingState,
  enqueueTerminalIssueReporting,
  isTerminalIssueReportingDue,
  scheduleTerminalIssueReportingRetry,
  seedTerminalIssueReportingBackoff,
} from "./terminal-reporting-state.js";
import type { OrchestratorState } from "./state.js";
import type { WorkspaceRetentionOutcome } from "./workspace-retention.js";

interface TerminalIssueLike {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly currentOutcome: "succeeded" | "failed";
  readonly lastUpdatedAt: string;
}

export interface UpsertTerminalReportingStatusInput {
  readonly branchName: string;
  readonly terminalOutcome: "success" | "failure";
  readonly observedAt: string;
  readonly workspaceRetentionState:
    | WorkspaceRetentionOutcome["state"]
    | "unknown";
  readonly summary: string;
  readonly receipt: TerminalIssueReportingReceipt | null;
  readonly fallbackReportingSummary?: string;
  readonly fallbackBlockedStage?: "report-generation" | "publication";
}

export interface TerminalReportingCoordinatorContext {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly state: OrchestratorState;
  readonly branchName: (issueNumber: number) => string;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly upsertTerminalReportingStatus: (
    issue: Pick<RuntimeIssue, "number" | "identifier" | "title">,
    options: UpsertTerminalReportingStatusInput,
  ) => void;
}

function terminalIssueReportingBaseBackoffMs(config: ResolvedConfig): number {
  return Math.max(
    config.polling.intervalMs * 2,
    config.polling.retry.backoffMs,
  );
}

function terminalIssueReportingMaxBackoffMs(config: ResolvedConfig): number {
  return Math.max(
    terminalIssueReportingBaseBackoffMs(config),
    config.polling.intervalMs * 16,
  );
}

function toTerminalIssue(
  issue: Pick<RuntimeIssue, "number" | "identifier" | "title">,
  observedAt: string,
  terminalOutcome: "success" | "failure",
): TerminalIssueLike {
  return {
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    title: issue.title,
    currentOutcome: terminalOutcome === "success" ? "succeeded" : "failed",
    lastUpdatedAt: observedAt,
  };
}

export async function reconcileTerminalReportingBacklog(
  context: TerminalReportingCoordinatorContext,
): Promise<void> {
  const instance = getConfigInstancePaths(context.config);
  const archiveRoot = context.config.observability.issueReports.archiveRoot;

  if (!context.state.terminalIssueReporting.backlogScanned) {
    const terminalIssues = await listTerminalIssues(instance);
    for (const issue of terminalIssues) {
      const receipt = await readTerminalIssueReportingReceipt(
        instance,
        issue.issueNumber,
      );
      if (
        shouldReconcileTerminalIssue({
          issue,
          receipt,
          archiveRoot,
        })
      ) {
        if (receipt?.state === "blocked") {
          seedTerminalIssueReportingBackoff(
            context.state.terminalIssueReporting,
            {
              issueNumber: issue.issueNumber,
              updatedAt: receipt.updatedAt,
              baseBackoffMs: terminalIssueReportingBaseBackoffMs(
                context.config,
              ),
            },
          );
        } else {
          enqueueTerminalIssueReporting(
            context.state.terminalIssueReporting,
            issue.issueNumber,
          );
        }
        continue;
      }

      const existingTerminal = context.state.status.terminalIssues.find(
        (entry) => entry.issueNumber === issue.issueNumber,
      );
      context.upsertTerminalReportingStatus(
        {
          number: issue.issueNumber,
          identifier: issue.issueIdentifier,
          title: issue.title,
        },
        {
          branchName:
            existingTerminal?.branchName ??
            context.branchName(issue.issueNumber),
          terminalOutcome:
            issue.currentOutcome === "succeeded" ? "success" : "failure",
          observedAt: issue.lastUpdatedAt,
          workspaceRetentionState:
            existingTerminal?.workspaceRetention.state ?? "unknown",
          summary:
            existingTerminal?.summary ??
            `Terminal issue state recorded for ${issue.issueIdentifier}.`,
          receipt,
        },
      );
    }
    context.state.terminalIssueReporting.backlogScanned = true;
    if (terminalIssues.length > 0) {
      await context.persistStatusSnapshot();
    }
  }

  if (context.state.terminalIssueReporting.queuedIssueNumbers.size === 0) {
    return;
  }

  let statusChanged = false;
  for (const issueNumber of [
    ...context.state.terminalIssueReporting.queuedIssueNumbers,
  ]) {
    if (
      !isTerminalIssueReportingDue(
        context.state.terminalIssueReporting,
        issueNumber,
      )
    ) {
      continue;
    }

    const issue = await readTerminalIssue(instance, issueNumber);
    if (issue === null) {
      clearTerminalIssueReportingState(
        context.state.terminalIssueReporting,
        issueNumber,
      );
      continue;
    }

    try {
      const result = await reconcileTerminalIssueReporting({
        instance,
        issue,
        archiveRoot,
      });
      const existingTerminal = context.state.status.terminalIssues.find(
        (entry) => entry.issueNumber === issue.issueNumber,
      );
      context.upsertTerminalReportingStatus(
        {
          number: issue.issueNumber,
          identifier: issue.issueIdentifier,
          title: issue.title,
        },
        {
          branchName:
            existingTerminal?.branchName ??
            context.branchName(issue.issueNumber),
          terminalOutcome:
            issue.currentOutcome === "succeeded" ? "success" : "failure",
          observedAt: issue.lastUpdatedAt,
          workspaceRetentionState:
            existingTerminal?.workspaceRetention.state ?? "unknown",
          summary:
            existingTerminal?.summary ??
            `Terminal issue state recorded for ${issue.issueIdentifier}.`,
          receipt: result.receipt,
        },
      );
      if (
        shouldReconcileTerminalIssue({
          issue,
          receipt: result.receipt,
          archiveRoot,
        })
      ) {
        if (result.receipt.state === "blocked") {
          scheduleTerminalIssueReportingRetry(
            context.state.terminalIssueReporting,
            {
              issueNumber: issue.issueNumber,
              baseBackoffMs: terminalIssueReportingBaseBackoffMs(
                context.config,
              ),
              maxBackoffMs: terminalIssueReportingMaxBackoffMs(context.config),
            },
          );
        } else {
          enqueueTerminalIssueReporting(
            context.state.terminalIssueReporting,
            issue.issueNumber,
          );
        }
      } else {
        clearTerminalIssueReportingState(
          context.state.terminalIssueReporting,
          issue.issueNumber,
        );
      }
      statusChanged = statusChanged || result.changed;
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error.message : String(error);
      context.logger.error("Terminal issue reporting reconciliation failed", {
        issueNumber: issue.issueNumber,
        error: normalizedError,
      });
      const existingTerminal = context.state.status.terminalIssues.find(
        (entry) => entry.issueNumber === issue.issueNumber,
      );
      context.upsertTerminalReportingStatus(
        {
          number: issue.issueNumber,
          identifier: issue.issueIdentifier,
          title: issue.title,
        },
        {
          branchName:
            existingTerminal?.branchName ??
            context.branchName(issue.issueNumber),
          terminalOutcome:
            issue.currentOutcome === "succeeded" ? "success" : "failure",
          observedAt: issue.lastUpdatedAt,
          workspaceRetentionState:
            existingTerminal?.workspaceRetention.state ?? "unknown",
          summary:
            existingTerminal?.summary ??
            `Terminal issue state recorded for ${issue.issueIdentifier}.`,
          receipt: null,
          fallbackReportingSummary: normalizedError,
          fallbackBlockedStage: "report-generation",
        },
      );
      scheduleTerminalIssueReportingRetry(
        context.state.terminalIssueReporting,
        {
          issueNumber: issue.issueNumber,
          baseBackoffMs: terminalIssueReportingBaseBackoffMs(context.config),
          maxBackoffMs: terminalIssueReportingMaxBackoffMs(context.config),
        },
      );
      statusChanged = true;
    }
  }

  if (statusChanged) {
    await context.persistStatusSnapshot();
  }
}

export async function runTerminalIssueReporting(
  context: TerminalReportingCoordinatorContext,
  issue: Pick<RuntimeIssue, "number" | "identifier" | "title">,
  options: {
    readonly terminalOutcome: "success" | "failure";
    readonly branchName: string;
    readonly observedAt: string;
    readonly workspaceRetention: WorkspaceRetentionOutcome;
    readonly summary: string;
  },
): Promise<void> {
  const terminalIssue = toTerminalIssue(
    issue,
    options.observedAt,
    options.terminalOutcome,
  );

  try {
    const { receipt } = await reconcileTerminalIssueReporting({
      instance: getConfigInstancePaths(context.config),
      issue: terminalIssue,
      archiveRoot: context.config.observability.issueReports.archiveRoot,
    });
    context.upsertTerminalReportingStatus(issue, {
      branchName: options.branchName,
      terminalOutcome: options.terminalOutcome,
      observedAt: options.observedAt,
      workspaceRetentionState: options.workspaceRetention.state,
      summary: options.summary,
      receipt,
    });
    if (
      shouldReconcileTerminalIssue({
        issue: terminalIssue,
        receipt,
        archiveRoot: context.config.observability.issueReports.archiveRoot,
      })
    ) {
      if (receipt.state === "blocked") {
        scheduleTerminalIssueReportingRetry(
          context.state.terminalIssueReporting,
          {
            issueNumber: issue.number,
            baseBackoffMs: terminalIssueReportingBaseBackoffMs(context.config),
            maxBackoffMs: terminalIssueReportingMaxBackoffMs(context.config),
          },
        );
      } else {
        enqueueTerminalIssueReporting(
          context.state.terminalIssueReporting,
          issue.number,
        );
      }
    } else {
      clearTerminalIssueReportingState(
        context.state.terminalIssueReporting,
        issue.number,
      );
    }
    await context.persistStatusSnapshot();
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error.message : String(error);
    context.logger.error("Terminal issue reporting failed", {
      issueNumber: issue.number,
      error: normalizedError,
    });
    context.upsertTerminalReportingStatus(issue, {
      branchName: options.branchName,
      terminalOutcome: options.terminalOutcome,
      observedAt: options.observedAt,
      workspaceRetentionState: options.workspaceRetention.state,
      summary: options.summary,
      receipt: null,
      fallbackReportingSummary: normalizedError,
      fallbackBlockedStage: "report-generation",
    });
    scheduleTerminalIssueReportingRetry(context.state.terminalIssueReporting, {
      issueNumber: issue.number,
      baseBackoffMs: terminalIssueReportingBaseBackoffMs(context.config),
      maxBackoffMs: terminalIssueReportingMaxBackoffMs(context.config),
    });
    await context.persistStatusSnapshot();
  }
}
