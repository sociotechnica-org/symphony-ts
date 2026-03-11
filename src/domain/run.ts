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

export interface RunSpawnEvent {
  readonly pid: number;
  readonly spawnedAt: string;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface RunUpdateEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly timestamp: string;
}
