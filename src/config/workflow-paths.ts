import path from "node:path";
import {
  deriveInstanceRootFromWorkflowPath,
  deriveRuntimeInstancePaths,
  type RuntimeInstancePaths,
} from "../domain/workflow.js";
import { readParsedWorkflow } from "./workflow-source.js";
import { coerceOptionalObject, requireString } from "./workflow-validation.js";

export async function loadWorkflowWorkspaceRoot(
  workflowPath: string,
): Promise<string> {
  return (await loadWorkflowInstancePaths(workflowPath)).workspaceRoot;
}

export async function loadWorkflowInstancePaths(
  workflowPath: string,
): Promise<RuntimeInstancePaths> {
  const parsed = await readParsedWorkflow(workflowPath);
  const workspace = coerceOptionalObject(
    parsed.frontMatter.workspace,
    "workspace",
  );
  const resolvedWorkflowPath = path.resolve(workflowPath);
  const instanceRoot = deriveInstanceRootFromWorkflowPath(resolvedWorkflowPath);
  const workspaceRoot = path.resolve(
    instanceRoot,
    requireString(workspace["root"], "workspace.root"),
  );
  return deriveRuntimeInstancePaths({
    workflowPath: resolvedWorkflowPath,
    workspaceRoot,
  });
}
