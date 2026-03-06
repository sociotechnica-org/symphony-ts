import path from "node:path";
import { createPromptBuilder, loadWorkflow } from "../config/workflow.js";
import { JsonLogger } from "../observability/logger.js";
import {
  deriveStatusFilePath,
  isProcessAlive,
  readFactoryStatusSnapshot,
  renderFactoryStatusSnapshot,
} from "../observability/status.js";
import { BootstrapOrchestrator } from "../orchestrator/service.js";
import { LocalRunner } from "../runner/local.js";
import { GitHubBootstrapTracker } from "../tracker/github-bootstrap.js";
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
      readonly workflowPath: string;
      readonly statusFilePath: string | null;
    };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];
  const workflowIndex = args.findIndex((arg) => arg === "--workflow");
  const workflowPath =
    workflowIndex >= 0 ? args[workflowIndex + 1] : "WORKFLOW.md";
  const resolvedWorkflowPath = path.resolve(
    process.cwd(),
    workflowPath ?? "WORKFLOW.md",
  );

  if (command === "run") {
    return {
      command: "run",
      once: args.includes("--once"),
      workflowPath: resolvedWorkflowPath,
    };
  }

  if (command === "status") {
    const statusFileIndex = args.findIndex((arg) => arg === "--status-file");
    return {
      command: "status",
      format: args.includes("--json") ? "json" : "human",
      workflowPath: resolvedWorkflowPath,
      statusFilePath:
        statusFileIndex >= 0
          ? path.resolve(
              process.cwd(),
              args[statusFileIndex + 1] ?? ".tmp/status.json",
            )
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
    const statusFilePath =
      args.statusFilePath ?? (await resolveStatusFilePath(args.workflowPath));
    let snapshot;
    try {
      snapshot = await readFactoryStatusSnapshot(statusFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(
          `No factory status snapshot found at ${statusFilePath}. Start Symphony with 'symphony run' first.`,
        );
      }
      throw error;
    }
    const output =
      args.format === "json"
        ? `${JSON.stringify(snapshot, null, 2)}\n`
        : `${renderFactoryStatusSnapshot(snapshot, {
            workerAlive: isProcessAlive(snapshot.worker.pid),
            statusFilePath,
          })}\n`;
    process.stdout.write(output);
    return;
  }

  const logger = new JsonLogger();
  const workflow = await loadWorkflow(args.workflowPath);
  const promptBuilder = createPromptBuilder(workflow);
  const tracker = new GitHubBootstrapTracker(workflow.config.tracker, logger);
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

  if (args.once) {
    await orchestrator.runOnce();
    return;
  }

  const abortController = new AbortController();
  process.on("SIGINT", () => abortController.abort());
  process.on("SIGTERM", () => abortController.abort());
  await orchestrator.runLoop(abortController.signal);
}

async function resolveStatusFilePath(workflowPath: string): Promise<string> {
  const workflow = await loadWorkflow(workflowPath);
  return deriveStatusFilePath(workflow.config.workspace.root);
}
