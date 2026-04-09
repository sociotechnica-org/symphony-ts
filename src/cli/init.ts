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
  await publishScaffoldFiles({
    workflowPath,
    workflowTemplate,
    workflowOverwritten,
    operatorPlaybookPath,
    operatorPlaybookTemplate,
    operatorPlaybookOverwritten,
  });

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

async function publishScaffoldFiles(args: {
  readonly workflowPath: string;
  readonly workflowTemplate: string;
  readonly workflowOverwritten: boolean;
  readonly operatorPlaybookPath: string;
  readonly operatorPlaybookTemplate: string;
  readonly operatorPlaybookOverwritten: boolean;
}): Promise<void> {
  const workflowBackup = args.workflowOverwritten
    ? await fs.readFile(args.workflowPath, "utf8")
    : null;
  const operatorPlaybookBackup = args.operatorPlaybookOverwritten
    ? await fs.readFile(args.operatorPlaybookPath, "utf8")
    : null;
  const workflowTempPath = `${args.workflowPath}.tmp-${process.pid}-${Date.now()}`;
  const operatorPlaybookTempPath = `${args.operatorPlaybookPath}.tmp-${process.pid}-${Date.now()}`;

  await fs.writeFile(workflowTempPath, args.workflowTemplate, "utf8");

  try {
    await fs.writeFile(
      operatorPlaybookTempPath,
      args.operatorPlaybookTemplate,
      "utf8",
    );
    await publishScaffoldFileSet({
      workflowPath: args.workflowPath,
      workflowTempPath,
      workflowBackup,
      operatorPlaybookPath: args.operatorPlaybookPath,
      operatorPlaybookTempPath,
      operatorPlaybookBackup,
    });
  } catch (error) {
    await cleanupScaffoldTempFiles([
      workflowTempPath,
      operatorPlaybookTempPath,
    ]);
    throw error;
  }
}

async function publishScaffoldFileSet(args: {
  readonly workflowPath: string;
  readonly workflowTempPath: string;
  readonly workflowBackup: string | null;
  readonly operatorPlaybookPath: string;
  readonly operatorPlaybookTempPath: string;
  readonly operatorPlaybookBackup: string | null;
}): Promise<void> {
  try {
    await fs.rename(args.workflowTempPath, args.workflowPath);
    await fs.rename(args.operatorPlaybookTempPath, args.operatorPlaybookPath);
  } catch (error) {
    await restoreScaffoldFile(args.workflowPath, args.workflowBackup);
    await restoreScaffoldFile(
      args.operatorPlaybookPath,
      args.operatorPlaybookBackup,
    );
    await cleanupScaffoldTempFiles([
      args.workflowTempPath,
      args.operatorPlaybookTempPath,
    ]);
    throw error;
  }
}

async function restoreScaffoldFile(
  filePath: string,
  content: string | null,
): Promise<void> {
  if (content === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, content, "utf8");
}

async function cleanupScaffoldTempFiles(
  tempPaths: readonly string[],
): Promise<void> {
  await Promise.all(
    tempPaths.map(async (tempPath) => {
      await fs.rm(tempPath, { force: true });
    }),
  );
}
