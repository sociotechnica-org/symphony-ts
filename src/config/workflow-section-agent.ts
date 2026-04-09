import path from "node:path";
import { ConfigError } from "../domain/errors.js";
import type {
  AgentConfig,
  AgentRunnerConfig,
  CodexRemoteExecutionConfig,
  ResolvedConfig,
  SshWorkerHostConfig,
} from "../domain/workflow.js";
import { parseLocalRunnerCommand } from "../runner/local-command.js";
import {
  coerceOptionalObject,
  requireEnum,
  requireNumber,
  requireOptionalString,
  requireString,
  requireStringArray,
} from "./workflow-validation.js";
import { isRemoteExecutionRepoUrl } from "./workflow-section-workspace.js";

const SUPPORTED_AGENT_RUNNER_KINDS = [
  "codex",
  "generic-command",
  "claude-code",
] as const;

type SupportedAgentRunnerKind = (typeof SUPPORTED_AGENT_RUNNER_KINDS)[number];

export function resolveAgentConfig(args: {
  readonly agent: Readonly<Record<string, unknown>>;
  readonly repo: string | undefined;
  readonly workerHosts: Readonly<Record<string, SshWorkerHostConfig>>;
}): AgentConfig {
  const command = requireString(args.agent["command"], "agent.command");
  const resolved = {
    runner: resolveAgentRunnerConfig(args.agent, command, args.workerHosts),
    command,
    promptTransport: requireString(
      args.agent["prompt_transport"],
      "agent.prompt_transport",
    ) as "stdin" | "file",
    timeoutMs: requireNumber(args.agent["timeout_ms"], "agent.timeout_ms"),
    maxTurns:
      args.agent["max_turns"] === undefined
        ? 1
        : requireNumber(args.agent["max_turns"], "agent.max_turns"),
    env: {
      ...Object.fromEntries(
        Object.entries(
          (args.agent["env"] ?? {}) as Record<string, unknown>,
        ).map(([key, value]) => [key, String(value)]),
      ),
      ...(args.repo === undefined ? {} : { GITHUB_REPO: args.repo }),
    },
  };

  validateAgentConfig(resolved);
  return resolved;
}

function validateAgentConfig(resolved: {
  readonly promptTransport: string;
  readonly maxTurns: number;
}): void {
  // Keep section-local validation inside the agent resolver so malformed
  // agent config fails before the top-level config object is assembled.
  if (!["stdin", "file"].includes(resolved.promptTransport)) {
    throw new ConfigError("agent.prompt_transport must be 'stdin' or 'file'");
  }
  if (!Number.isInteger(resolved.maxTurns) || resolved.maxTurns < 1) {
    throw new ConfigError("agent.max_turns must be an integer >= 1");
  }
}

function isSupportedAgentRunnerKind(
  value: string,
): value is SupportedAgentRunnerKind {
  return (SUPPORTED_AGENT_RUNNER_KINDS as readonly string[]).includes(value);
}

function resolveAgentRunnerConfig(
  agent: Readonly<Record<string, unknown>>,
  command: string,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): AgentRunnerConfig {
  const rawRunner = agent["runner"];

  if (rawRunner === undefined) {
    return inferAgentRunnerConfig(command);
  }

  const runner = coerceOptionalObject(rawRunner, "agent.runner");
  const kind = requireString(runner["kind"], "agent.runner.kind");
  if (!isSupportedAgentRunnerKind(kind)) {
    throw new ConfigError(
      `Unsupported agent.runner.kind '${kind}'. Supported kinds: ${SUPPORTED_AGENT_RUNNER_KINDS.join(", ")}`,
    );
  }

  validateExplicitAgentRunnerKind(kind, command);

  switch (kind) {
    case "codex":
      return resolveCodexRunnerConfig(runner, workerHosts);
    case "generic-command":
      return resolveGenericCommandRunnerConfig(runner);
    case "claude-code":
      return { kind: "claude-code" };
    default:
      return exhaustiveAgentRunnerKind(kind);
  }
}

function resolveCodexRunnerConfig(
  runner: Readonly<Record<string, unknown>>,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): AgentRunnerConfig {
  const remoteExecution = resolveCodexRemoteExecutionConfig(
    runner["remote_execution"],
    workerHosts,
  );
  if (remoteExecution === undefined) {
    return { kind: "codex" };
  }
  return {
    kind: "codex",
    remoteExecution,
  };
}

