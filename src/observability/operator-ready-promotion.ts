import { loadWorkflow } from "../config/workflow.js";
import type { RuntimeIssue } from "../domain/issue.js";
import { TrackerError } from "../domain/errors.js";
import {
  listStoredIssueSummaries,
  syncOperatorReleaseState,
  writeOperatorReleaseState,
  type OperatorReadyPromotionResult,
  type OperatorReleaseIssueReference,
  type OperatorReleaseStateDocument,
} from "./operator-release-state.js";
import { GitHubClient } from "../tracker/github-client.js";
import { evaluateReadyPromotion } from "../tracker/ready-promotion-policy.js";

export interface OperatorReadyPromotionExecution {
  readonly releaseStateFile: string;
  readonly state: OperatorReleaseStateDocument;
}

export async function promoteOperatorReadyIssues(args: {
  readonly workflowPath: string;
  readonly releaseStateFile: string;
  readonly promotedAt?: string | undefined;
}): Promise<OperatorReadyPromotionExecution> {
  const promotedAt = args.promotedAt ?? new Date().toISOString();
  const workflow = await loadWorkflow(args.workflowPath);
  const current = await syncOperatorReleaseState({
    instance: workflow.config.instance,
    releaseStateFile: args.releaseStateFile,
    updatedAt: promotedAt,
  });
  const issueFacts = await listStoredIssueSummaries(workflow.config.instance);

  const promotion = await createPromotionResult({
    workflow,
    releaseState: current,
    issueFacts,
    promotedAt,
  });
  const nextState: OperatorReleaseStateDocument = {
    version: current.version,
    updatedAt: promotedAt,
    configuration: current.configuration,
    evaluation: current.evaluation,
    promotion,
  };
  await writeOperatorReleaseState(args.releaseStateFile, nextState);

  return {
    releaseStateFile: args.releaseStateFile,
    state: nextState,
  };
}

