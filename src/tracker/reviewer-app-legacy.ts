import type { ReviewFeedback } from "../domain/pull-request.js";
import type { ReviewerAppSnapshot } from "./reviewer-app-types.js";
import type { PullRequestCheck } from "../domain/pull-request.js";

const NON_ACTIONABLE_BOT_COMMENT_MARKERS = {
  cursorSummary: "<!-- CURSOR_SUMMARY -->",
  cursorTakingALook: /^Taking a look!\s*/i,
  cursorAgentLinks:
    /cursor\.com\/(agents\/|background-agent\?|assets\/images\/open-in-(web|cursor))/i,
  greptileSummaryHeading: /<h3\b[^>]*>\s*Greptile Summary\s*<\/h3>/i,
} as const;

const APPROVED_REVIEW_BOT_STATUS_CONTEXTS: Readonly<
  Record<string, readonly string[]>
> = {
  "greptile-apps": ["Greptile Review"],
  "greptile[bot]": ["Greptile Review"],
  cursor: ["Cursor Bugbot"],
  "cursor[bot]": ["Cursor Bugbot"],
  "bugbot[bot]": ["Cursor Bugbot"],
} as const;

function summarizeBody(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

function isQualifyingApprovedReviewBody(body: string): boolean {
  const normalized = body.trim();
  return (
    normalized.length > 0 &&
    !normalized.includes(NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorSummary) &&
    !(
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorTakingALook.test(normalized) &&
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorAgentLinks.test(normalized)
    )
  );
}

function observedApprovedReviewBotLoginsFromChecks(
  checks: readonly PullRequestCheck[],
  approvedReviewBotLogins: ReadonlySet<string>,
): readonly string[] {
  const successfulCheckNames = new Set(
    checks
      .filter((check) => check.status === "success")
      .map((check) => check.name),
  );

  return [...approvedReviewBotLogins].filter((login) => {
    const statusContexts = APPROVED_REVIEW_BOT_STATUS_CONTEXTS[login];
    return (
      statusContexts !== undefined &&
      statusContexts.some((context) => successfulCheckNames.has(context))
    );
  });
}

function hasPendingApprovedReviewCheck(
  checks: readonly PullRequestCheck[],
  approvedReviewBotLogins: ReadonlySet<string>,
): boolean {
  const pendingCheckNames = new Set(
    checks
      .filter((check) => check.status === "pending")
      .map((check) => check.name),
  );

  return [...approvedReviewBotLogins].some((login) => {
    const statusContexts = APPROVED_REVIEW_BOT_STATUS_CONTEXTS[login];
    return (
      statusContexts !== undefined &&
      statusContexts.some((context) => pendingCheckNames.has(context))
    );
  });
}

export function createLegacyReviewerAppSnapshot(input: {
  reviewBotLogins: readonly string[];
  approvedReviewBotLogins: readonly string[];
  checks: readonly PullRequestCheck[];
  currentHeadIssueComments: readonly {
    readonly id: string;
    readonly authorLogin: string | null;
    readonly body: string;
    readonly createdAt: string;
    readonly url: string;
  }[];
  currentHeadPullRequestReviews: readonly {
    readonly id: string;
    readonly authorLogin: string | null;
    readonly body: string;
    readonly submittedAt: string;
    readonly url: string;
  }[];
  unresolvedReviewThreads: readonly ReviewFeedback[];
}): ReviewerAppSnapshot | null {
  if (
    input.reviewBotLogins.length === 0 &&
    input.approvedReviewBotLogins.length === 0
  ) {
    return null;
  }

  const reviewBotLogins = new Set(
    input.reviewBotLogins.map((login) => login.toLowerCase()),
  );
  const approvedReviewBotLogins = new Set(
    input.approvedReviewBotLogins.map((login) => login.toLowerCase()),
  );
  const actionableFeedback = [
    ...input.unresolvedReviewThreads.filter((feedback) => {
      const authorLogin = feedback.authorLogin;
      return (
        typeof authorLogin === "string" &&
        reviewBotLogins.has(authorLogin.toLowerCase())
      );
    }),
    ...input.currentHeadIssueComments
      .filter((comment) => {
        const authorLogin = comment.authorLogin;
        return (
          typeof authorLogin === "string" &&
          reviewBotLogins.has(authorLogin.toLowerCase()) &&
          isQualifyingApprovedReviewBody(comment.body) &&
          !NON_ACTIONABLE_BOT_COMMENT_MARKERS.greptileSummaryHeading.test(
            comment.body.trim(),
          )
        );
      })
      .map<ReviewFeedback>((comment) => ({
        id: comment.id,
        kind: "issue-comment",
        threadId: null,
        authorLogin: comment.authorLogin,
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
        path: null,
        line: null,
      })),
  ];
  const observedApprovedReviewBotLogins = [
    ...new Set([
      ...input.currentHeadIssueComments
        .filter((comment) => {
          const authorLogin = comment.authorLogin;
          return (
            typeof authorLogin === "string" &&
            approvedReviewBotLogins.has(authorLogin.toLowerCase()) &&
            isQualifyingApprovedReviewBody(comment.body)
          );
        })
        .map((comment) => comment.authorLogin!.toLowerCase()),
      ...input.currentHeadPullRequestReviews
        .filter((review) => {
          const authorLogin = review.authorLogin;
          return (
            typeof authorLogin === "string" &&
            approvedReviewBotLogins.has(authorLogin.toLowerCase()) &&
            isQualifyingApprovedReviewBody(review.body)
          );
        })
        .map((review) => review.authorLogin!.toLowerCase()),
      ...observedApprovedReviewBotLoginsFromChecks(
        input.checks,
        approvedReviewBotLogins,
      ),
    ]),
  ];
  const hasPendingApprovedReview =
    approvedReviewBotLogins.size > 0 &&
    hasPendingApprovedReviewCheck(input.checks, approvedReviewBotLogins);
  const coverage =
    observedApprovedReviewBotLogins.length > 0 || actionableFeedback.length > 0
      ? "observed"
      : "missing";
  const status = hasPendingApprovedReview
    ? "running"
    : coverage === "observed"
      ? "completed"
      : "unknown";
  const verdict =
    actionableFeedback.length > 0
      ? "issues-found"
      : observedApprovedReviewBotLogins.length > 0
        ? "pass"
        : "unknown";

  return {
    reviewerKey: "legacy-bot-review",
    accepted: reviewBotLogins.size > 0,
    required: approvedReviewBotLogins.size > 0,
    coverage,
    status,
    verdict,
    actionableFeedback,
    unresolvedFeedbackIds: actionableFeedback.map((feedback) => feedback.id),
    evidence: [
      ...actionableFeedback.map((feedback) => ({
        id: feedback.id,
        kind: feedback.kind,
        createdAt: feedback.createdAt,
        url: feedback.url,
        summary: summarizeBody(feedback.body),
      })),
      ...input.checks
        .filter((check) =>
          [...approvedReviewBotLogins].some((login) =>
            (APPROVED_REVIEW_BOT_STATUS_CONTEXTS[login] ?? []).includes(
              check.name,
            ),
          ),
        )
        .map((check) => ({
          id: `check:${check.name}:${check.status}`,
          kind: "check" as const,
          createdAt: null,
          url: check.detailsUrl,
          summary: `${check.name} is ${check.status}`,
        })),
      ...input.currentHeadIssueComments
        .filter((comment) => {
          const authorLogin = comment.authorLogin;
          return (
            typeof authorLogin === "string" &&
            (reviewBotLogins.has(authorLogin.toLowerCase()) ||
              approvedReviewBotLogins.has(authorLogin.toLowerCase()))
          );
        })
        .map((comment) => ({
          id: comment.id,
          kind: "issue-comment" as const,
          createdAt: comment.createdAt,
          url: comment.url,
          summary: summarizeBody(comment.body),
        })),
      ...input.currentHeadPullRequestReviews
        .filter((review) => {
          const authorLogin = review.authorLogin;
          return (
            typeof authorLogin === "string" &&
            approvedReviewBotLogins.has(authorLogin.toLowerCase())
          );
        })
        .map((review) => ({
          id: review.id,
          kind: "pull-request-review" as const,
          createdAt: review.submittedAt,
          url: review.url,
          summary: summarizeBody(review.body),
        })),
    ],
  };
}
