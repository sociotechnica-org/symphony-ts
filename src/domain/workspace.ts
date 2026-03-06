import type { RuntimeIssue } from "./issue.js";

export interface WorkspacePreparationRequest {
  readonly issue: RuntimeIssue;
}

export interface PreparedWorkspace {
  readonly key: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly path: string;
  readonly branchName: string;
  readonly createdNow: boolean;
}
