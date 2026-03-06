import type { RuntimeIssue } from "../domain/issue.js";
import type { RunResult, RunSession } from "../domain/run.js";

export interface Tracker {
  ensureLabels(): Promise<void>;
  fetchEligibleIssues(): Promise<readonly RuntimeIssue[]>;
  getIssue(issueNumber: number): Promise<RuntimeIssue>;
  claimIssue(issueNumber: number): Promise<RuntimeIssue | null>;
  completeRun(session: RunSession, result: RunResult): Promise<void>;
  releaseIssue(issueNumber: number, reason: string): Promise<void>;
  markIssueFailed(issueNumber: number, reason: string): Promise<void>;
}
