import fs from "node:fs/promises";
import * as yaml from "yaml";
import { WorkflowError } from "../domain/errors.js";

export interface RawWorkflow {
  readonly tracker?: Record<string, unknown>;
  readonly polling?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly hooks?: Record<string, unknown>;
  readonly agent?: Record<string, unknown>;
  readonly observability?: Record<string, unknown> | null;
}

export interface ParsedWorkflow {
  readonly frontMatter: RawWorkflow;
  readonly body: string;
}

function parseFrontMatter(raw: string): ParsedWorkflow {
  if (!raw.startsWith("---")) {
    throw new WorkflowError(
      "WORKFLOW.md must start with YAML front matter delimited by ---",
    );
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new WorkflowError("Invalid WORKFLOW.md front matter block");
  }

  const frontMatterSource = match[1];
  const bodySource = match[2];
  if (frontMatterSource === undefined || bodySource === undefined) {
    throw new WorkflowError("Invalid WORKFLOW.md front matter block");
  }

  const parsed = yaml.parse(frontMatterSource);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "WORKFLOW.md front matter must be a mapping/object",
    );
  }

  return {
    frontMatter: parsed as RawWorkflow,
    body: bodySource.trim(),
  };
}

async function readWorkflowSource(workflowPath: string): Promise<string> {
  try {
    return await fs.readFile(workflowPath, "utf8");
  } catch (error) {
    throw new WorkflowError(`Failed to read workflow file at ${workflowPath}`, {
      cause: error as Error,
    });
  }
}

export async function readParsedWorkflow(
  workflowPath: string,
): Promise<ParsedWorkflow> {
  return parseFrontMatter(await readWorkflowSource(workflowPath));
}
