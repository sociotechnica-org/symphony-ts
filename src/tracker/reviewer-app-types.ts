import type { ReviewFeedback } from "../domain/pull-request.js";

export type ReviewerAppCoverage = "missing" | "observed";
export type ReviewerAppStatus = "running" | "completed" | "unknown";
export type ReviewerAppVerdict = "pass" | "issues-found" | "unknown";

export type ReviewerAppEvidenceKind =
  | "check"
  | "issue-comment"
  | "review-thread"
  | "pull-request-review";

export interface ReviewerAppEvidence {
  readonly id: string;
  readonly kind: ReviewerAppEvidenceKind;
  readonly createdAt: string | null;
  readonly url: string | null;
  readonly summary: string;
}

export interface ReviewerAppSnapshot {
  readonly reviewerKey: string;
  readonly accepted: boolean;
  readonly required: boolean;
  readonly coverage: ReviewerAppCoverage;
  readonly status: ReviewerAppStatus;
  readonly verdict: ReviewerAppVerdict;
  readonly actionableFeedback: readonly ReviewFeedback[];
  readonly unresolvedFeedbackIds: readonly string[];
  readonly evidence: readonly ReviewerAppEvidence[];
}
