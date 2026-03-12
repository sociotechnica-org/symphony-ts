import path from "node:path";

export interface LocalRunnerBackendDescription {
  readonly provider: string;
  readonly model: string | null;
}

export interface LocalRunnerCommandShape {
  readonly executable: string | null;
  readonly executableIndex: number;
  readonly tokens: readonly string[];
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

export function parseLocalRunnerCommand(
  command: string,
): LocalRunnerCommandShape {
  const tokens = tokenizeShellWords(command);
  const executableIndex = findExecutableIndex(tokens);
  return {
    tokens,
    executableIndex,
    executable: executableIndex < 0 ? null : (tokens[executableIndex] ?? null),
  };
}

function findExecutable(tokens: readonly string[]): string | null {
  const index = findExecutableIndex(tokens);
  return index < 0 ? null : (tokens[index] ?? null);
}

function findExecutableIndex(tokens: readonly string[]): number {
  for (const [index, token] of tokens.entries()) {
    if (!token.includes("=")) {
      return index;
    }
  }
  return -1;
}

function readModelFlag(tokens: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-m" || token === "--model") {
      const value = tokens[index + 1];
      if (value !== undefined && value.length > 0 && !value.startsWith("-")) {
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

export function tokenizeShellWords(command: string): readonly string[] {
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
      if (quote === "'") {
        current += character;
      } else {
        escaping = true;
      }
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

export function quoteShellToken(token: string): string {
  if (token.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(token)) {
    return token;
  }
  return `'${token.replace(/'/gu, `'\"'\"'`)}'`;
}
