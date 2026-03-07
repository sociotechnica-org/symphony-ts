import type { PullRequestLifecycle } from "../domain/pull-request.js";

export interface IssueCommentSnapshot {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly authorLogin: string | null;
}

type PlanReviewSignal =
  | "plan-ready"
  | "changes-requested"
  | "approved"
  | "waived";

interface ParsedPlanReviewComment {
  readonly signal: PlanReviewSignal;
  readonly comment: IssueCommentSnapshot;
}

function parsePlanReviewComment(
  comment: IssueCommentSnapshot,
): ParsedPlanReviewComment | null {
  const firstLine = comment.body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.toLowerCase();
  if (normalized === "plan status: plan-ready") {
    return { signal: "plan-ready", comment };
  }
  if (normalized === "plan review: changes-requested") {
    return { signal: "changes-requested", comment };
  }
  if (normalized === "plan review: approved") {
    return { signal: "approved", comment };
  }
  if (normalized === "plan review: waived") {
    return { signal: "waived", comment };
  }

  return null;
}

export function evaluatePlanReviewLifecycle(
  branchName: string,
  issueUrl: string,
  comments: readonly IssueCommentSnapshot[],
): PullRequestLifecycle | null {
  const latestSignal = comments
    .map(parsePlanReviewComment)
    .filter((entry): entry is ParsedPlanReviewComment => entry !== null)
    .sort((left, right) => {
      const timeDiff =
        Date.parse(left.comment.createdAt) -
        Date.parse(right.comment.createdAt);
      return timeDiff !== 0 ? timeDiff : left.comment.id - right.comment.id;
    })
    .at(-1);

  if (!latestSignal || latestSignal.signal !== "plan-ready") {
    return null;
  }

  // Author validation is intentionally deferred to #48 so #42 only fixes the
  // runtime handoff semantics; today the issue comment first-line markers are
  // treated as an open-trust protocol.

  return {
    kind: "awaiting-plan-review",
    branchName,
    pullRequest: null,
    checks: [],
    pendingCheckNames: [],
    failingCheckNames: [],
    actionableReviewFeedback: [],
    unresolvedThreadIds: [],
    summary: `Waiting for human plan review on ${issueUrl}`,
  };
}
