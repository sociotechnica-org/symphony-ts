import path from "node:path";
import { RunnerError } from "../domain/errors.js";
import { parseLocalRunnerCommand, quoteShellToken } from "./local-command.js";

export function buildCodexResumeCommand(
  command: string,
  sessionId: string,
): {
  readonly command: string;
  readonly droppedArgs: readonly string[];
} {
  const parsed = parseLocalRunnerCommand(command);
  if (
    parsed.executable === null ||
    path.basename(parsed.executable) !== "codex" ||
    parsed.executableIndex < 0
  ) {
    throw new RunnerError(
      "Cannot build a Codex resume command from a non-Codex runner",
    );
  }

  const prefix = parsed.tokens.slice(0, parsed.executableIndex);
  const executable = parsed.tokens[parsed.executableIndex];
  const args = parsed.tokens.slice(parsed.executableIndex + 1);
  const execCommand = args[0];
  if (execCommand !== "exec" && execCommand !== "e") {
    throw new RunnerError(
      "Codex continuation turns require the runner command to start with 'codex exec'",
    );
  }

  const { filteredArgs: forwardedArgs, droppedArgs } = filterCodexResumeArgs(
    args.slice(1),
  );
  const quoted = [
    ...prefix,
    executable,
    "exec",
    "resume",
    ...forwardedArgs,
    sessionId,
    "-",
  ].map((token) => quoteShellToken(token ?? ""));
  return {
    command: quoted.join(" "),
    droppedArgs,
  };
}

/**
 * Forward only the Codex exec arguments that are known to be compatible with
 * `codex exec resume`. Unknown flags are dropped conservatively:
 * - known switches are forwarded unchanged
 * - known value-consuming flags are forwarded as flag/value pairs
 * - exec-only flags such as `-C` are dropped as flag/value pairs because the
 *   resumed command already runs in the prepared workspace
 * - unknown flags consume their following token as a pair when it looks like a
 *   value-bearing argument, so continuation command reconstruction cannot leak
 *   a stray value token into the resumed command
 * - the stdin sentinel `-` is always rebuilt at the end because `resume`
 *   expects `codex exec resume <session-id> -`
 */
function filterCodexResumeArgs(args: readonly string[]): {
  readonly filteredArgs: readonly string[];
  readonly droppedArgs: readonly string[];
} {
  const filteredArgs: string[] = [];
  const droppedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "-") {
      continue;
    }
    if (token === "--json") {
      droppedArgs.push(token);
      continue;
    }
    if (
      token === "-c" ||
      token === "--config" ||
      token === "--enable" ||
      token === "--disable" ||
      token === "-i" ||
      token === "--image" ||
      token === "-m" ||
      token === "--model" ||
      token === "-o" ||
      token === "--output-last-message"
    ) {
      const value = args[index + 1];
      if (value !== undefined && value !== "-" && !value.startsWith("-")) {
        filteredArgs.push(token, value);
        index += 1;
      } else {
        droppedArgs.push(token);
      }
      continue;
    }
    if (token === "-C") {
      const value = args[index + 1];
      if (value !== undefined && value !== "-" && !value.startsWith("-")) {
        droppedArgs.push(token, value);
        index += 1;
      } else {
        droppedArgs.push(token);
      }
      continue;
    }
    if (
      token === "--full-auto" ||
      token === "--dangerously-bypass-approvals-and-sandbox" ||
      token === "--skip-git-repo-check" ||
      token === "--ephemeral"
    ) {
      filteredArgs.push(token);
      continue;
    }
    if (
      token.startsWith("--config=") ||
      token.startsWith("--enable=") ||
      token.startsWith("--disable=") ||
      token.startsWith("--image=") ||
      token.startsWith("--model=") ||
      token.startsWith("--output-last-message=")
    ) {
      filteredArgs.push(token);
      continue;
    }

    if (token.startsWith("-")) {
      const value = args[index + 1];
      if (value !== undefined && value !== "-" && !value.startsWith("-")) {
        droppedArgs.push(token, value);
        index += 1;
        continue;
      }
    }

    droppedArgs.push(token);
  }

  return {
    filteredArgs,
    droppedArgs,
  };
}
