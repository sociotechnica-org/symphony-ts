import fs from "node:fs/promises";
import path from "node:path";
import {
  createPromptBuilder,
  loadWorkflowInstancePaths,
  loadWorkflow,
} from "../config/workflow.js";
import { getCodexRemoteWorkerHosts } from "../domain/workflow.js";
import { JsonLogger } from "../observability/logger.js";
import {
  assessFactoryStatusSnapshot,
  deriveStatusFilePath,
  isProcessAlive,
  parseFactoryStatusSnapshotContent,
  renderFactoryStatusSnapshot,
} from "../observability/status.js";
import { BootstrapOrchestrator } from "../orchestrator/service.js";
import { FsLivenessProbe } from "../orchestrator/liveness-probe.js";
import { StatusDashboard } from "../observability/tui.js";
import { createRunner } from "../runner/factory.js";
import { runStartupPreparation } from "../startup/service.js";
import { isAbortError } from "../support/abort.js";
import { createTracker } from "../tracker/factory.js";
import { createTrackerToolService } from "../tracker/tool-service.js";
import { LocalWorkspaceManager } from "../workspace/local.js";
import { RemoteSshWorkspaceManager } from "../workspace/remote-ssh.js";
import {
  type FactoryControlStatusSnapshot,
  inspectFactoryControl,
  renderFactoryControlStatus,
  startFactory,
  stopFactory,
} from "./factory-control.js";
import { watchFactory } from "./factory-watch.js";
import { scaffoldWorkflow, renderScaffoldWorkflowResult } from "./init.js";
import {
  SUPPORTED_STARTER_RUNNER_KINDS,
  type StarterRunnerKind,
} from "../templates/third-party-workflow.js";

