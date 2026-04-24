import type { ReviewFeedback } from "../domain/pull-request.js";
import type { ReviewerAppSnapshot } from "./reviewer-app-types.js";
import type { PullRequestCheck } from "../domain/pull-request.js";
import { createGitHubLoginSet, normalizeGitHubLogin } from "./github-login.js";
import { parseDevinVerdict } from "./reviewer-app-devin.js";

const NON_ACTIONABLE_BOT_COMMENT_MARKERS = {
  cursorSummary: "<!-- CURSOR_SUMMARY -->",
  cursorTakingALook: /^Taking a look!\s*/i,
  cursorAgentLinks:
    /cursor\.com\/(agents\/|background-agent\?|assets\/images\/open-in-(web|cursor))/i,
  greptileSummaryHeading: /<h3\b[^>]*>\s*Greptile Summary\s*<\/h3>/i,
  devinInformationalHeading: /^(?:[^A-Za-z0-9]+\s*)?\*\*Info\b/i,
} as const;

const APPROVED_REVIEW_BOT_STATUS_CONTEXTS: Readonly<
  Record<string, readonly string[]>
> = {
  "devin-ai-integration": ["Devin Review"],
  "greptile-apps": ["Greptile Review"],
  greptile: ["Greptile Review"],
  cursor: ["Cursor Bugbot"],
  bugbot: ["Cursor Bugbot"],
} as const;

function summarizeBody(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

function normalizeBotCommentBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim();
}

function isNonActionableBotBody(
  authorLogin: string | null,
  body: string,
): boolean {
  const raw = body.trim();
  const normalized = normalizeBotCommentBody(body);
  if (
    authorLogin !== null &&
    normalizeGitHubLogin(authorLogin) === "devin-ai-integration" &&
    NON_ACTIONABLE_BOT_COMMENT_MARKERS.devinInformationalHeading.test(
      normalized,
    )
  ) {
    return true;
  }

  return (
    raw.includes(NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorSummary) ||
    (NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorTakingALook.test(normalized) &&
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorAgentLinks.test(normalized)) ||
    NON_ACTIONABLE_BOT_COMMENT_MARKERS.greptileSummaryHeading.test(normalized)
  );
}

function isQualifyingApprovedReviewBody(
  authorLogin: string | null,
  body: string,
): boolean {
  const raw = body.trim();
  const normalized = normalizeBotCommentBody(body);
  return (
    normalized.length > 0 &&
    !raw.includes(NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorSummary) &&
    !(
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorTakingALook.test(normalized) &&
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorAgentLinks.test(normalized)
    ) &&
    !(
      authorLogin !== null &&
      normalizeGitHubLogin(authorLogin) === "devin-ai-integration" &&
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.devinInformationalHeading.test(
        normalized,
      )
    )
  );
}

function isActionableAcceptedBotBody(
  authorLogin: string | null,
  body: string,
): boolean {
  const normalized = normalizeBotCommentBody(body);
  return normalized.length > 0 && !isNonActionableBotBody(authorLogin, body);
}

function parseKnownBotVerdict(
  authorLogin: string,
  body: string,
): "pass" | "issues-found" | "unknown" {
  switch (normalizeGitHubLogin(authorLogin)) {
    case "devin-ai-integration":
      return parseDevinVerdict(body);
    default:
      return "unknown";
  }
}

function createPullRequestReviewFeedback(review: {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly submittedAt: string;
  readonly url: string;
}): ReviewFeedback {
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

  const reviewBotLogins = createGitHubLoginSet(input.reviewBotLogins);
  const approvedReviewBotLogins = createGitHubLoginSet(
    input.approvedReviewBotLogins,
  );
  const acceptedBotLogins = new Set([
    ...reviewBotLogins,
    ...approvedReviewBotLogins,
  ]);
  const accepted = reviewBotLogins.size > 0 || approvedReviewBotLogins.size > 0;
  const actionableFeedback = [
    ...input.unresolvedReviewThreads.filter((feedback) => {
      const authorLogin = feedback.authorLogin;
      return (
        typeof authorLogin === "string" &&
        acceptedBotLogins.has(normalizeGitHubLogin(authorLogin)) &&
        !isNonActionableBotBody(authorLogin, feedback.body)
      );
    }),
    ...input.currentHeadIssueComments
      .filter((comment) => {
        const authorLogin = comment.authorLogin;
        return (
          typeof authorLogin === "string" &&
          acceptedBotLogins.has(normalizeGitHubLogin(authorLogin)) &&
          isActionableAcceptedBotBody(authorLogin, comment.body)
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
    ...input.currentHeadPullRequestReviews
      .filter((review) => {
        const authorLogin = review.authorLogin;
        return (
          typeof authorLogin === "string" &&
          acceptedBotLogins.has(normalizeGitHubLogin(authorLogin)) &&
          parseKnownBotVerdict(authorLogin, review.body) === "issues-found"
        );
      })
      .map(createPullRequestReviewFeedback),
  ];
  const observedApprovedReviewBotLogins = [
    ...new Set([
      ...input.currentHeadIssueComments
        .filter((comment) => {
          const authorLogin = comment.authorLogin;
          return (
            typeof authorLogin === "string" &&
            approvedReviewBotLogins.has(normalizeGitHubLogin(authorLogin)) &&
            isQualifyingApprovedReviewBody(authorLogin, comment.body)
          );
        })
        .map((comment) => normalizeGitHubLogin(comment.authorLogin!)),
      ...input.currentHeadPullRequestReviews
        .filter((review) => {
          const authorLogin = review.authorLogin;
          return (
            typeof authorLogin === "string" &&
            approvedReviewBotLogins.has(normalizeGitHubLogin(authorLogin)) &&
            isQualifyingApprovedReviewBody(authorLogin, review.body)
          );
        })
        .map((review) => normalizeGitHubLogin(review.authorLogin!)),
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
    accepted,
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
            (reviewBotLogins.has(normalizeGitHubLogin(authorLogin)) ||
              approvedReviewBotLogins.has(normalizeGitHubLogin(authorLogin)))
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
            approvedReviewBotLogins.has(normalizeGitHubLogin(authorLogin))
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
