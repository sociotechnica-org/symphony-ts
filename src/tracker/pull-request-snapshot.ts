import { TrackerError } from "../domain/errors.js";
import type { LandingCommandObservation } from "../domain/handoff.js";
import type {
  PullRequestCheck,
  PullRequestHandle,
  ReviewFeedback,
} from "../domain/pull-request.js";
import type { GitHubReviewerAppConfig } from "../domain/workflow.js";
import type {
  PullRequestRequiredReviewerState,
  PullRequestReviewerVerdict,
} from "../domain/handoff.js";
import type {
  GitHubPullRequestDetailsResponse,
  GitHubPullRequestResponse,
  PullRequestReviewState,
} from "./github-client.js";
import { parseLandingCommandSignal } from "./landing-command-signal.js";
import {
  createReviewerAppSnapshots,
  evaluateReviewerVerdict,
  evaluateRequiredReviewerState,
  getConfiguredReviewerAppLogins,
  type CurrentHeadIssueComment,
  type CurrentHeadPullRequestReview,
} from "./reviewer-apps.js";
import type { ReviewerAppSnapshot } from "./reviewer-app-types.js";

export interface PullRequestSnapshot {
  readonly branchName: string;
  readonly pullRequest: PullRequestHandle;
  readonly landingState: "open" | "merged";
  readonly draft: boolean;
  readonly mergeable: boolean | null;
  readonly mergeStateStatus: string | null;
  readonly hasLandingCommand: boolean;
  readonly landingCommand: LandingCommandObservation | null;
  readonly checks: readonly PullRequestCheck[];
  readonly pendingCheckNames: readonly string[];
  readonly failingCheckNames: readonly string[];
  readonly actionableReviewFeedback: readonly ReviewFeedback[];
  readonly botActionableReviewFeedback: readonly ReviewFeedback[];
  readonly unresolvedThreadIds: readonly string[];
  readonly reviewerApps: readonly ReviewerAppSnapshot[];
  readonly reviewerVerdict: PullRequestReviewerVerdict;
  readonly blockingReviewerKeys: readonly string[];
  readonly requiredReviewerState: PullRequestRequiredReviewerState;
  readonly observedReviewerKeys: readonly string[];
}

function hasMergeabilityFields(
  pullRequest: GitHubPullRequestResponse,
): pullRequest is GitHubPullRequestResponse & GitHubPullRequestDetailsResponse {
  return (
    "mergeable" in pullRequest &&
    "mergeable_state" in pullRequest &&
    "draft" in pullRequest
  );
}

function isAfter(left: string, right: string | null): boolean {
  if (right === null) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}

function compareIsoTimestampsDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

function isQualifyingLandingCommandAuthor(
  authorLogin: string | null,
  authorAssociation: string,
  reviewerAppLogins: ReadonlySet<string>,
): boolean {
  if (authorLogin === null) {
    return false;
  }
  const normalized = authorLogin.toLowerCase();
  if (reviewerAppLogins.has(normalized)) {
    return false;
  }

  if (normalized.endsWith("[bot]")) {
    return true;
  }

  return (
    authorAssociation === "OWNER" ||
    authorAssociation === "MEMBER" ||
    authorAssociation === "COLLABORATOR"
  );
}

export function createPullRequestSnapshot(input: {
  branchName: string;
  pullRequest: GitHubPullRequestResponse;
  checks: readonly PullRequestCheck[];
  reviewState: PullRequestReviewState;
  reviewBotLogins: readonly string[];
  approvedReviewBotLogins?: readonly string[] | undefined;
  reviewerApps?: readonly GitHubReviewerAppConfig[] | undefined;
}): PullRequestSnapshot {
  const latestCommitAt =
    input.reviewState.commits.nodes[0]?.commit.committedDate ?? null;
  const reviewerAppLogins = getConfiguredReviewerAppLogins({
    reviewBotLogins: input.reviewBotLogins,
    approvedReviewBotLogins: input.approvedReviewBotLogins ?? [],
    reviewerApps: input.reviewerApps ?? [],
  });

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
  const currentHeadIssueComments: CurrentHeadIssueComment[] =
    input.reviewState.comments.nodes
      .filter((comment) => isAfter(comment.createdAt, latestCommitAt))
      .map((comment) => ({
        id: comment.id,
        authorLogin: comment.author?.login ?? null,
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
        authorAssociation: comment.authorAssociation,
      }));
  const currentHeadPullRequestReviews: CurrentHeadPullRequestReview[] = (
    input.reviewState.reviews?.nodes ?? []
  )
    .filter((review) => isAfter(review.submittedAt, latestCommitAt))
    .map((review) => ({
      id: review.id,
      authorLogin: review.author?.login ?? null,
      body: review.body,
      submittedAt: review.submittedAt,
      url: review.url,
    }));
  const reviewerApps = createReviewerAppSnapshots({
    config: {
      reviewBotLogins: input.reviewBotLogins,
      approvedReviewBotLogins: input.approvedReviewBotLogins ?? [],
      reviewerApps: input.reviewerApps ?? [],
    },
    checks: input.checks,
    currentHeadIssueComments,
    currentHeadPullRequestReviews,
    unresolvedReviewThreads: unresolvedThreads,
  });

  const landingCommand =
    latestCommitAt === null
      ? null
      : (currentHeadIssueComments
          .filter(
            (comment) =>
              isQualifyingLandingCommandAuthor(
                comment.authorLogin,
                comment.authorAssociation,
                reviewerAppLogins,
              ) && parseLandingCommandSignal(comment.body),
          )
          .sort((left, right) =>
            compareIsoTimestampsDescending(left.createdAt, right.createdAt),
          )
          .map(
            (comment) =>
              ({
                commentId: comment.id,
                authorLogin: comment.authorLogin,
                observedAt: comment.createdAt,
                url: comment.url,
              }) satisfies LandingCommandObservation,
          )[0] ?? null);
  const botActionableReviewFeedback = reviewerApps
    .filter((reviewer) => reviewer.accepted)
    .flatMap((reviewer) => reviewer.actionableFeedback);
  const botActionableFeedbackIds = new Set(
    botActionableReviewFeedback.map((feedback) => feedback.id),
  );
  const actionableReviewFeedback = [
    ...unresolvedThreads.filter(
      (feedback) => !botActionableFeedbackIds.has(feedback.id),
    ),
    ...botActionableReviewFeedback,
  ];

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
  const reviewerVerdict = evaluateReviewerVerdict({ reviewerApps });
  const requiredReviewerState = evaluateRequiredReviewerState(reviewerApps);
  const observedReviewerKeys = reviewerApps
    .filter((reviewer) => reviewer.coverage === "observed")
    .map((reviewer) => reviewer.reviewerKey);

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
    draft: hasMergeabilityFields(input.pullRequest)
      ? input.pullRequest.draft
      : false,
    mergeable: hasMergeabilityFields(input.pullRequest)
      ? input.pullRequest.mergeable
      : null,
    mergeStateStatus: hasMergeabilityFields(input.pullRequest)
      ? (input.pullRequest.mergeable_state?.toLowerCase() ?? null)
      : null,
    hasLandingCommand: landingCommand !== null,
    landingCommand,
    checks: input.checks,
    pendingCheckNames,
    failingCheckNames,
    actionableReviewFeedback,
    botActionableReviewFeedback,
    unresolvedThreadIds,
    reviewerApps,
    reviewerVerdict: reviewerVerdict.verdict,
    blockingReviewerKeys: reviewerVerdict.blockingReviewerKeys,
    requiredReviewerState,
    observedReviewerKeys,
  };
}
