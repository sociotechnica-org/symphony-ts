import type { HandoffLifecycle, PullRequestHandle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";

export type LandingBlockedReason =
  | "stale-approved-head"
  | "mergeability-unknown"
  | "pull-request-not-mergeable"
  | "checks-not-green"
  | "review-threads-unresolved"
  | "required-bot-review-missing"
  | "required-reviewer-verdict-unknown"
  | "actionable-review-feedback"
  | "merge-request-refused";

export interface LandingRequestedResult {
  readonly kind: "requested";
  readonly summary: string;
}

export interface LandingBlockedResult {
  readonly kind: "blocked";
  readonly reason: LandingBlockedReason;
  readonly summary: string;
  readonly lifecycleKind:
    | "merged"
    | "awaiting-human-review"
    | "awaiting-system-checks"
    | "degraded-review-infrastructure"
    | "awaiting-landing-command"
    | "awaiting-landing"
    | "rework-required";
}

export type LandingExecutionResult =
  | LandingRequestedResult
  | LandingBlockedResult;

export interface Tracker {
  subject(): string;
  isHumanReviewFeedback(authorLogin: string | null): boolean;
  ensureLabels(): Promise<void>;
  fetchReadyIssues(): Promise<readonly RuntimeIssue[]>;
  fetchRunningIssues(): Promise<readonly RuntimeIssue[]>;
  fetchFailedIssues(): Promise<readonly RuntimeIssue[]>;
  getIssue(issueNumber: number): Promise<RuntimeIssue>;
  claimIssue(issueNumber: number): Promise<RuntimeIssue | null>;
  inspectIssueHandoff(branchName: string): Promise<HandoffLifecycle>;
  reconcileSuccessfulRun(
    branchName: string,
    lifecycle: HandoffLifecycle | null,
  ): Promise<HandoffLifecycle>;
  executeLanding(
    pullRequest: PullRequestHandle,
  ): Promise<LandingExecutionResult>;
  recordRetry(issueNumber: number, reason: string): Promise<void>;
  completeIssue(issueNumber: number): Promise<void>;
  markIssueFailed(issueNumber: number, reason: string): Promise<void>;
}
