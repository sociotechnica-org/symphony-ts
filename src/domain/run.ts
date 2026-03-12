import type { RuntimeIssue } from "./issue.js";
import type { PreparedWorkspace } from "./workspace.js";

export interface RunAttempt {
  readonly sequence: number;
}

export interface RunSession {
  readonly id: string;
  readonly issue: RuntimeIssue;
  readonly workspace: PreparedWorkspace;
  readonly prompt: string;
  readonly startedAt: string;
  readonly attempt: RunAttempt;
}

export interface RunTurn {
  readonly prompt: string;
  readonly turnNumber: number;
}
