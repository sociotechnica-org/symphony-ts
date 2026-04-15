import type { GitHubReviewerAppConfig } from "../domain/workflow.js";
import type {
  PullRequestCheck,
  ReviewFeedback,
} from "../domain/pull-request.js";
import type { ReviewerAppSnapshot } from "./reviewer-app-types.js";
import { normalizeGitHubLogin } from "./github-login.js";
import type {
  CurrentHeadIssueComment,
  CurrentHeadPullRequestReview,
  GitHubReviewerAppAdapter,
  ReviewerAppAdapterInput,
} from "./reviewer-apps.js";

const DEVIN_LOGIN = "devin-ai-integration";
const DEVIN_CHECK_NAME = "Devin Review";

function summarizeBody(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

function parseDevinVerdict(body: string): "pass" | "issues-found" | "unknown" {
  if (/devin review:?\s*no issues found/i.test(body)) {
    return "pass";
  }
  if (
    /devin review:?.*found\s+\d+\s+potential issues/i.test(body) ||
    /devin review:?.*issues found/i.test(body)
  ) {
    return "issues-found";
  }
  return "unknown";
}

function createIssueCommentFeedback(
  comment: CurrentHeadIssueComment,
): ReviewFeedback {
  return {
    id: comment.id,
    kind: "issue-comment",
    threadId: null,
    authorLogin: comment.authorLogin,
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    path: null,
    line: null,
  };
}

function createPullRequestReviewFeedback(
  review: CurrentHeadPullRequestReview,
): ReviewFeedback {
  return {
    id: review.id,
    kind: "pull-request-review",
    threadId: null,
    authorLogin: review.authorLogin,
    body: review.body,
    createdAt: review.submittedAt,
    url: review.url,
    path: null,
    line: null,
  };
}

function isDevinAuthoredFeedback(feedback: ReviewFeedback): boolean {
  return (
    feedback.authorLogin !== null &&
    normalizeGitHubLogin(feedback.authorLogin) === DEVIN_LOGIN
  );
}

function latestRecognizedArtifact(
  comments: readonly CurrentHeadIssueComment[],
  reviews: readonly CurrentHeadPullRequestReview[],
): {
  readonly createdAt: string;
  readonly verdict: "pass" | "issues-found";
  readonly feedback: ReviewFeedback;
} | null {
  const recognized = [
    ...comments
      .map((comment) => ({
        createdAt: comment.createdAt,
        verdict: parseDevinVerdict(comment.body),
        feedback: createIssueCommentFeedback(comment),
      }))
      .filter(
        (
          entry,
        ): entry is {
          readonly createdAt: string;
          readonly verdict: "pass" | "issues-found";
          readonly feedback: ReviewFeedback;
        } => entry.verdict !== "unknown",
      ),
    ...reviews
      .map((review) => ({
        createdAt: review.submittedAt,
        verdict: parseDevinVerdict(review.body),
        feedback: createPullRequestReviewFeedback(review),
      }))
      .filter(
        (
          entry,
        ): entry is {
          readonly createdAt: string;
          readonly verdict: "pass" | "issues-found";
          readonly feedback: ReviewFeedback;
        } => entry.verdict !== "unknown",
      ),
  ].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );

  return recognized[0] ?? null;
}

function hasMatchingCheck(
  checks: readonly PullRequestCheck[],
  status: PullRequestCheck["status"],
): boolean {
  return checks.some(
    (check) => check.name === DEVIN_CHECK_NAME && check.status === status,
  );
}

export const devinReviewerAppAdapter: GitHubReviewerAppAdapter = {
  key: "devin",
  handledLogins: [DEVIN_LOGIN],
  evaluate(
    config: GitHubReviewerAppConfig,
    input: ReviewerAppAdapterInput,
  ): ReviewerAppSnapshot {
    const unresolvedThreads = input.unresolvedReviewThreads.filter(
      isDevinAuthoredFeedback,
    );
    const comments = input.currentHeadIssueComments.filter(
      (comment) =>
        comment.authorLogin !== null &&
        normalizeGitHubLogin(comment.authorLogin) === DEVIN_LOGIN,
    );
    const reviews = input.currentHeadPullRequestReviews.filter(
      (review) =>
        review.authorLogin !== null &&
        normalizeGitHubLogin(review.authorLogin) === DEVIN_LOGIN,
    );
    const latestArtifact = latestRecognizedArtifact(comments, reviews);
    const hasRunningCheck = hasMatchingCheck(input.checks, "pending");
    const hasCompletedCheck =
      hasMatchingCheck(input.checks, "success") ||
      hasMatchingCheck(input.checks, "failure");
    const coverage =
      unresolvedThreads.length > 0 ||
      comments.length > 0 ||
      reviews.length > 0 ||
      hasRunningCheck ||
      hasCompletedCheck
        ? "observed"
        : "missing";
    const status = hasRunningCheck
      ? "running"
      : unresolvedThreads.length > 0 ||
          comments.length > 0 ||
          reviews.length > 0 ||
          hasCompletedCheck
        ? "completed"
        : "unknown";
    const verdict =
      unresolvedThreads.length > 0
        ? "issues-found"
        : (latestArtifact?.verdict ?? "unknown");
    const actionableFeedback = [
      ...unresolvedThreads,
      ...(latestArtifact !== null && latestArtifact.verdict === "issues-found"
        ? [latestArtifact.feedback]
        : []),
    ];

    return {
      reviewerKey: config.key,
      accepted: config.accepted,
      required: config.required,
      coverage,
      status,
      verdict,
      actionableFeedback,
      unresolvedFeedbackIds: actionableFeedback.map((feedback) => feedback.id),
      evidence: [
        ...input.checks
          .filter((check) => check.name === DEVIN_CHECK_NAME)
          .map((check) => ({
            id: `check:${check.name}:${check.status}`,
            kind: "check" as const,
            createdAt: null,
            url: check.detailsUrl,
            summary: `${check.name} is ${check.status}`,
          })),
        ...comments.map((comment) => ({
          id: comment.id,
          kind: "issue-comment" as const,
          createdAt: comment.createdAt,
          url: comment.url,
          summary: summarizeBody(comment.body),
        })),
        ...reviews.map((review) => ({
          id: review.id,
          kind: "pull-request-review" as const,
          createdAt: review.submittedAt,
          url: review.url,
          summary: summarizeBody(review.body),
        })),
        ...unresolvedThreads.map((thread) => ({
          id: thread.id,
          kind: "review-thread" as const,
          createdAt: thread.createdAt,
          url: thread.url,
          summary: summarizeBody(thread.body),
        })),
      ],
    };
  },
};
