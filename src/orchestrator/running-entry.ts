import type { RunUpdateEvent } from "../domain/run.js";
import { getMapKey, mapPath } from "../domain/codex-payload.js";

export type CodexTokenState = "pending" | "observed";

export interface RunningEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly issueState: string;
  readonly startedAt: Date;
  readonly retryAttempt: number;
  sessionId: string | null;
  turnCount: number;
  codexTokenState: CodexTokenState;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  codexLastReportedInputTokens: number;
  codexLastReportedOutputTokens: number;
  codexLastReportedTotalTokens: number;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexMessage: unknown;
  lastCodexTimestamp: string | null;
}

export function createRunningEntry(
  issueNumber: number,
  identifier: string,
  issueState: string,
  retryAttempt: number,
): RunningEntry {
  return {
    issueNumber,
    identifier,
    issueState,
    startedAt: new Date(),
    retryAttempt,
    sessionId: null,
    turnCount: 0,
    codexTokenState: "pending",
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

function extractTokenDelta(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): TokenDelta {
  const inputRaw =
    getMapKey(payload, ["input_tokens", "inputTokens"]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "total_token_usage",
      "input_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "info",
      "total_token_usage",
      "input_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "info",
      "total_token_usage",
      "input_tokens",
    ]) ??
    mapPath(payload, ["params", "usage", "inputTokens"]) ??
    mapPath(payload, ["params", "usage", "input_tokens"]) ??
    mapPath(payload, ["usage", "inputTokens"]) ??
    mapPath(payload, ["usage", "input_tokens"]);
  const outputRaw =
    getMapKey(payload, ["output_tokens", "outputTokens"]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "total_token_usage",
      "output_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "info",
      "total_token_usage",
      "output_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "info",
      "total_token_usage",
      "output_tokens",
    ]) ??
    mapPath(payload, ["params", "usage", "outputTokens"]) ??
    mapPath(payload, ["params", "usage", "output_tokens"]) ??
    mapPath(payload, ["usage", "outputTokens"]) ??
    mapPath(payload, ["usage", "output_tokens"]);
  const totalRaw =
    getMapKey(payload, ["total_tokens", "totalTokens"]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "total_token_usage",
      "total_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "payload",
      "info",
      "total_token_usage",
      "total_tokens",
    ]) ??
    mapPath(payload, [
      "params",
      "msg",
      "info",
      "total_token_usage",
      "total_tokens",
    ]) ??
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

  // Update high-water marks using Math.max so they never decrease.
  // A decrease (API quirk, race) would otherwise lower the baseline and
  // cause the next increase to double-count the difference.
  entry.codexLastReportedInputTokens = Math.max(
    entry.codexLastReportedInputTokens,
    reported.input,
  );
  entry.codexLastReportedOutputTokens = Math.max(
    entry.codexLastReportedOutputTokens,
    reported.output,
  );
  entry.codexLastReportedTotalTokens = Math.max(
    entry.codexLastReportedTotalTokens,
    reported.total,
  );

  return delta;
}

function extractSessionId(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): string | null {
  const raw =
    getMapKey(payload, ["session_id", "sessionId"]) ??
    mapPath(payload, ["params", "sessionId"]) ??
    mapPath(payload, ["params", "session_id"]) ??
    mapPath(payload, ["params", "msg", "payload", "session_id"]) ??
    mapPath(payload, ["params", "msg", "payload", "sessionId"]);
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  return entry.sessionId;
}

function extractPid(payload: Record<string, unknown>): number | null {
  const raw =
    getMapKey(payload, ["pid", "app_server_pid", "appServerPid"]) ??
    mapPath(payload, ["params", "pid"]);
  if (typeof raw === "number" && raw > 0) {
    return raw;
  }
  return null;
}

export interface IntegrateResult {
  readonly tokenDelta: TokenDelta;
}

/**
 * Normalize Codex event names to a canonical slash form.
 *
 * Codex emits events in both `slash/style` and `underscore_style` depending
 * on protocol version. We normalize once at the integration boundary so that
 * all downstream consumers (TUI statusDotColor, humanizeEvent, turn counting)
 * only need to handle the canonical form.
 */
const UNDERSCORE_TO_SLASH: ReadonlyMap<string, string> = new Map([
  ["turn_completed", "turn/completed"],
  ["turn_failed", "turn/failed"],
  ["turn_cancelled", "turn/cancelled"],
  ["session_started", "session/started"],
  ["turn_input_required", "turn/input_required"],
  ["turn_ended_with_error", "turn/ended_with_error"],
  ["startup_failed", "startup/failed"],
]);

export function normalizeEventName(event: string): string {
  return UNDERSCORE_TO_SLASH.get(event) ?? event;
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

  if (newSessionId !== null && newSessionId !== prevSessionId) {
    entry.codexLastReportedInputTokens = 0;
    entry.codexLastReportedOutputTokens = 0;
    entry.codexLastReportedTotalTokens = 0;
  }

  const tokenDelta = extractTokenDelta(entry, payload);
  const pid = extractPid(payload);

  const normalizedEvent = normalizeEventName(update.event);
  entry.sessionId = newSessionId;
  entry.lastCodexEvent = normalizedEvent;
  entry.lastCodexMessage = update.payload;
  entry.lastCodexTimestamp = update.timestamp;

  if (pid !== null) {
    entry.codexAppServerPid = pid;
  }

  entry.codexInputTokens += tokenDelta.inputTokens;
  entry.codexOutputTokens += tokenDelta.outputTokens;
  entry.codexTotalTokens += tokenDelta.totalTokens;
  if (
    tokenDelta.inputTokens > 0 ||
    tokenDelta.outputTokens > 0 ||
    tokenDelta.totalTokens > 0
  ) {
    entry.codexTokenState = "observed";
  }

  if (normalizedEvent === "turn/completed") {
    entry.turnCount += 1;
  }

  return { tokenDelta };
}