function resolveCodexRemoteExecutionConfig(
  raw: unknown,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): CodexRemoteExecutionConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const remoteExecution = coerceOptionalObject(
    raw,
    "agent.runner.remote_execution",
  );
  const kind = requireEnum(
    remoteExecution["kind"],
    ["ssh"],
    "agent.runner.remote_execution.kind",
  );
  const workerHostNames = resolveRemoteExecutionWorkerHostNames(
    remoteExecution,
    workerHosts,
  );
  return {
    kind,
    workerHostNames,
    workerHosts: workerHostNames.map(
      (workerHostName) => workerHosts[workerHostName]!,
    ),
  };
}

function resolveRemoteExecutionWorkerHostNames(
  remoteExecution: Readonly<Record<string, unknown>>,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): readonly string[] {
  const workerHostNamesRaw = remoteExecution["worker_hosts"];
  const workerHostNameRaw = remoteExecution["worker_host"];
  if (workerHostNamesRaw !== undefined && workerHostNameRaw !== undefined) {
    throw new ConfigError(
      "agent.runner.remote_execution may not define both worker_hosts and worker_host",
    );
  }
  if (workerHostNamesRaw !== undefined) {
    const workerHostNames = requireStringArray(
      workerHostNamesRaw,
      "agent.runner.remote_execution.worker_hosts",
    );
    if (workerHostNames.length === 0) {
      throw new ConfigError(
        "agent.runner.remote_execution.worker_hosts must contain at least one worker host",
      );
    }
    const uniqueWorkerHostNames = [...new Set(workerHostNames)];
    for (const workerHostName of uniqueWorkerHostNames) {
      if (workerHosts[workerHostName] === undefined) {
        throw new ConfigError(
          `agent.runner.remote_execution.worker_hosts contains undefined worker host '${workerHostName}'`,
        );
      }
    }
    return uniqueWorkerHostNames;
  }

  const workerHostName = requireString(
    workerHostNameRaw,
    "agent.runner.remote_execution.worker_host",
  );
  if (workerHosts[workerHostName] === undefined) {
    throw new ConfigError(
      `agent.runner.remote_execution.worker_host '${workerHostName}' is not defined in workspace.worker_hosts`,
    );
  }
  return [workerHostName];
}

function inferAgentRunnerConfig(command: string): AgentRunnerConfig {
  const executable = parseLocalRunnerCommand(command).executable;

  if (executable !== null && path.basename(executable) === "codex") {
    return { kind: "codex" };
  }

  return {
    kind: "generic-command",
  };
}

function resolveGenericCommandRunnerConfig(
  runner: Readonly<Record<string, unknown>>,
): AgentRunnerConfig {
  const provider = requireOptionalString(
    runner["provider"],
    "agent.runner.provider",
  );
  const model = requireOptionalString(runner["model"], "agent.runner.model");

  return {
    kind: "generic-command",
    ...(provider === null ? {} : { provider }),
    ...(model === null ? {} : { model }),
  };
}

function validateExplicitAgentRunnerKind(
  kind: SupportedAgentRunnerKind,
  command: string,
): void {
  const requiredExecutable =
    kind === "codex" ? "codex" : kind === "claude-code" ? "claude" : null;
  if (requiredExecutable === null) {
    return;
  }

  const executable = parseLocalRunnerCommand(command).executable;
  if (executable === null) {
    throw new ConfigError(
      `agent.runner.kind '${kind}' requires agent.command to invoke the ${requiredExecutable} CLI, but no executable could be determined from the command`,
    );
  }

  if (path.basename(executable) === requiredExecutable) {
    return;
  }

  throw new ConfigError(
    `agent.runner.kind '${kind}' requires agent.command to invoke the ${requiredExecutable} CLI`,
  );
}

export function validateRemoteExecutionConfig(config: ResolvedConfig): void {
  if (config.agent.runner.kind !== "codex") {
    return;
  }

  const remoteExecution = config.agent.runner.remoteExecution;
  if (remoteExecution === undefined) {
    return;
  }

  if (!isRemoteExecutionRepoUrl(config.workspace.repoUrl)) {
    throw new ConfigError(
      "workspace.repo_url must be a remote clone URL when agent.runner.remote_execution is enabled",
    );
  }

  if (config.agent.promptTransport !== "stdin") {
    throw new ConfigError(
      "agent.prompt_transport must be 'stdin' for Codex SSH remote execution",
    );
  }
}

function exhaustiveAgentRunnerKind(value: never): never {
  throw new ConfigError(`Unsupported agent.runner.kind '${String(value)}'`);
}
