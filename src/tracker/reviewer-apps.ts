import type {
  ReviewFeedback,
  PullRequestCheck,
} from "../domain/pull-request.js";
import type {
  GitHubCompatibleTrackerConfig,
  GitHubReviewerAppConfig,
} from "../domain/workflow.js";
import { devinReviewerAppAdapter } from "./reviewer-app-devin.js";
import { createLegacyReviewerAppSnapshot } from "./reviewer-app-legacy.js";
import type { ReviewerAppSnapshot } from "./reviewer-app-types.js";

export interface CurrentHeadIssueComment {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly authorAssociation: string;
}

export interface CurrentHeadPullRequestReview {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly submittedAt: string;
  readonly url: string;
}

export interface ReviewerAppAdapterInput {
  readonly checks: readonly PullRequestCheck[];
  readonly currentHeadIssueComments: readonly CurrentHeadIssueComment[];
  readonly currentHeadPullRequestReviews: readonly CurrentHeadPullRequestReview[];
  readonly unresolvedReviewThreads: readonly ReviewFeedback[];
}

export interface GitHubReviewerAppAdapter {
  readonly key: string;
  readonly handledLogins: readonly string[];
  evaluate(
    config: GitHubReviewerAppConfig,
    input: ReviewerAppAdapterInput,
  ): ReviewerAppSnapshot;
}

const REVIEWER_APP_ADAPTERS = new Map<string, GitHubReviewerAppAdapter>([
  [devinReviewerAppAdapter.key, devinReviewerAppAdapter],
]);

export type RequiredReviewerState =
  | "not-required"
  | "running"
  | "missing"
  | "unknown"
  | "satisfied";

export function getConfiguredReviewerAppLogins(
  config: Pick<
    GitHubCompatibleTrackerConfig,
    "reviewBotLogins" | "approvedReviewBotLogins" | "reviewerApps"
  >,
): ReadonlySet<string> {
  const logins = new Set<string>();
  for (const login of config.reviewBotLogins) {
    logins.add(login.toLowerCase());
  }
  for (const login of config.approvedReviewBotLogins ?? []) {
    logins.add(login.toLowerCase());
  }
  for (const reviewerApp of config.reviewerApps ?? []) {
    const adapter = REVIEWER_APP_ADAPTERS.get(reviewerApp.key);
    for (const login of adapter?.handledLogins ?? []) {
      logins.add(login.toLowerCase());
    }
  }
  return logins;
}

export function evaluateRequiredReviewerState(
  reviewerApps: readonly ReviewerAppSnapshot[],
): RequiredReviewerState {
  const requiredReviewerApps = reviewerApps.filter(
    (reviewer) => reviewer.required,
  );
  if (requiredReviewerApps.length === 0) {
    return "not-required";
  }
  if (requiredReviewerApps.some((reviewer) => reviewer.status === "running")) {
    return "running";
  }
  if (
    requiredReviewerApps.some((reviewer) => reviewer.coverage === "missing")
  ) {
    return "missing";
  }
  if (requiredReviewerApps.some((reviewer) => reviewer.verdict !== "pass")) {
    return "unknown";
  }
  return "satisfied";
}

export function createReviewerAppSnapshots(input: {
  config: Pick<
    GitHubCompatibleTrackerConfig,
    "reviewBotLogins" | "approvedReviewBotLogins" | "reviewerApps"
  >;
  checks: readonly PullRequestCheck[];
  currentHeadIssueComments: readonly CurrentHeadIssueComment[];
  currentHeadPullRequestReviews: readonly CurrentHeadPullRequestReview[];
  unresolvedReviewThreads: readonly ReviewFeedback[];
}): readonly ReviewerAppSnapshot[] {
  const explicitReviewerApps = input.config.reviewerApps ?? [];
  const handledLogins = new Set<string>();
  const snapshots: ReviewerAppSnapshot[] = [];

  for (const reviewerApp of explicitReviewerApps) {
    const adapter = REVIEWER_APP_ADAPTERS.get(reviewerApp.key);
    if (adapter === undefined) {
      continue;
    }
    for (const login of adapter.handledLogins) {
      handledLogins.add(login.toLowerCase());
    }
    snapshots.push(
      adapter.evaluate(reviewerApp, {
        checks: input.checks,
        currentHeadIssueComments: input.currentHeadIssueComments,
        currentHeadPullRequestReviews: input.currentHeadPullRequestReviews,
        unresolvedReviewThreads: input.unresolvedReviewThreads,
      }),
    );
  }

  const legacySnapshot = createLegacyReviewerAppSnapshot({
    reviewBotLogins: input.config.reviewBotLogins.filter(
      (login) => !handledLogins.has(login.toLowerCase()),
    ),
    approvedReviewBotLogins: (
      input.config.approvedReviewBotLogins ?? []
    ).filter((login) => !handledLogins.has(login.toLowerCase())),
    checks: input.checks,
    currentHeadIssueComments: input.currentHeadIssueComments,
    currentHeadPullRequestReviews: input.currentHeadPullRequestReviews,
    unresolvedReviewThreads: input.unresolvedReviewThreads,
  });

  return legacySnapshot === null ? snapshots : [...snapshots, legacySnapshot];
}
