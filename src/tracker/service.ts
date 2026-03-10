import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";

export interface Tracker {
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
  recordRetry(issueNumber: number, reason: string): Promise<void>;
  completeIssue(issueNumber: number): Promise<void>;
  markIssueFailed(issueNumber: number, reason: string): Promise<void>;
}
