import type { WorkflowDefinition } from "../domain/workflow.js";
import { resolveConfig } from "./workflow-resolver.js";
import { readParsedWorkflow } from "./workflow-source.js";

export async function loadWorkflow(
  workflowPath: string,
): Promise<WorkflowDefinition> {
  const parsed = await readParsedWorkflow(workflowPath);
  return {
    config: resolveConfig(parsed.frontMatter, workflowPath),
    promptTemplate: parsed.body,
  };
}
