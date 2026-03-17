import type { RuntimeIssue } from "./issue.js";

export type RetryClass =
  | "run-failure"
  | "missing-target"
  | "watchdog-abort"
  | "unexpected-orchestrator-failure";

export interface RetryState {
  readonly issue: RuntimeIssue;
  readonly runSequence: number;
  readonly failureRetryAttempt: number;
  readonly nextAttempt: number;
  readonly retryClass: RetryClass;
  readonly scheduledAt: number;
  readonly backoffMs: number;
  readonly dueAt: number;
  readonly lastError: string;
}
