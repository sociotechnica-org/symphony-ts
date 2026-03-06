import type { RuntimeIssue } from "../domain/issue.js";
import type { PullRequestLifecycle } from "../domain/pull-request.js";

export interface Tracker {
  ensureLabels(): Promise<void>;
  fetchReadyIssues(): Promise<readonly RuntimeIssue[]>;
  fetchRunningIssues(): Promise<readonly RuntimeIssue[]>;
  getIssue(issueNumber: number): Promise<RuntimeIssue>;
  claimIssue(issueNumber: number): Promise<RuntimeIssue | null>;
  inspectIssueHandoff(branchName: string): Promise<PullRequestLifecycle>;
  reconcileSuccessfulRun(
    branchName: string,
    lifecycle: PullRequestLifecycle | null,
  ): Promise<PullRequestLifecycle>;
  recordRetry(issueNumber: number, reason: string): Promise<void>;
  completeIssue(issueNumber: number): Promise<void>;
  markIssueFailed(issueNumber: number, reason: string): Promise<void>;
}
