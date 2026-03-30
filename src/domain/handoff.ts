export type HandoffLifecycleKind =
  | "missing-target"
  | "awaiting-human-handoff"
  | "awaiting-human-review"
  | "awaiting-system-checks"
  | "degraded-review-infrastructure"
  | "awaiting-landing-command"
  | "awaiting-landing"
  | "rework-required"
  | "handoff-ready";

export type PullRequestCheckStatus = "pending" | "success" | "failure";
export type PullRequestReviewerVerdict =
  | "no-blocking-verdict"
  | "blocking-issues-found";
export type PullRequestRequiredReviewerState =
  | "not-required"
  | "running"
  | "missing"
  | "unknown"
  | "satisfied";

export interface PullRequestHandle {
  readonly number: number;
  readonly url: string;
  readonly branchName: string;
  readonly headSha: string | null;
  readonly latestCommitAt: string | null;
}

export interface PullRequestCheck {
  readonly name: string;
  readonly status: PullRequestCheckStatus;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
}

export interface LandingCommandObservation {
  readonly commentId: string;
  readonly authorLogin: string | null;
  readonly observedAt: string;
  readonly url: string;
}

export type ReviewFeedbackKind =
  | "review-thread"
  | "issue-comment"
  | "pull-request-review";

export interface ReviewFeedback {
  readonly id: string;
  readonly kind: ReviewFeedbackKind;
  readonly threadId: string | null;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly path: string | null;
  readonly line: number | null;
}

export interface HandoffLifecycle {
  readonly kind: HandoffLifecycleKind;
  readonly branchName: string;
  readonly pullRequest: PullRequestHandle | null;
  readonly landingCommand?: LandingCommandObservation | null;
  readonly checks: readonly PullRequestCheck[];
  readonly pendingCheckNames: readonly string[];
  readonly failingCheckNames: readonly string[];
  readonly actionableReviewFeedback: readonly ReviewFeedback[];
  readonly unresolvedThreadIds: readonly string[];
  readonly reviewerVerdict: PullRequestReviewerVerdict;
  readonly blockingReviewerKeys: readonly string[];
  readonly requiredReviewerState: PullRequestRequiredReviewerState;
  readonly summary: string;
}
