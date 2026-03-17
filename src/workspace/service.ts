import type {
  PreparedWorkspace,
  WorkspaceCleanupResult,
  WorkspacePreparationRequest,
} from "../domain/workspace.js";

export interface WorkspaceManager {
  prepareWorkspace(
    request: WorkspacePreparationRequest,
  ): Promise<PreparedWorkspace>;
  cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<WorkspaceCleanupResult>;
  cleanupWorkspaceForIssue(
    request: WorkspacePreparationRequest,
  ): Promise<WorkspaceCleanupResult>;
}
