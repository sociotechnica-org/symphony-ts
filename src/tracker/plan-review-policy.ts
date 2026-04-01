import type { HandoffLifecycle } from "../domain/handoff.js";
import {
  parsePlanReviewSignal,
  type PlanReviewSignal,
} from "./plan-review-signal.js";
import { missingPullRequestLifecycle } from "./pull-request-policy.js";

export interface IssueCommentSnapshot {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly authorLogin: string | null;
}

type PlanReviewDecisionSignal = Exclude<PlanReviewSignal, "plan-ready">;

interface ParsedPlanReviewComment {
  readonly signal: PlanReviewSignal;
  readonly comment: IssueCommentSnapshot;
}

interface ParsedPlanReviewAcknowledgement {
  readonly signal: PlanReviewDecisionSignal;
  readonly reviewCommentId: number;
  readonly comment: IssueCommentSnapshot;
}

export interface PlanReviewProtocolEvaluation {
  readonly latestSignal: ParsedPlanReviewComment | null;
  readonly lifecycle: HandoffLifecycle | null;
  readonly acknowledgement: {
    readonly signal: PlanReviewDecisionSignal;
    readonly reviewCommentId: number;
    readonly body: string;
  } | null;
}

function parsePlanReviewComment(
  comment: IssueCommentSnapshot,
): ParsedPlanReviewComment | null {
  const signal = parsePlanReviewSignal(comment.body);
  return signal === null ? null : { signal, comment };
}

function parsePlanReviewAcknowledgement(
  comment: IssueCommentSnapshot,
): ParsedPlanReviewAcknowledgement | null {
  const lines = comment.body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const [firstLine, ...rest] = lines;
  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.toLowerCase();
  let signal: PlanReviewDecisionSignal | null = null;
  if (normalized === "plan review acknowledged: changes-requested") {
    signal = "changes-requested";
  } else if (normalized === "plan review acknowledged: approved") {
    signal = "approved";
  } else if (normalized === "plan review acknowledged: waived") {
    signal = "waived";
  }

  if (signal === null) {
    return null;
  }

  const idLine = rest.find((line) => /^review comment id:\s*\d+$/iu.test(line));
  if (!idLine) {
    return null;
  }

  const match = idLine.match(/^review comment id:\s*(\d+)$/iu);
  if (!match || !match[1]) {
    return null;
  }

  return {
    signal,
    reviewCommentId: Number(match[1]),
    comment,
  };
}

function hasAcknowledgedLatestSignal(
  signal: PlanReviewDecisionSignal,
  reviewCommentId: number,
  comments: readonly IssueCommentSnapshot[],
): boolean {
  return comments.some((comment) => {
    const acknowledgement = parsePlanReviewAcknowledgement(comment);
    return (
      acknowledgement !== null &&
      acknowledgement.signal === signal &&
      acknowledgement.reviewCommentId === reviewCommentId
    );
  });
}

function buildPlanReviewAcknowledgement(
  signal: PlanReviewDecisionSignal,
  comment: IssueCommentSnapshot,
): string {
  const nextAction =
    signal === "changes-requested"
      ? "Revise the plan, post a fresh `Plan status: plan-ready` comment, and wait for review again."
      : signal === "approved"
        ? "Begin substantial implementation."
        : "Begin substantial implementation without waiting for plan approval.";

  return [
    `Plan review acknowledged: ${signal}`,
    "",
    `Review comment id: ${comment.id.toString()}`,
    `Review comment URL: ${comment.url}`,
    "",
    "Next action",
    `- ${nextAction}`,
  ].join("\n");
}

function sortPlanReviewComments(
  left: ParsedPlanReviewComment,
  right: ParsedPlanReviewComment,
): number {
  const timeDiff =
    Date.parse(left.comment.createdAt) - Date.parse(right.comment.createdAt);
  return timeDiff !== 0 ? timeDiff : left.comment.id - right.comment.id;
}

function buildPlanReviewResumeLifecycle(
  branchName: string,
  signal: PlanReviewDecisionSignal,
): HandoffLifecycle {
  const summary =
    signal === "changes-requested"
      ? `Plan review requested changes for ${branchName}; revise the plan and post a fresh plan-ready handoff before implementation.`
      : signal === "approved"
        ? `Plan review approved for ${branchName}; resume implementation before opening a pull request.`
        : `Plan review waived for ${branchName}; resume implementation before opening a pull request.`;

  return missingPullRequestLifecycle(branchName, summary);
}

export function evaluatePlanReviewProtocol(
  branchName: string,
  issueUrl: string,
  comments: readonly IssueCommentSnapshot[],
): PlanReviewProtocolEvaluation {
  const parsedSignals = comments
    .map(parsePlanReviewComment)
    .filter((entry): entry is ParsedPlanReviewComment => entry !== null)
    .sort(sortPlanReviewComments);
  const latestSignal = parsedSignals.at(-1) ?? null;

  if (latestSignal === null) {
    return {
      latestSignal: null,
      lifecycle: null,
      acknowledgement: null,
    };
  }

  if (latestSignal.signal !== "plan-ready") {
    const anchoredPlanReady = [...parsedSignals]
      .reverse()
      .find(
        (entry) =>
          entry.signal === "plan-ready" &&
          sortPlanReviewComments(entry, latestSignal) < 0,
      );

    if (anchoredPlanReady === undefined) {
      return {
        latestSignal,
        lifecycle: null,
        acknowledgement: null,
      };
    }

    const acknowledgement = hasAcknowledgedLatestSignal(
      latestSignal.signal,
      latestSignal.comment.id,
      comments,
    )
      ? null
      : {
          signal: latestSignal.signal,
          reviewCommentId: latestSignal.comment.id,
          body: buildPlanReviewAcknowledgement(
            latestSignal.signal,
            latestSignal.comment,
          ),
        };

    return {
      latestSignal,
      lifecycle: buildPlanReviewResumeLifecycle(
        branchName,
        latestSignal.signal,
      ),
      acknowledgement,
    };
  }

  return {
    latestSignal,
    lifecycle: {
      kind: "awaiting-human-handoff",
      branchName,
      pullRequest: null,
      checks: [],
      pendingCheckNames: [],
      failingCheckNames: [],
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      reviewerVerdict: "no-blocking-verdict",
      blockingReviewerKeys: [],
      requiredReviewerState: "not-required",
      summary: `Waiting for human plan review on ${issueUrl}`,
    },
    acknowledgement: null,
  };
}

export function evaluatePlanReviewLifecycle(
  branchName: string,
  issueUrl: string,
  comments: readonly IssueCommentSnapshot[],
): HandoffLifecycle | null {
  return evaluatePlanReviewProtocol(branchName, issueUrl, comments).lifecycle;
}
