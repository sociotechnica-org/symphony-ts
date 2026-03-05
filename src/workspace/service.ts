import type {
  IssueRef,
  WorkspaceConfig,
  WorkspaceInfo,
} from "../domain/types.js";

export interface WorkspaceManager {
  ensureWorkspace(
    issue: IssueRef,
    config: WorkspaceConfig,
    afterCreate: readonly string[],
  ): Promise<WorkspaceInfo>;
  cleanupWorkspace(workspace: WorkspaceInfo): Promise<void>;
}
