import path from "node:path";
import { RunnerError } from "../domain/errors.js";
import { parseLocalRunnerCommand, quoteShellToken } from "./local-command.js";

type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface CodexAppServerCommand {
  readonly launchCommand: string;
  readonly model: string | null;
  readonly approvalPolicy: CodexApprovalPolicy | null;
  readonly sandbox: CodexSandboxMode | null;
  readonly droppedArgs: readonly string[];
}

export function buildCodexAppServerCommand(
  command: string,
): CodexAppServerCommand {
  const parsed = parseLocalRunnerCommand(command);
  if (
    parsed.executable === null ||
    path.basename(parsed.executable) !== "codex" ||
    parsed.executableIndex < 0
  ) {
    throw new RunnerError(
      "Cannot build a Codex app-server command from a non-Codex runner",
    );
  }

  const prefix = parsed.tokens.slice(0, parsed.executableIndex);
  const executable = parsed.tokens[parsed.executableIndex];
  const args = parsed.tokens.slice(parsed.executableIndex + 1);

  if (args[0] !== "exec" && args[0] !== "e") {
    throw new RunnerError(
      "Codex app-server runner requires agent.command to start with 'codex exec'",
    );
  }

  const launchArgs: string[] = ["app-server"];
  const droppedArgs: string[] = [];
  let model: string | null = null;
  let approvalPolicy: CodexApprovalPolicy | null = null;
  let sandbox: CodexSandboxMode | null = null;

  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "-") {
      continue;
    }

    if (token === "-m" || token === "--model") {
      const value = args[index + 1];
      if (isValueToken(value)) {
        model = value;
        index += 1;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length) || null;
      continue;
    }

    if (token === "-a" || token === "--ask-for-approval") {
      const value = args[index + 1];
      if (isApprovalPolicy(value)) {
        approvalPolicy = value;
        index += 1;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }
    if (token.startsWith("--ask-for-approval=")) {
      const value = token.slice("--ask-for-approval=".length);
      if (isApprovalPolicy(value)) {
        approvalPolicy = value;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }

    if (token === "-s" || token === "--sandbox") {
      const value = args[index + 1];
      if (isSandboxMode(value)) {
        sandbox = value;
        index += 1;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }
    if (token.startsWith("--sandbox=")) {
      const value = token.slice("--sandbox=".length);
      if (isSandboxMode(value)) {
        sandbox = value;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }

    if (token === "--dangerously-bypass-approvals-and-sandbox") {
      approvalPolicy = "never";
      sandbox = "danger-full-access";
      continue;
    }
    if (token === "--full-auto") {
      approvalPolicy = "on-request";
      sandbox = "workspace-write";
      continue;
    }

    if (
      token === "-c" ||
      token === "--config" ||
      token === "--enable" ||
      token === "--disable"
    ) {
      const value = args[index + 1];
      if (isValueToken(value)) {
        launchArgs.push(token, value);
        index += 1;
        continue;
      }
      droppedArgs.push(token);
      continue;
    }
    if (
      token.startsWith("--config=") ||
      token.startsWith("--enable=") ||
      token.startsWith("--disable=")
    ) {
      launchArgs.push(token);
      continue;
    }

    if (token === "-C" || token === "--cd") {
      const value = args[index + 1];
      if (isValueToken(value)) {
        droppedArgs.push(token, value);
        index += 1;
      } else {
        droppedArgs.push(token);
      }
      continue;
    }

    droppedArgs.push(token);
  }

  const quoted = [...prefix, executable, ...launchArgs].map((token) =>
    quoteShellToken(token ?? ""),
  );

  return {
    launchCommand: quoted.join(" "),
    model,
    approvalPolicy,
    sandbox,
    droppedArgs,
  };
}

function isValueToken(value: string | undefined): value is string {
  return value !== undefined && value !== "-" && !value.startsWith("-");
}

function isApprovalPolicy(
  value: string | undefined,
): value is CodexApprovalPolicy {
  return (
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
  );
}

function isSandboxMode(value: string | undefined): value is CodexSandboxMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}
