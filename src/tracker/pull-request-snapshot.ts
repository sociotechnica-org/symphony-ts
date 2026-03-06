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

export interface PullRequestSnapshot {
  readonly branchName: string;
  readonly pullRequest: PullRequestHandle;
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
      const comment = thread.comments.nodes.at(-1);
      if (!comment) {
        throw new TrackerError(
          `Pull request review thread ${thread.id} had no comments`,
        );
      }
      const feedback: ReviewFeedback = {
        id: comment.id,
        kind: "review-thread",
        threadId: thread.id,
        authorLogin: comment.author?.login ?? null,
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
        path: comment.path,
        line: comment.line,
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
      latestCommitAt,
    },
    checks: input.checks,
    pendingCheckNames,
    failingCheckNames,
    actionableReviewFeedback,
    botActionableReviewFeedback,
    unresolvedThreadIds,
  };
}
