import type { RuntimeIssue } from "./issue.js";
import type { PreparedWorkspace } from "./workspace.js";

export interface RunAttempt {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly sequence: number;
}

export interface RunSession {
  readonly id: string;
  readonly issue: RuntimeIssue;
  readonly workspace: PreparedWorkspace;
  readonly prompt: string;
  readonly attempt: RunAttempt;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}
