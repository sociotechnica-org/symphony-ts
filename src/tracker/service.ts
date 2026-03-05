import type { IssueRef } from "../domain/types.js";

export interface Tracker {
  ensureLabels(): Promise<void>;
  fetchEligibleIssues(): Promise<readonly IssueRef[]>;
  getIssue(issueNumber: number): Promise<IssueRef>;
  claimIssue(issueNumber: number): Promise<IssueRef | null>;
  hasPullRequest(headBranch: string): Promise<boolean>;
  releaseIssue(issueNumber: number, reason: string): Promise<void>;
  markIssueFailed(issueNumber: number, reason: string): Promise<void>;
  completeIssue(issueNumber: number, successComment: string): Promise<void>;
}
