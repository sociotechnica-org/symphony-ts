import path from "node:path";
import { RunnerError } from "../domain/errors.js";
import type { AgentConfig } from "../domain/workflow.js";
import { parseLocalRunnerCommand, quoteShellToken } from "./local-command.js";
import type { RunnerSessionDescription } from "./service.js";

interface ParsedClaudeCodeResult {
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly modelCount: number;
}

const CLAUDE_RESULT_OUTPUT_FORMAT = "json";
const CLAUDE_HEADLESS_PERMISSION_FLAGS = [
  "--dangerously-skip-permissions",
  "--permission-mode=bypassPermissions",
] as const;
// Keep this list aligned with Claude flags that consume the next token. If the
// CLI adds new value-taking flags and this set is not updated,
// ensureNoPromptArgument can misclassify the value token as a prompt argument.
const CLAUDE_VALUE_FLAGS = new Set([
  "--model",
  "--output-format",
  "--permission-mode",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--append-system-prompt",
  "--allowed-tools",
  "--allowedTools",
  "--disallowed-tools",
  "--disallowedTools",
  "--tools",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--debug-file",
  "--agent",
  "--session-id",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--add-dir",
  "--mcp-config",
  "--plugin-dir",
  "--betas",
  "--fallback-model",
  "--effort",
  "--file",
]);

export function describeClaudeCodeSession(
  command: string,
): RunnerSessionDescription {
  return {
    provider: "claude-code",
    model: readOptionValue(command, ["--model"]),
    backendSessionId: null,
    backendThreadId: null,
    latestTurnId: null,
    appServerPid: null,
    latestTurnNumber: null,
    logPointers: [],
  };
}

export function validateClaudeCodeConfig(config: AgentConfig): void {
  if (config.runner.kind !== "claude-code") {
    throw new RunnerError(
      `ClaudeCodeRunner requires agent.runner.kind 'claude-code', got '${config.runner.kind}'`,
    );
  }

  if (config.promptTransport !== "stdin") {
    throw new RunnerError(
      "Claude Code runner requires agent.prompt_transport to be 'stdin'",
    );
  }

  const parsed = parseLocalRunnerCommand(config.command);
  if (
    parsed.executable === null ||
    path.basename(parsed.executable) !== "claude"
  ) {
    throw new RunnerError(
      "Claude Code runner requires agent.command to invoke the claude CLI",
    );
  }

  ensureFlag(
    parsed.tokens,
    ["-p", "--print"],
    "Claude Code runner requires agent.command to include --print",
  );
  ensureFlagWithValue(
    parsed.tokens,
    ["--output-format"],
    CLAUDE_RESULT_OUTPUT_FORMAT,
    "Claude Code runner requires agent.command to include --output-format json",
  );
  ensureHeadlessPermissions(parsed.tokens);
  ensureNoPromptArgument(parsed.tokens, parsed.executableIndex);
  ensureNoSessionResumeFlags(parsed.tokens);

  if (
    config.maxTurns > 1 &&
    hasFlag(parsed.tokens, ["--no-session-persistence"])
  ) {
    throw new RunnerError(
      "Claude Code continuation turns require session persistence; remove --no-session-persistence from agent.command",
    );
  }
}

export function buildClaudeResumeCommand(
  command: string,
  sessionId: string,
): string {
  const parsed = parseLocalRunnerCommand(command);
  if (parsed.executable === null) {
    throw new RunnerError(
      "Claude Code continuation turns require a valid claude command",
    );
  }

  const prefix = parsed.tokens
    .slice(0, parsed.executableIndex + 1)
    .map(quoteShellToken);
  const args = stripUnsupportedResumeArgs(
    parsed.tokens.slice(parsed.executableIndex + 1),
  ).map(quoteShellToken);
  return [...prefix, "--resume", quoteShellToken(sessionId), ...args].join(" ");
}

