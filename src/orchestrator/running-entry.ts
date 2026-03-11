import type { RunUpdateEvent } from "../domain/run.js";

export interface RunningEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly startedAt: Date;
  readonly retryAttempt: number;
  sessionId: string | null;
  turnCount: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  codexLastReportedInputTokens: number;
  codexLastReportedOutputTokens: number;
  codexLastReportedTotalTokens: number;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexMessage: unknown | null;
  lastCodexTimestamp: string | null;
}

export function createRunningEntry(
  issueNumber: number,
  identifier: string,
  retryAttempt: number,
): RunningEntry {
  return {
    issueNumber,
    identifier,
    startedAt: new Date(),
    retryAttempt,
    sessionId: null,
    turnCount: 0,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    codexLastReportedInputTokens: 0,
    codexLastReportedOutputTokens: 0,
    codexLastReportedTotalTokens: 0,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexMessage: null,
    lastCodexTimestamp: null,
  };
}

interface TokenDelta {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function mapValue(
  map: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (
      Object.hasOwn(map, key) &&
      map[key] !== undefined &&
      map[key] !== null
    ) {
      return map[key];
    }
  }
  return undefined;
}

function mapPath(obj: unknown, path: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current =
      record[key] ??
      record[
        key.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase())
      ];
  }
  return current;
}

function extractTokenDelta(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): TokenDelta {
  const inputRaw =
    mapValue(payload, ["input_tokens", "inputTokens"]) ??
    mapPath(payload, ["params", "usage", "inputTokens"]) ??
    mapPath(payload, ["params", "usage", "input_tokens"]) ??
    mapPath(payload, ["usage", "inputTokens"]) ??
    mapPath(payload, ["usage", "input_tokens"]);
  const outputRaw =
    mapValue(payload, ["output_tokens", "outputTokens"]) ??
    mapPath(payload, ["params", "usage", "outputTokens"]) ??
    mapPath(payload, ["params", "usage", "output_tokens"]) ??
    mapPath(payload, ["usage", "outputTokens"]) ??
    mapPath(payload, ["usage", "output_tokens"]);
  const totalRaw =
    mapValue(payload, ["total_tokens", "totalTokens"]) ??
    mapPath(payload, ["params", "usage", "totalTokens"]) ??
    mapPath(payload, ["params", "usage", "total_tokens"]) ??
    mapPath(payload, ["usage", "totalTokens"]) ??
    mapPath(payload, ["usage", "total_tokens"]);

  const reported = {
    input: typeof inputRaw === "number" ? inputRaw : 0,
    output: typeof outputRaw === "number" ? outputRaw : 0,
    total: typeof totalRaw === "number" ? totalRaw : 0,
  };

  if (reported.input === 0 && reported.output === 0 && reported.total === 0) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const delta = {
    inputTokens: Math.max(
      0,
      reported.input - entry.codexLastReportedInputTokens,
    ),
    outputTokens: Math.max(
      0,
      reported.output - entry.codexLastReportedOutputTokens,
    ),
    totalTokens: Math.max(
      0,
      reported.total - entry.codexLastReportedTotalTokens,
    ),
  };
  return delta;
}

function extractSessionId(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): string | null {
  const raw =
    mapValue(payload, ["session_id", "sessionId"]) ??
    mapPath(payload, ["params", "sessionId"]) ??
    mapPath(payload, ["params", "session_id"]);
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  return entry.sessionId;
}

function extractPid(payload: Record<string, unknown>): number | null {
  const raw =
    mapValue(payload, ["pid", "app_server_pid", "appServerPid"]) ??
    mapPath(payload, ["params", "pid"]);
  if (typeof raw === "number" && raw > 0) {
    return raw;
  }
  return null;
}

export interface IntegrateResult {
  readonly tokenDelta: TokenDelta;
}

export function integrateCodexUpdate(
  entry: RunningEntry,
  update: RunUpdateEvent,
): IntegrateResult {
  const payload =
    update.payload !== null &&
    typeof update.payload === "object" &&
    !Array.isArray(update.payload)
      ? (update.payload as Record<string, unknown>)
      : {};

  const prevSessionId = entry.sessionId;
  const newSessionId = extractSessionId(entry, payload);
  const tokenDelta = extractTokenDelta(entry, payload);
  const pid = extractPid(payload);

  if (
    tokenDelta.inputTokens > 0 ||
    tokenDelta.outputTokens > 0 ||
    tokenDelta.totalTokens > 0
  ) {
    entry.codexLastReportedInputTokens += tokenDelta.inputTokens;
    entry.codexLastReportedOutputTokens += tokenDelta.outputTokens;
    entry.codexLastReportedTotalTokens += tokenDelta.totalTokens;
  }

  entry.sessionId = newSessionId;
  entry.lastCodexEvent = update.event;
  entry.lastCodexMessage = update.payload;
  entry.lastCodexTimestamp = update.timestamp;

  if (pid !== null) {
    entry.codexAppServerPid = pid;
  }

  entry.codexInputTokens += tokenDelta.inputTokens;
  entry.codexOutputTokens += tokenDelta.outputTokens;
  entry.codexTotalTokens += tokenDelta.totalTokens;

  if (
    newSessionId !== null &&
    newSessionId !== prevSessionId &&
    (update.event === "codex/event/task_started" ||
      update.event === "thread/started")
  ) {
    entry.turnCount += 1;
  }

  return { tokenDelta };
}
