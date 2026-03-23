import fs from "node:fs/promises";
import path from "node:path";
import {
  renderThirdPartyWorkflowTemplate,
  type StarterRunnerKind,
} from "../templates/third-party-workflow.js";

export interface ScaffoldWorkflowArgs {
  readonly targetPath: string;
  readonly trackerRepo: string;
  readonly runnerKind: StarterRunnerKind;
  readonly force: boolean;
}

export interface ScaffoldWorkflowResult {
  readonly workflowPath: string;
  readonly trackerRepo: string;
  readonly runnerKind: StarterRunnerKind;
  readonly overwritten: boolean;
}

export async function scaffoldWorkflow(
  args: ScaffoldWorkflowArgs,
): Promise<ScaffoldWorkflowResult> {
  const trackerRepo = normalizeTrackerRepo(args.trackerRepo);
  const workflowPath = resolveWorkflowPath(args.targetPath);
  const targetDirectory = path.dirname(workflowPath);
  await ensureWritableTargetDirectory(args.targetPath, targetDirectory);

  const overwritten = await pathExists(workflowPath);
  if (overwritten && !args.force) {
    throw new Error(
      `Refusing to overwrite existing workflow at ${workflowPath}. Re-run with --force to replace it.`,
    );
  }

  const template = renderThirdPartyWorkflowTemplate({
    trackerRepo,
    runnerKind: args.runnerKind,
  });
  await fs.writeFile(workflowPath, template, "utf8");

  return {
    workflowPath,
    trackerRepo,
    runnerKind: args.runnerKind,
    overwritten,
  };
}

export function renderScaffoldWorkflowResult(
  result: ScaffoldWorkflowResult,
): string {
  const quotedWorkflowPath = JSON.stringify(result.workflowPath);
  const action = result.overwritten ? "Updated" : "Created";
  return [
    `${action} ${result.workflowPath}`,
    "",
    "Next steps from the Symphony engine checkout:",
    `- Review and customize ${result.workflowPath} for this repository's policies and prompt contract.`,
    `- Run one cycle: pnpm tsx bin/symphony.ts run --once --workflow ${quotedWorkflowPath} --i-understand-that-this-will-be-running-without-the-usual-guardrails`,
    `- Start the detached runtime: pnpm tsx bin/symphony.ts factory start --workflow ${quotedWorkflowPath}`,
    `- Inspect the detached runtime: pnpm tsx bin/symphony.ts factory status --workflow ${quotedWorkflowPath}`,
    "",
  ].join("\n");
}

function normalizeTrackerRepo(value: string): string {
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
    throw new Error(
      `Expected --tracker-repo <owner/repo>, got ${JSON.stringify(value)}.`,
    );
  }
  return normalized;
}

function resolveWorkflowPath(targetPath: string): string {
  const resolvedTargetPath = path.resolve(targetPath);
  return path.basename(resolvedTargetPath) === "WORKFLOW.md"
    ? resolvedTargetPath
    : path.join(resolvedTargetPath, "WORKFLOW.md");
}

async function ensureWritableTargetDirectory(
  targetPath: string,
  targetDirectory: string,
): Promise<void> {
  const resolvedTargetPath = path.resolve(targetPath);
  if (path.basename(resolvedTargetPath) !== "WORKFLOW.md") {
    let targetStats;
    try {
      targetStats = await fs.stat(resolvedTargetPath);
    } catch (error) {
      throw new Error(
        `Target repository directory does not exist: ${resolvedTargetPath}`,
        { cause: error as Error },
      );
    }
    if (!targetStats.isDirectory()) {
      throw new Error(
        `Expected a target repository directory or WORKFLOW.md path, got file ${resolvedTargetPath}.`,
      );
    }
  }

  try {
    const directoryStats = await fs.stat(targetDirectory);
    if (!directoryStats.isDirectory()) {
      throw new Error(
        `Expected parent directory for ${path.join(targetDirectory, "WORKFLOW.md")} to be a directory.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Target directory does not exist: ${targetDirectory}`, {
        cause: error as Error,
      });
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
