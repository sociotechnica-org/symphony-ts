import type {
  HandoffLifecycleKind,
  PullRequestHandle,
  ReviewFeedbackKind,
} from "./handoff.js";

export interface PromptIssueContext {
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly url: string;
  readonly summary: string;
}

export interface PromptReviewFeedbackContext {
  readonly id: string;
  readonly kind: ReviewFeedbackKind;
  readonly authorLogin: string | null;
  readonly url: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly summary: string;
}

export interface PromptPullRequestContext {
  readonly kind: HandoffLifecycleKind;
  readonly summary: string;
  readonly pullRequest: PullRequestHandle | null;
  readonly pendingCheckNames: readonly string[];
  readonly failingCheckNames: readonly string[];
  readonly actionableReviewFeedback: readonly PromptReviewFeedbackContext[];
}
