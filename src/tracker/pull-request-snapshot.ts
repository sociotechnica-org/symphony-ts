import { TrackerError } from "../domain/errors.js";
import type {
  PullRequestCheck,
  PullRequestHandle,
  ReviewFeedback,
} from "../domain/pull-request.js";
import type {
  GitHubPullRequestResponse,
  PullRequestReviewState,
} from "./github-client.js";
import { parseLandingCommandSignal } from "./landing-command-signal.js";

export interface PullRequestSnapshot {
  readonly branchName: string;
  readonly pullRequest: PullRequestHandle;
  readonly landingState: "open" | "merged";
  readonly hasLandingCommand: boolean;
  readonly checks: readonly PullRequestCheck[];
  readonly pendingCheckNames: readonly string[];
  readonly failingCheckNames: readonly string[];
  readonly actionableReviewFeedback: readonly ReviewFeedback[];
  readonly botActionableReviewFeedback: readonly ReviewFeedback[];
  readonly unresolvedThreadIds: readonly string[];
}

function isAfter(left: string, right: string | null): boolean {
  if (right === null) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}

function isHumanLandingApprover(
  authorLogin: string | null,
  authorAssociation: string,
  reviewBotLogins: ReadonlySet<string>,
): boolean {
  if (authorLogin === null) {
    return false;
  }
  const normalized = authorLogin.toLowerCase();
  return (
    !reviewBotLogins.has(normalized) &&
    !normalized.endsWith("[bot]") &&
    (authorAssociation === "OWNER" ||
      authorAssociation === "MEMBER" ||
      authorAssociation === "COLLABORATOR")
  );
}

export function createPullRequestSnapshot(input: {
  branchName: string;
  pullRequest: GitHubPullRequestResponse;
  checks: readonly PullRequestCheck[];
  reviewState: PullRequestReviewState;
  reviewBotLogins: readonly string[];
}): PullRequestSnapshot {
  const latestCommitAt =
    input.reviewState.commits.nodes[0]?.commit.committedDate ?? null;
  const reviewBotLogins = new Set(
    input.reviewBotLogins.map((login) => login.toLowerCase()),
  );

  const unresolvedThreads = input.reviewState.reviewThreads.nodes
    .filter((thread) => !thread.isResolved && !thread.isOutdated)
    .map((thread) => {
      const originComment = thread.originComments.nodes[0];
      const latestComment = thread.latestComments.nodes[0];
      if (!originComment || !latestComment) {
        throw new TrackerError(
          `Pull request review thread ${thread.id} had no comments`,
        );
      }
      const feedback: ReviewFeedback = {
        id: latestComment.id,
        kind: "review-thread",
        threadId: thread.id,
        // Keep thread ownership stable even if humans reply inside the thread.
        authorLogin: originComment.author?.login ?? null,
        body: latestComment.body,
        createdAt: latestComment.createdAt,
        url: latestComment.url,
        path: latestComment.path,
        line: latestComment.line,
      };
      return feedback;
    });

  const actionableBotComments =
    reviewBotLogins.size === 0
      ? []
      : input.reviewState.comments.nodes
          .filter((comment) => {
            const authorLogin = comment.author?.login;
            return (
              typeof authorLogin === "string" &&
              reviewBotLogins.has(authorLogin.toLowerCase())
            );
          })
          .filter((comment) => isAfter(comment.createdAt, latestCommitAt))
          .map<ReviewFeedback>((comment) => ({
            id: comment.id,
            kind: "issue-comment",
            threadId: null,
            authorLogin: comment.author?.login ?? null,
            body: comment.body,
            createdAt: comment.createdAt,
            url: comment.url,
            path: null,
            line: null,
          }));

  const hasLandingCommand =
    latestCommitAt !== null &&
    input.reviewState.comments.nodes.some((comment) => {
      const authorLogin = comment.author?.login ?? null;
      return (
        isHumanLandingApprover(
          authorLogin,
          comment.authorAssociation,
          reviewBotLogins,
        ) &&
        isAfter(comment.createdAt, latestCommitAt) &&
        parseLandingCommandSignal(comment.body)
      );
    });

  const actionableReviewFeedback = [
    ...unresolvedThreads,
    ...actionableBotComments,
  ];
  const botActionableReviewFeedback = actionableReviewFeedback.filter(
    (feedback) => {
      const authorLogin = feedback.authorLogin;
      return (
        typeof authorLogin === "string" &&
        reviewBotLogins.has(authorLogin.toLowerCase())
      );
    },
  );

  const pendingCheckNames = input.checks
    .filter((check) => check.status === "pending")
    .map((check) => check.name);
  const failingCheckNames = input.checks
    .filter((check) => check.status === "failure")
    .map((check) => check.name);
  const unresolvedThreadIds = botActionableReviewFeedback
    .filter((feedback) => feedback.kind === "review-thread")
    .map((feedback) => feedback.threadId)
    .filter((threadId): threadId is string => threadId !== null);

  return {
    branchName: input.branchName,
    pullRequest: {
      number: input.pullRequest.number,
      url: input.pullRequest.html_url,
      branchName: input.pullRequest.head.ref,
      headSha: input.pullRequest.head.sha,
      latestCommitAt,
    },
    landingState: input.pullRequest.landingState,
    hasLandingCommand,
    checks: input.checks,
    pendingCheckNames,
    failingCheckNames,
    actionableReviewFeedback,
    botActionableReviewFeedback,
    unresolvedThreadIds,
  };
}
