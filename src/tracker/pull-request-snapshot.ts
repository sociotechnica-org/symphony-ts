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
  readonly requiredApprovedReviewSatisfied: boolean;
  readonly observedApprovedReviewBotLogins: readonly string[];
}

function isAfter(left: string, right: string | null): boolean {
  if (right === null) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}

const NON_ACTIONABLE_BOT_COMMENT_MARKERS = {
  // Keep these in sync with the summary comment templates emitted by known bots.
  cursorSummary: "<!-- CURSOR_SUMMARY -->",
  cursorTakingALook: /^Taking a look!\s*/i,
  cursorAgentLinks:
    /cursor\.com\/(agents\/|background-agent\?|assets\/images\/open-in-(web|cursor))/i,
  greptileSummaryHeading: /<h3\b[^>]*>\s*Greptile Summary\s*<\/h3>/i,
} as const;

function isActionableBotReviewComment(body: string): boolean {
  const normalized = body.trim();
  return (
    normalized.length > 0 &&
    !normalized.includes(NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorSummary) &&
    !(
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorTakingALook.test(normalized) &&
      NON_ACTIONABLE_BOT_COMMENT_MARKERS.cursorAgentLinks.test(normalized)
    ) &&
    !NON_ACTIONABLE_BOT_COMMENT_MARKERS.greptileSummaryHeading.test(normalized)
  );
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
  approvedReviewBotLogins?: readonly string[] | undefined;
}): PullRequestSnapshot {
  const latestCommitAt =
    input.reviewState.commits.nodes[0]?.commit.committedDate ?? null;
  const reviewBotLogins = new Set(
    input.reviewBotLogins.map((login) => login.toLowerCase()),
  );
  const approvedReviewBotLogins = new Set(
    (input.approvedReviewBotLogins ?? []).map((login) => login.toLowerCase()),
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
          .filter((comment) => isActionableBotReviewComment(comment.body))
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
  const observedApprovedReviewBotLogins =
    approvedReviewBotLogins.size === 0
      ? []
      : [
          ...new Set(
            [
              ...input.reviewState.comments.nodes
                .filter((comment) => {
                  const authorLogin = comment.author?.login;
                  return (
                    typeof authorLogin === "string" &&
                    approvedReviewBotLogins.has(authorLogin.toLowerCase()) &&
                    isQualifyingApprovedReviewBody(comment.body) &&
                    isAfter(comment.createdAt, latestCommitAt)
                  );
                })
                .map((comment) => comment.author!.login),
              ...input.reviewState.reviewThreads.nodes
                .map((thread) => thread.originComments.nodes[0])
                .filter((comment) => comment !== undefined)
                .filter((comment) => {
                  const authorLogin = comment.author?.login;
                  return (
                    typeof authorLogin === "string" &&
                    approvedReviewBotLogins.has(authorLogin.toLowerCase()) &&
                    isQualifyingApprovedReviewBody(comment.body) &&
                    isAfter(comment.createdAt, latestCommitAt)
                  );
                })
                .map((comment) => comment.author!.login),
            ].map((login) => login.toLowerCase()),
          ),
        ];
  const requiredApprovedReviewSatisfied =
    approvedReviewBotLogins.size === 0 ||
    observedApprovedReviewBotLogins.length > 0;

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
    requiredApprovedReviewSatisfied,
    observedApprovedReviewBotLogins,
  };
}