export function parseClaudeCodeResult(stdout: string): ParsedClaudeCodeResult {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new RunnerError(
      "Claude Code runner requires JSON output but stdout was empty",
    );
  }

  let fallbackCandidate: Record<string, unknown> | null = null;
  for (const line of [...lines].reverse()) {
    const parsed = tryParseResultLine(line);
    if (parsed === null) {
      continue;
    }
    if (fallbackCandidate === null) {
      fallbackCandidate = parsed;
    }
    if (parsed["type"] === "result") {
      return toParsedClaudeCodeResult(parsed);
    }
  }

  if (fallbackCandidate !== null) {
    return toParsedClaudeCodeResult(fallbackCandidate);
  }

  throw new RunnerError("Claude Code runner returned malformed JSON output");
}

function toParsedClaudeCodeResult(
  result: Record<string, unknown>,
): ParsedClaudeCodeResult {
  const sessionId =
    typeof result["session_id"] === "string" ? result["session_id"] : null;
  const modelUsage = result["modelUsage"];
  const modelKeys =
    modelUsage !== null &&
    typeof modelUsage === "object" &&
    !Array.isArray(modelUsage)
      ? Object.keys(modelUsage as Record<string, unknown>)
      : [];
  const model = modelKeys[0] ?? null;

  return {
    sessionId,
    model,
    modelCount: modelKeys.length,
  };
}

function ensureFlag(
  tokens: readonly string[],
  flags: readonly string[],
  message: string,
): void {
  if (!hasFlag(tokens, flags)) {
    throw new RunnerError(message);
  }
}

function ensureFlagWithValue(
  tokens: readonly string[],
  flags: readonly string[],
  expectedValue: string,
  message: string,
): void {
  const actualValue = readOptionValueFromTokens(tokens, flags);
  if (actualValue !== expectedValue) {
    throw new RunnerError(message);
  }
}

function ensureHeadlessPermissions(tokens: readonly string[]): void {
  if (
    hasFlag(tokens, CLAUDE_HEADLESS_PERMISSION_FLAGS) ||
    readOptionValueFromTokens(tokens, ["--permission-mode"]) ===
      "bypassPermissions"
  ) {
    return;
  }
  throw new RunnerError(
    "Claude Code runner requires non-interactive permissions; include --permission-mode bypassPermissions or --dangerously-skip-permissions in agent.command",
  );
}

function ensureNoPromptArgument(
  tokens: readonly string[],
  executableIndex: number,
): void {
  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith("-")) {
      index += flagConsumesNextValue(token) ? 1 : 0;
      continue;
    }
    throw new RunnerError(
      "Claude Code runner requires prompts to be delivered by Symphony over stdin; remove prompt arguments from agent.command",
    );
  }
}

function ensureNoSessionResumeFlags(tokens: readonly string[]): void {
  if (hasFlag(tokens, ["--resume", "-r", "--continue", "-c", "--session-id"])) {
    throw new RunnerError(
      "Claude Code runner manages continuation sessions internally; remove --resume, --continue, and --session-id from agent.command",
    );
  }
}

function stripUnsupportedResumeArgs(tokens: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (
      token === "--resume" ||
      token === "-r" ||
      token === "--continue" ||
      token === "-c" ||
      token === "--session-id"
    ) {
      index += flagConsumesNextValue(token) ? 1 : 0;
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}

function hasFlag(tokens: readonly string[], flags: readonly string[]): boolean {
  return tokens.some((token) => {
    if (flags.includes(token)) {
      return true;
    }
    return flags.some((flag) => token.startsWith(`${flag}=`));
  });
}

function readOptionValue(
  command: string,
  flags: readonly string[],
): string | null {
  return readOptionValueFromTokens(
    parseLocalRunnerCommand(command).tokens,
    flags,
  );
}

function readOptionValueFromTokens(
  tokens: readonly string[],
  flags: readonly string[],
): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (flags.includes(token)) {
      const value = tokens[index + 1];
      if (value !== undefined && value.length > 0 && !value.startsWith("-")) {
        return value;
      }
      return null;
    }
    const prefix = flags.find((flag) => token.startsWith(`${flag}=`));
    if (prefix !== undefined) {
      const value = token.slice(prefix.length + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function flagConsumesNextValue(token: string): boolean {
  return CLAUDE_VALUE_FLAGS.has(token);
}

function tryParseResultLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
