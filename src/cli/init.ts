import fs from "node:fs/promises";
import path from "node:path";
import {
  renderThirdPartyWorkflowTemplate,
  type StarterRunnerKind,
} from "../templates/third-party-workflow.js";
import { renderThirdPartyOperatorPlaybookTemplate } from "../templates/third-party-operator-playbook.js";

export interface ScaffoldWorkflowArgs {
  readonly targetPath: string;
  readonly trackerRepo: string;
  readonly runnerKind: StarterRunnerKind;
  readonly force: boolean;
}

export interface ScaffoldWorkflowResult {
  readonly workflowPath: string;
  readonly operatorPlaybookPath: string;
  readonly trackerRepo: string;
  readonly runnerKind: StarterRunnerKind;
  readonly workflowOverwritten: boolean;
  readonly operatorPlaybookOverwritten: boolean;
}

export async function scaffoldWorkflow(
  args: ScaffoldWorkflowArgs,
): Promise<ScaffoldWorkflowResult> {
  const trackerRepo = normalizeTrackerRepo(args.trackerRepo);
  const { workflowPath, operatorPlaybookPath, targetDirectory } =
    resolveScaffoldPaths(args.targetPath);
  await ensureWritableTargetDirectory(args.targetPath, targetDirectory);

  const workflowOverwritten = await pathExists(workflowPath);
  const operatorPlaybookOverwritten = await pathExists(operatorPlaybookPath);
  const existingPaths = [
    workflowOverwritten ? workflowPath : null,
    operatorPlaybookOverwritten ? operatorPlaybookPath : null,
  ].filter((value): value is string => value !== null);
  if (existingPaths.length > 0 && !args.force) {
    throw new Error(renderExistingScaffoldConflict(existingPaths));
  }

  const workflowTemplate = renderThirdPartyWorkflowTemplate({
    trackerRepo,
    runnerKind: args.runnerKind,
  });
  const operatorPlaybookTemplate = renderThirdPartyOperatorPlaybookTemplate();
  await fs.writeFile(workflowPath, workflowTemplate, "utf8");
  await fs.writeFile(operatorPlaybookPath, operatorPlaybookTemplate, "utf8");

  return {
    workflowPath,
    operatorPlaybookPath,
    trackerRepo,
    runnerKind: args.runnerKind,
    workflowOverwritten,
    operatorPlaybookOverwritten,
  };
}

export function renderScaffoldWorkflowResult(
  result: ScaffoldWorkflowResult,
): string {
  const quotedWorkflowPath = JSON.stringify(result.workflowPath);
  return [
    `${result.workflowOverwritten ? "Updated" : "Created"} ${result.workflowPath}`,
    `${result.operatorPlaybookOverwritten ? "Updated" : "Created"} ${result.operatorPlaybookPath}`,
    "",
    "Next steps from the Symphony engine checkout:",
    `- Review and customize ${result.workflowPath} for this repository's runtime contract, policies, and prompt contract.`,
    `- Review and customize ${result.operatorPlaybookPath} for this repository's operator policy.`,
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

function resolveScaffoldPaths(targetPath: string): {
  readonly workflowPath: string;
  readonly operatorPlaybookPath: string;
  readonly targetDirectory: string;
} {
  const workflowPath = resolveWorkflowPath(targetPath);
  const targetDirectory = path.dirname(workflowPath);
  return {
    workflowPath,
    operatorPlaybookPath: path.join(targetDirectory, "OPERATOR.md"),
    targetDirectory,
  };
}

function renderExistingScaffoldConflict(
  existingPaths: readonly string[],
): string {
  if (existingPaths.length === 1) {
    return `Refusing to overwrite existing scaffold file at ${existingPaths[0]}. Re-run with --force to replace both WORKFLOW.md and OPERATOR.md.`;
  }
  return `Refusing to overwrite existing scaffold files at ${existingPaths.join(", ")}. Re-run with --force to replace both WORKFLOW.md and OPERATOR.md.`;
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