export type CliArgs =
  | {
      readonly command: "init";
      readonly targetPath: string;
      readonly trackerRepo: string;
      readonly runnerKind: StarterRunnerKind;
      readonly force: boolean;
    }
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
    }
  | {
      readonly command: "factory";
      readonly action: "start" | "stop" | "restart";
      readonly format: "human" | "json";
      readonly workflowPath: string | null;
    }
  | {
      readonly command: "factory";
      readonly action: "watch";
      readonly format: "human";
      readonly workflowPath: string | null;
    }
  | {
      readonly command: "factory";
      readonly action: "status";
      readonly format: "human" | "json";
      readonly workflowPath: string | null;
    };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "init") {
    const targetPath = args[1];
    if (targetPath === undefined || targetPath.startsWith("--")) {
      throw new Error(INIT_USAGE);
    }
    const trackerRepo = readOptionValue(args, "--tracker-repo");
    if (trackerRepo === null) {
      throw new Error(
        `${INIT_USAGE}\nMissing required --tracker-repo <owner/repo>.`,
      );
    }
    const runnerKindValue = readOptionValue(args, "--runner") ?? "codex";
    if (
      !SUPPORTED_STARTER_RUNNER_KINDS.includes(
        runnerKindValue as StarterRunnerKind,
      )
    ) {
      throw new Error(
        `${INIT_USAGE}\nUnsupported --runner ${JSON.stringify(
          runnerKindValue,
        )}. Supported values: ${SUPPORTED_STARTER_RUNNER_KINDS.join(", ")}.`,
      );
    }
    return {
      command: "init",
      targetPath: path.resolve(process.cwd(), targetPath),
      trackerRepo,
      runnerKind: runnerKindValue as StarterRunnerKind,
      force: args.includes("--force"),
    };
  }

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

  if (command === "factory") {
    const action = args[1];
    const workflowPath = readOptionValue(args, "--workflow");
    const resolvedWorkflowPath =
      workflowPath === null ? null : path.resolve(process.cwd(), workflowPath);
    if (action === "start" || action === "stop" || action === "restart") {
      return {
        command: "factory",
        action,
        format: args.includes("--json") ? "json" : "human",
        workflowPath: resolvedWorkflowPath,
      };
    }
    if (action === "watch") {
      if (args.includes("--json")) {
        throw new Error("Usage: symphony factory watch [--workflow <path>]");
      }
      return {
        command: "factory",
        action: "watch",
        format: "human",
        workflowPath: resolvedWorkflowPath,
      };
    }
    if (action === "status") {
      return {
        command: "factory",
        action: "status",
        format: args.includes("--json") ? "json" : "human",
        workflowPath: resolvedWorkflowPath,
      };
    }
    throw new Error(
      "Usage: symphony factory <start|stop|restart|status> [--json] [--workflow <path>]\n       symphony factory watch [--workflow <path>]",
    );
  }

  throw new Error(
    "Usage: symphony <init|run|status|factory> [--once] [--json] [--workflow <path>] [--status-file <path>]",
  );
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "init": {
      const result = await scaffoldWorkflow({
        targetPath: args.targetPath,
        trackerRepo: args.trackerRepo,
        runnerKind: args.runnerKind,
        force: args.force,
      });
      process.stdout.write(renderScaffoldWorkflowResult(result));
      return;
    }

    case "factory":
      switch (args.action) {
        case "start": {
          const result = await startFactory({
            workflowPath: args.workflowPath,
          });
          process.stdout.write(
            `Factory ${
              result.kind === "started"
                ? "started"
                : result.kind === "already-running"
                  ? "already running"
                  : result.kind === "startup-failed"
                    ? "start failed during startup"
                    : "start blocked by degraded cleanup"
            }.\n`,
          );
          process.stdout.write(
            renderFactoryControlStatus(result.status, {
              format: args.format,
            }),
          );
          applyFactoryControlExitCode(result.status);
          return;
        }

        case "stop": {
          const result = await stopFactory({
            workflowPath: args.workflowPath,
          });
          process.stdout.write(
            `Factory ${
              result.status.controlState === "degraded"
                ? "stop left the runtime degraded"
                : result.kind === "stopped"
                  ? "stopped"
                  : "already stopped"
            }.\n`,
          );
          if (result.terminatedPids.length > 0) {
            process.stdout.write(
              `Terminated PIDs: ${result.terminatedPids.join(", ")}\n`,
            );
          }
          process.stdout.write(
            renderFactoryControlStatus(result.status, {
              format: args.format,
            }),
          );
          applyFactoryControlExitCode(result.status);
          return;
        }

        case "restart": {
          const stopResult = await stopFactory({
            workflowPath: args.workflowPath,
          });
          if (stopResult.status.controlState === "degraded") {
            process.stdout.write(
              "Factory restart blocked because stop left the runtime degraded.\n",
            );
            if (stopResult.terminatedPids.length > 0) {
              process.stdout.write(
                `Terminated PIDs: ${stopResult.terminatedPids.join(", ")}\n`,
              );
            }
            process.stdout.write(
              renderFactoryControlStatus(stopResult.status, {
                format: args.format,
              }),
            );
            applyFactoryControlExitCode(stopResult.status);
            return;
          }

          const startResult = await startFactory({
            workflowPath: args.workflowPath,
          });
          const verb =
            startResult.kind === "blocked-degraded"
              ? "restart blocked by degraded cleanup"
              : startResult.kind === "startup-failed"
                ? "restart failed during startup"
                : stopResult.kind === "already-stopped" &&
                    startResult.kind === "already-running"
                  ? "was already running"
                  : stopResult.kind === "already-stopped"
                    ? "was already stopped and is now running again"
                    : startResult.kind === "already-running"
                      ? "was stopped but is already running again"
                      : "restarted";
          process.stdout.write(`Factory ${verb}.\n`);
          if (stopResult.terminatedPids.length > 0) {
            process.stdout.write(
              `Terminated PIDs: ${stopResult.terminatedPids.join(", ")}\n`,
            );
          }
          process.stdout.write(
            renderFactoryControlStatus(startResult.status, {
              format: args.format,
            }),
          );
          applyFactoryControlExitCode(startResult.status);
          return;
        }

        case "status": {
          const snapshot = await inspectFactoryControl({
            workflowPath: args.workflowPath,
          });
          process.stdout.write(
            renderFactoryControlStatus(snapshot, {
              format: args.format,
            }),
          );
          applyFactoryControlExitCode(snapshot);
          return;
        }

        case "watch":
          await watchFactory({ workflowPath: args.workflowPath });
          return;
      }
      return;

    case "status": {
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
        snapshot = parseFactoryStatusSnapshotContent(
          rawSnapshot,
          statusFilePath,
        );
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
      const workerAlive = isProcessAlive(snapshot.worker.pid);
      const freshness = assessFactoryStatusSnapshot(snapshot, {
        workerAlive,
      });
      const output =
        args.format === "json"
          ? rawSnapshot
          : `${renderFactoryStatusSnapshot(snapshot, {
              statusFilePath,
              freshness,
            })}\n`;
      process.stdout.write(output);
      return;
    }

    case "run":
      break;
  }

  if (
    !argv.includes(
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    )
  ) {
    const B = process.stdout.isTTY ? "\x1b[1;31m" : "";
    const R = process.stdout.isTTY ? "\x1b[0m" : "";
    process.stdout.write(
      [
        `${B}╭──────────────────────────────────────────────────────────────╮${R}`,
        `${B}│  Symphony is about to run agents on your behalf.             │${R}`,
        `${B}│                                                              │${R}`,
        `${B}│  To confirm you understand and wish to proceed,              │${R}`,
        `${B}│  re-run with the flag:                                       │${R}`,
        `${B}│                                                              │${R}`,
        `${B}│    --i-understand-that-this-will-be-running-                 │${R}`,
        `${B}│    without-the-usual-guardrails                              │${R}`,
        `${B}╰──────────────────────────────────────────────────────────────╯${R}`,
      ].join("\n") + "\n",
    );
    process.exit(1);
  }

  const logger = new JsonLogger();
  const workflow = await loadWorkflow(args.workflowPath);
  const startupController = new AbortController();
  const abortStartup = (): void => {
    startupController.abort();
  };
  process.on("SIGINT", abortStartup);
  process.on("SIGTERM", abortStartup);
  let startup;
  try {
    startup = await runStartupPreparation({
      config: workflow.config,
      logger,
      signal: startupController.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      process.stderr.write("Startup preparation aborted.\n");
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", abortStartup);
    process.off("SIGTERM", abortStartup);
  }
  if (startup.kind === "failed") {
    process.stderr.write(
      `Startup failed before the runtime became healthy: ${startup.summary}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const promptBuilder = createPromptBuilder(workflow);
  const tracker = createTracker(workflow.config.tracker, logger);
  const remoteWorkerHosts = getCodexRemoteWorkerHosts(workflow.config);
  const remoteWorkerHostEntries = Object.fromEntries(
    remoteWorkerHosts.map(
      (workerHost) => [workerHost.name, workerHost] as const,
    ),
  );
  const workspace =
    remoteWorkerHosts.length === 0
      ? new LocalWorkspaceManager(
          workflow.config.workspace,
          workflow.config.hooks.afterCreate,
          logger,
          startup.workspaceSourceOverride,
        )
      : new RemoteSshWorkspaceManager(
          workflow.config.workspace,
          remoteWorkerHostEntries,
          workflow.config.hooks.afterCreate,
          logger,
          startup.workspaceSourceOverride,
        );
  const runner = createRunner(workflow.config.agent, logger, {
    remoteWorkerHosts: remoteWorkerHostEntries,
    trackerToolService: createTrackerToolService(
      tracker,
      workflow.config.tracker,
    ),
  });
  const livenessProbe =
    workflow.config.polling.watchdog?.enabled === true
      ? new FsLivenessProbe(workflow.config.workspace.root)
      : undefined;
  const orchestrator = new BootstrapOrchestrator(
    workflow.config,
    promptBuilder,
    tracker,
    workspace,
    runner,
    logger,
    undefined,
    livenessProbe,
    startup.runtimeIdentity,
  );

  const logFile = path.join(workflow.config.workspace.root, "symphony.log");
  const dashboard = new StatusDashboard(
    () => orchestrator.snapshot(),
    () => workflow.config.observability,
    { logFile },
  );
  orchestrator.setDashboardNotify(() => dashboard.refresh());
  dashboard.start();

  if (args.once) {
    const abortOnce = new AbortController();
    const stopOnce = (): void => {
      dashboard.stop();
      abortOnce.abort();
    };
    process.on("SIGINT", stopOnce);
    process.on("SIGTERM", stopOnce);
    try {
      await orchestrator.runOnce(abortOnce.signal);
    } finally {
      process.off("SIGINT", stopOnce);
      process.off("SIGTERM", stopOnce);
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
    process.off("SIGINT", stopDashboard);
    process.off("SIGTERM", stopDashboard);
    dashboard.stop();
  }
}

const INIT_USAGE =
  "Usage: symphony init <target-directory-or-workflow-path> --tracker-repo <owner/repo> [--runner <codex|claude-code|generic-command>] [--force]";

function applyFactoryControlExitCode(
  snapshot: FactoryControlStatusSnapshot,
): void {
  process.exitCode = snapshot.controlState === "degraded" ? 1 : 0;
}

async function resolveStatusFilePath(workflowPath: string): Promise<string> {
  const instance = await loadWorkflowInstancePaths(workflowPath);
  return deriveStatusFilePath(instance);
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
