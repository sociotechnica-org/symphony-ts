import type { RuntimeIssue } from "./issue.js";

export interface RetryState {
  readonly issue: RuntimeIssue;
  readonly nextAttempt: number;
  readonly dueAt: number;
  readonly lastError: string;
}
