import type { RuntimeIssue } from "./issue.js";

export interface WorkspacePreparationRequest {
  readonly issue: RuntimeIssue;
}

export interface PreparedWorkspace {
  readonly key: string;
  readonly path: string;
  /** Canonical issue branch checked out for the run. */
  readonly branchName: string;
  readonly createdNow: boolean;
}
