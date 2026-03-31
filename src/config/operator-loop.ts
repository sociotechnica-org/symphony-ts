import path from "node:path";
import { describeClaudeCodeSession } from "../runner/claude-code-command.js";
import {
  describeLocalRunnerBackend,
  parseLocalRunnerCommand,
  quoteShellToken,
} from "../runner/local-command.js";

export type OperatorProvider = "codex" | "claude" | "custom";

export type OperatorCommandSource =
  | "default"
  | "environment"
  | "cli-command"
  | "provider-template";

export interface ResolvedOperatorLoopConfig {
  readonly runOnce: boolean;
  readonly intervalSeconds: number;
  readonly workflowPath: string | null;
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
  readonly commandSource: OperatorCommandSource;
  readonly resumeSession: boolean;
}

interface ParsedOperatorLoopArgs {
  readonly runOnce: boolean;
  readonly intervalSeconds: string | null;
  readonly workflowPath: string | null;
  readonly provider: OperatorProvider | null;
  readonly model: string | null;
  readonly operatorCommand: string | null;
  readonly resumeSession: boolean;
}

export function resolveOperatorLoopConfig(args: {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): ResolvedOperatorLoopConfig {
  const parsed = parseOperatorLoopArgs(args.argv);
  const intervalRaw =
    parsed.intervalSeconds ??
    args.env.SYMPHONY_OPERATOR_INTERVAL_SECONDS ??
    "300";
  const intervalSeconds = Number.parseInt(intervalRaw, 10);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("operator-loop: interval must be a positive integer");
  }

  const workflowPath =
    parsed.workflowPath ?? args.env.SYMPHONY_OPERATOR_WORKFLOW_PATH ?? null;
  const environmentOperatorCommand =
    args.env.SYMPHONY_OPERATOR_COMMAND?.trim() || null;

  if (parsed.operatorCommand !== null && parsed.model !== null) {
    throw new Error(
      "operator-loop: --operator-command cannot be combined with --model",
    );
  }
  if (parsed.operatorCommand !== null && parsed.provider !== null) {
    throw new Error(
      "operator-loop: --operator-command cannot be combined with --provider",
    );
  }
  if (parsed.provider === "custom" && parsed.model !== null) {
    throw new Error(
      "operator-loop: --provider custom cannot be combined with --model",
    );
  }

  if (parsed.operatorCommand !== null) {
    const described = describeOperatorCommand(parsed.operatorCommand);
    return {
      runOnce: parsed.runOnce,
      intervalSeconds,
      workflowPath,
      provider: described.provider,
      model: described.model,
      baseCommand: parsed.operatorCommand,
      commandSource: "cli-command",
      resumeSession: parsed.resumeSession,
    };
  }

  if (parsed.provider !== null || parsed.model !== null) {
    if (parsed.provider === "custom") {
      if (environmentOperatorCommand === null) {
        throw new Error(
          "operator-loop: --provider custom requires SYMPHONY_OPERATOR_COMMAND to be set",
        );
      }
      const described = describeOperatorCommand(environmentOperatorCommand);
      return {
        runOnce: parsed.runOnce,
        intervalSeconds,
        workflowPath,
        provider: described.provider,
        model: described.model,
        baseCommand: environmentOperatorCommand,
        commandSource: "environment",
        resumeSession: parsed.resumeSession,
      };
    }

    const provider = parsed.provider ?? "codex";
    return {
      runOnce: parsed.runOnce,
      intervalSeconds,
      workflowPath,
      provider,
      model: parsed.model,
      baseCommand: buildDefaultOperatorCommand(provider, parsed.model),
      commandSource: "provider-template",
      resumeSession: parsed.resumeSession,
    };
  }

  if (environmentOperatorCommand !== null) {
    const described = describeOperatorCommand(environmentOperatorCommand);
    return {
      runOnce: parsed.runOnce,
      intervalSeconds,
      workflowPath,
      provider: described.provider,
      model: described.model,
      baseCommand: environmentOperatorCommand,
      commandSource: "environment",
      resumeSession: parsed.resumeSession,
    };
  }

  return {
    runOnce: parsed.runOnce,
    intervalSeconds,
    workflowPath,
    provider: "codex",
    model: null,
    baseCommand: buildDefaultOperatorCommand("codex", null),
    commandSource: "default",
    resumeSession: parsed.resumeSession,
  };
}

export function buildDefaultOperatorCommand(
  provider: Exclude<OperatorProvider, "custom">,
  model: string | null,
): string {
  if (provider === "codex") {
    const tokens = [
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      ...(model === null ? [] : ["--model", model]),
      "-C",
      ".",
      "-",
    ];
    return tokens.map((token) => quoteShellToken(token)).join(" ");
  }

  const tokens = [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    ...(model === null ? [] : ["--model", model]),
  ];
  return tokens.map((token) => quoteShellToken(token)).join(" ");
}

export function describeOperatorCommand(command: string): {
  readonly provider: OperatorProvider;
  readonly model: string | null;
} {
  const parsed = parseLocalRunnerCommand(command);
  if (parsed.executable === null) {
    return {
      provider: "custom",
      model: null,
    };
  }

  const executable = path.basename(parsed.executable);
  if (executable === "codex") {
    const described = describeLocalRunnerBackend(command);
    return {
      provider: "codex",
      model: described.model,
    };
  }

  if (executable === "claude") {
    const described = describeClaudeCodeSession(command);
    return {
      provider: "claude",
      model: described.model,
    };
  }

  return {
    provider: "custom",
    model: null,
  };
}

function parseOperatorLoopArgs(
  argv: readonly string[],
): ParsedOperatorLoopArgs {
  let runOnce = false;
  let intervalSeconds: string | null = null;
  let workflowPath: string | null = null;
  let provider: OperatorProvider | null = null;
  let model: string | null = null;
  let operatorCommand: string | null = null;
  let resumeSession = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === "--") {
      continue;
    }

    switch (token) {
      case "--once":
        runOnce = true;
        continue;
      case "--interval-seconds":
        intervalSeconds = requireOptionValue(argv, index, token);
        index += 1;
        continue;
      case "--workflow":
        workflowPath = requireOptionValue(argv, index, token);
        index += 1;
        continue;
      case "--provider":
        provider = parseProvider(requireOptionValue(argv, index, token));
        index += 1;
        continue;
      case "--model":
        model = requireOptionValue(argv, index, token);
        index += 1;
        continue;
      case "--operator-command":
        operatorCommand = requireOptionValue(argv, index, token);
        index += 1;
        continue;
      case "--resume-session":
      case "--infinite-session":
        resumeSession = true;
        continue;
      default:
        throw new Error(`operator-loop: unknown argument: ${token}`);
    }
  }

  return {
    runOnce,
    intervalSeconds,
    workflowPath,
    provider,
    model,
    operatorCommand,
    resumeSession,
  };
}

function parseProvider(value: string): OperatorProvider {
  switch (value) {
    case "codex":
    case "claude":
    case "custom":
      return value;
    default:
      throw new Error(
        `operator-loop: --provider must be one of codex, claude, custom; received ${JSON.stringify(value)}`,
      );
  }
}

function requireOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`operator-loop: ${option} requires a value`);
  }
  return value;
}
