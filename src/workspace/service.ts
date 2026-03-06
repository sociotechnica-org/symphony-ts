import type {
  PreparedWorkspace,
  WorkspacePreparationRequest,
} from "../domain/workspace.js";

export interface WorkspaceManager {
  prepareWorkspace(
    request: WorkspacePreparationRequest,
  ): Promise<PreparedWorkspace>;
  cleanupWorkspace(workspace: PreparedWorkspace): Promise<void>;
  cleanupWorkspaceForIssue(request: WorkspacePreparationRequest): Promise<void>;
}