async function createPromotionResult(args: {
  readonly workflow: Awaited<ReturnType<typeof loadWorkflow>>;
  readonly releaseState: OperatorReleaseStateDocument;
  readonly issueFacts: Awaited<ReturnType<typeof listStoredIssueSummaries>>;
  readonly promotedAt: string;
}): Promise<OperatorReadyPromotionResult> {
  const tracker = args.workflow.config.tracker;
  if (tracker.kind !== "github" && tracker.kind !== "github-bootstrap") {
    return {
      state: "unconfigured",
      summary:
        "Ready promotion is only implemented for GitHub-backed workflows in this slice.",
      promotedAt: args.promotedAt,
      eligibleIssues: [],
      readyLabelsAdded: [],
      readyLabelsRemoved: [],
      error: null,
    };
  }

  if (args.releaseState.configuration.dependencies.length === 0) {
    return {
      state: "unconfigured",
      summary:
        "No release dependency metadata is configured for this operator instance.",
      promotedAt: args.promotedAt,
      eligibleIssues: [],
      readyLabelsAdded: [],
      readyLabelsRemoved: [],
      error: null,
    };
  }

  const client = new GitHubClient(tracker);
  const downstreamIssueNumbers = [
    ...new Set(
      args.releaseState.configuration.dependencies.flatMap((dependency) =>
        dependency.downstream.map((issue) => issue.issueNumber),
      ),
    ),
  ];
  const trackerIssues = await Promise.all(
    downstreamIssueNumbers.map(async (issueNumber) =>
      toTrackerIssueSnapshot(
        await getIssueOrNull(client, issueNumber),
        tracker.readyLabel,
      ),
    ),
  );
  const availableTrackerIssues = trackerIssues.filter(
    (issue): issue is NonNullable<(typeof trackerIssues)[number]> =>
      issue !== null,
  );
  const decision = evaluateReadyPromotion({
    configuration: args.releaseState.configuration,
    issueFacts: args.issueFacts,
    trackerIssues: availableTrackerIssues,
  });

  if (decision.state === "unconfigured") {
    return {
      state: "unconfigured",
      summary: decision.summary,
      promotedAt: args.promotedAt,
      eligibleIssues: [],
      readyLabelsAdded: [],
      readyLabelsRemoved: [],
      error: null,
    };
  }

  if (decision.state === "blocked-review-needed") {
    return {
      state: "blocked-review-needed",
      summary: decision.summary,
      promotedAt: args.promotedAt,
      eligibleIssues: [],
      readyLabelsAdded: [],
      readyLabelsRemoved: [],
      error: null,
    };
  }

  const trackerIssuesByNumber = new Map(
    availableTrackerIssues.map((issue) => [issue.issueNumber, issue]),
  );
  const readyLabelsAdded: OperatorReleaseIssueReference[] = [];
  const readyLabelsRemoved: OperatorReleaseIssueReference[] = [];

  try {
    for (const issue of decision.addReadyLabelTo) {
      const trackerIssue = trackerIssuesByNumber.get(issue.issueNumber);
      if (trackerIssue === undefined) {
        continue;
      }
      await client.updateIssue(
        issue.issueNumber,
        {
          labels: [...trackerIssue.labels, tracker.readyLabel],
        },
        {
          blockedBy: "skip",
          includeQueuePriority: false,
        },
      );
      readyLabelsAdded.push(issue);
    }
    for (const issue of decision.removeReadyLabelFrom) {
      const trackerIssue = trackerIssuesByNumber.get(issue.issueNumber);
      if (trackerIssue === undefined) {
        continue;
      }
      await client.updateIssue(
        issue.issueNumber,
        {
          labels: trackerIssue.labels.filter(
            (label) => label !== tracker.readyLabel,
          ),
        },
        {
          blockedBy: "skip",
          includeQueuePriority: false,
        },
      );
      readyLabelsRemoved.push(issue);
    }
  } catch (error) {
    const message = normalizePromotionError(error);
    return {
      state: "sync-failed",
      summary: `Ready promotion failed while synchronizing GitHub labels: ${message}`,
      promotedAt: args.promotedAt,
      eligibleIssues: decision.eligibleIssues,
      readyLabelsAdded,
      readyLabelsRemoved,
      error: message,
    };
  }

  return {
    state: "labels-synchronized",
    summary: formatSynchronizedSummary({
      eligibleCount: decision.eligibleIssues.length,
      addCount: readyLabelsAdded.length,
      removeCount: readyLabelsRemoved.length,
    }),
    promotedAt: args.promotedAt,
    eligibleIssues: decision.eligibleIssues,
    readyLabelsAdded,
    readyLabelsRemoved,
    error: null,
  };
}

function toTrackerIssueSnapshot(
  issue: RuntimeIssue | null,
  readyLabel: string,
): {
  readonly issueNumber: number;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
  readonly state: string;
  readonly hasReadyLabel: boolean;
  readonly labels: readonly string[];
} | null {
  if (issue === null) {
    return null;
  }
  return {
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    hasReadyLabel: issue.labels.includes(readyLabel),
    labels: issue.labels,
  };
}

async function getIssueOrNull(
  client: GitHubClient,
  issueNumber: number,
): Promise<RuntimeIssue | null> {
  try {
    return await client.getIssue(issueNumber);
  } catch (error) {
    if (
      error instanceof TrackerError &&
      error.message.includes(" failed with 404:")
    ) {
      return null;
    }
    throw error;
  }
}

function formatSynchronizedSummary(args: {
  readonly eligibleCount: number;
  readonly addCount: number;
  readonly removeCount: number;
}): string {
  return [
    `Ready promotion synchronized ${args.eligibleCount.toString()} eligible downstream issue(s).`,
    `Added ready to ${args.addCount.toString()} issue(s).`,
    `Removed ready from ${args.removeCount.toString()} issue(s).`,
  ].join(" ");
}

function normalizePromotionError(error: unknown): string {
  if (error instanceof TrackerError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
