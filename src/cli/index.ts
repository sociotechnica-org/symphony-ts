import path from "node:path";
import { createPromptBuilder, loadWorkflow } from "../config/workflow.js";
import { JsonLogger } from "../observability/logger.js";
import { BootstrapOrchestrator } from "../orchestrator/service.js";
import { LocalRunner } from "../runner/local.js";
import { GitHubBootstrapTracker } from "../tracker/github-bootstrap.js";
import { LocalWorkspaceManager } from "../workspace/local.js";

export interface CliArgs {
  readonly command: "run";
  readonly once: boolean;
  readonly workflowPath: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];
  if (command !== "run") {
    throw new Error("Usage: symphony run [--once] [--workflow <path>]");
  }
  const once = args.includes("--once");
  const workflowIndex = args.findIndex((arg) => arg === "--workflow");
  const workflowPath =
    workflowIndex >= 0 ? args[workflowIndex + 1] : "WORKFLOW.md";
  return {
    command: "run",
    once,
    workflowPath: path.resolve(process.cwd(), workflowPath ?? "WORKFLOW.md"),
  };
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
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
