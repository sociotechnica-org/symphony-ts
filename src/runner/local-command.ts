import path from "node:path";

export interface LocalRunnerBackendDescription {
  readonly provider: string;
  readonly model: string | null;
}

export function describeLocalRunnerBackend(
  command: string,
): LocalRunnerBackendDescription {
  const tokens = tokenizeShellWords(command);
  const executable = findExecutable(tokens);
  if (executable === null) {
    return {
      provider: "local-runner",
      model: null,
    };
  }

  if (path.basename(executable) !== "codex") {
    return {
      provider: "local-runner",
      model: null,
    };
  }

  return {
    provider: "codex",
    model: readModelFlag(tokens),
  };
}

function findExecutable(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (!token.includes("=")) {
      return token;
    }
  }
  return null;
}

function readModelFlag(tokens: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-m" || token === "--model") {
      const value = tokens[index + 1];
      if (value !== undefined && value.length > 0) {
        return value;
      }
      continue;
    }
    if (token.startsWith("--model=")) {
      const value = token.slice("--model=".length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function tokenizeShellWords(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
