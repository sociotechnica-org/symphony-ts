import fs from "node:fs/promises";
import path from "node:path";
import {
  createPromptBuilder,
  loadWorkflow,
  loadWorkflowWorkspaceRoot,
} from "../config/workflow.js";
import { JsonLogger } from "../observability/logger.js";
import {
  deriveStatusFilePath,
  isProcessAlive,
  parseFactoryStatusSnapshotContent,
  renderFactoryStatusSnapshot,
} from "../observability/status.js";
import { BootstrapOrchestrator } from "../orchestrator/service.js";
import { StatusDashboard } from "../observability/tui.js";
import { LocalRunner } from "../runner/local.js";
import { createTracker } from "../tracker/factory.js";
import { LocalWorkspaceManager } from "../workspace/local.js";

export type CliArgs =
  | {
      readonly command: "run";
      readonly once: boolean;
      readonly workflowPath: string;
    }
  | {
      readonly command: "status";
      readonly format: "human" | "json";
      readonly workflowPath: string | null;
      readonly statusFilePath: string | null;
    };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "run") {
    const workflowPath = readOptionValue(args, "--workflow") ?? "WORKFLOW.md";
    return {
      command: "run",
      once: args.includes("--once"),
      workflowPath: path.resolve(process.cwd(), workflowPath),
    };
  }

  if (command === "status") {
    const statusFilePath = readOptionValue(args, "--status-file");
    const workflowPath =
      statusFilePath === null ? readOptionValue(args, "--workflow") : null;
    return {
      command: "status",
      format: args.includes("--json") ? "json" : "human",
      workflowPath:
        workflowPath === null
          ? null
          : path.resolve(process.cwd(), workflowPath),
      statusFilePath:
        statusFilePath !== null
          ? path.resolve(process.cwd(), statusFilePath)
          : null,
    };
  }

  throw new Error(
    "Usage: symphony <run|status> [--once] [--json] [--workflow <path>] [--status-file <path>]",
  );
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "status") {
    const effectiveWorkflowPath =
      args.workflowPath ?? path.resolve(process.cwd(), "WORKFLOW.md");
    const statusFilePath =
      args.statusFilePath ??
      (await resolveStatusFilePath(effectiveWorkflowPath).catch((error) => {
        throw new Error(
          `Could not determine status file path from workflow at ${effectiveWorkflowPath}. Use --status-file <path> to specify the snapshot location directly.`,
          { cause: error as Error },
        );
      }));
    let snapshot;
    let rawSnapshot = "";
    try {
      rawSnapshot = await fs.readFile(statusFilePath, "utf8");
      snapshot = parseFactoryStatusSnapshotContent(rawSnapshot, statusFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(
          `No factory status snapshot found at ${statusFilePath}. Start Symphony with 'symphony run' first.`,
          { cause: error as Error },
        );
      }
      throw new Error(
        `Failed to read factory status snapshot at ${statusFilePath}. The file may be corrupt; re-running 'symphony run' will regenerate it.`,
        { cause: error as Error },
      );
    }
    const output =
      args.format === "json"
        ? rawSnapshot
        : `${renderFactoryStatusSnapshot(snapshot, {
            workerAlive: isProcessAlive(snapshot.worker.pid),
            statusFilePath,
          })}\n`;
    process.stdout.write(output);
    return;
  }

  if (
    !argv.includes(
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    )
  ) {
    const B = "\x1b[1;31m";
    const R = "\x1b[0m";
    process.stdout.write(
      [
        `${B}╭──────────────────────────────────────────────────────────────╮${R}`,
        `${B}│  ⚠  Symphony is about to run agents on your behalf            │${R}`,
        `${B}│                                                                │${R}`,
        `${B}│  To confirm you understand and wish to proceed, re-run with:  │${R}`,
        `${B}│                                                                │${R}`,
        `${B}│    --i-understand-that-this-will-be-running-without-the-      │${R}`,
        `${B}│    usual-guardrails                                            │${R}`,
        `${B}╰──────────────────────────────────────────────────────────────╯${R}`,
      ].join("\n") + "\n",
    );
    process.exit(1);
  }

  const logger = new JsonLogger();
  const workflow = await loadWorkflow(args.workflowPath);
  const promptBuilder = createPromptBuilder(workflow);
  const tracker = createTracker(workflow.config.tracker, logger);
  const workspace = new LocalWorkspaceManager(
    workflow.config.workspace,
    workflow.config.hooks.afterCreate,
    logger,
  );
  const runner = new LocalRunner(workflow.config.agent, logger);
  const orchestrator = new BootstrapOrchestrator(
    workflow.config,
    promptBuilder,
    tracker,
    workspace,
    runner,
    logger,
  );

  const dashboard = new StatusDashboard(
    () => orchestrator.snapshot(),
    () => workflow.config.observability,
  );
  orchestrator.setDashboardNotify(() => dashboard.refresh());
  dashboard.start();

  if (args.once) {
    try {
      await orchestrator.runOnce();
    } finally {
      dashboard.stop();
    }
    return;
  }

  const abortController = new AbortController();
  const stopDashboard = (): void => {
    dashboard.stop();
    abortController.abort();
  };
  process.on("SIGINT", stopDashboard);
  process.on("SIGTERM", stopDashboard);
  try {
    await orchestrator.runLoop(abortController.signal);
  } finally {
    dashboard.stop();
  }
}

async function resolveStatusFilePath(workflowPath: string): Promise<string> {
  const workspaceRoot = await loadWorkflowWorkspaceRoot(workflowPath);
  return deriveStatusFilePath(workspaceRoot);
}

function readOptionValue(args: readonly string[], flag: string): string | null {
  const index = args.findIndex((arg) => arg === flag);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
