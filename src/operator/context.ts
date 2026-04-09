import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveOperatorLoopConfig,
  type ResolvedOperatorLoopConfig,
} from "../config/operator-loop.js";
import {
  deriveOperatorInstanceCoordinationPaths,
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../domain/instance-identity.js";

export interface OperatorRuntimeContext extends ResolvedOperatorLoopConfig {
  readonly repoRoot: string;
  readonly promptFile: string;
  readonly progressUpdaterPath: string;
  readonly workflowPath: string;
  readonly selectedInstanceRoot: string;
  readonly instanceKey: string;
  readonly detachedSessionName: string;
  readonly operatorStateRoot: string;
  readonly logDir: string;
  readonly lockDir: string;
  readonly lockInfoFile: string;
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
  readonly controlStatePath: string;
  readonly standingContextPath: string;
  readonly wakeUpLogPath: string;
  readonly legacyScratchpadPath: string;
  readonly releaseStatePath: string;
  readonly reportReviewStatePath: string;
  readonly sessionStatePath: string;
  readonly operatorCoordinationRoot: string;
  readonly activeWakeUpLockDir: string;
  readonly activeWakeUpOwnerFile: string;
}

export interface ResolvedOperatorCliArgs {
  readonly repoRoot: string;
  readonly promptFile: string;
  readonly publicArgv: readonly string[];
}

export function parseOperatorLoopCliArgs(
  argv: readonly string[],
): ResolvedOperatorCliArgs {
  const repoRoot = readRequiredOptionValue(argv, "--repo-root");
  const promptFile = readRequiredOptionValue(argv, "--prompt-file");
  const publicArgv: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--repo-root" || token === "--prompt-file") {
      index += 1;
      continue;
    }
    publicArgv.push(token);
  }

  return {
    repoRoot: path.resolve(repoRoot),
    promptFile: path.resolve(promptFile),
    publicArgv,
  };
}

export function resolveOperatorRuntimeContext(args: {
  readonly repoRoot: string;
  readonly promptFile: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): OperatorRuntimeContext {
  const config = resolveOperatorLoopConfig({
    argv: args.argv,
    env: args.env,
  });
  const workflowPath = path.resolve(
    config.workflowPath ?? path.join(args.repoRoot, "WORKFLOW.md"),
  );
  const identity = deriveSymphonyInstanceIdentity(workflowPath);
  const operatorState = deriveOperatorInstanceStatePaths({
    operatorRepoRoot: args.repoRoot,
    instanceKey: identity.instanceKey,
  });
  const coordination = deriveOperatorInstanceCoordinationPaths(workflowPath);
  const progressUpdaterPath = path.resolve(
    args.env.SYMPHONY_OPERATOR_PROGRESS_UPDATER_PATH ??
      path.join(args.repoRoot, "bin", "update-operator-progress.ts"),
  );

  return {
    ...config,
    repoRoot: path.resolve(args.repoRoot),
    promptFile: path.resolve(args.promptFile),
    progressUpdaterPath,
    workflowPath,
    selectedInstanceRoot: identity.instanceRoot,
    instanceKey: identity.instanceKey,
    detachedSessionName: identity.detachedSessionName,
    ...operatorState,
    ...coordination,
  };
}

export async function assertOperatorRuntimeBootstrap(
  context: OperatorRuntimeContext,
): Promise<void> {
  await assertFileExists(
    context.promptFile,
    `operator-loop: prompt file not found: ${context.promptFile}`,
  );
  await assertFileExists(
    context.progressUpdaterPath,
    `operator-loop: operator progress updater not found: ${context.progressUpdaterPath}`,
  );
}

export function renderOperatorLoopUsage(): string {
  return [
    "Usage: operator-loop.sh [--once] [--interval-seconds <seconds>] [--workflow <path>] [--provider <codex|claude|custom>] [--model <name>] [--operator-command <raw command>] [--resume-session|--infinite-session] [--help]",
    "",
    "Environment:",
    "  SYMPHONY_OPERATOR_COMMAND           Command that reads the operator prompt from stdin.",
    "                                      Default: codex exec --dangerously-bypass-approvals-and-sandbox -C . -",
    "                                      Warning: the default bypasses Codex approvals and sandboxing.",
    "  SYMPHONY_OPERATOR_INTERVAL_SECONDS  Sleep interval for continuous mode. Default: 300",
    "  SYMPHONY_OPERATOR_WORKFLOW_PATH     Optional WORKFLOW.md path for the target Symphony instance.",
    "",
    "Examples:",
    "  pnpm operator",
    "  pnpm operator:once",
    "  pnpm operator -- --provider codex --model gpt-5.4-mini",
    "  pnpm operator -- --provider claude",
    "  pnpm operator -- --provider codex --model gpt-5.4-mini --infinite-session",
    "  pnpm operator -- --workflow ../target-repo/WORKFLOW.md",
    "  SYMPHONY_OPERATOR_INTERVAL_SECONDS=60 pnpm operator",
  ].join("\n");
}

async function assertFileExists(
  filePath: string,
  message: string,
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT") {
      throw new Error(message);
    }
    throw error;
  }
}

function readRequiredOptionValue(
  argv: readonly string[],
  option: string,
): string {
  const index = argv.indexOf(option);
  if (index === -1) {
    throw new Error(`Missing required option ${option}`);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}
