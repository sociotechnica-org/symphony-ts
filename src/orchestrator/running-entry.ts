import type { RunUpdateEvent } from "../domain/run.js";
import { getMapKey, mapPath } from "../domain/codex-payload.js";
import {
  createRunnerAccountingSnapshot,
  type RunnerAccountingSnapshot,
  sumIfAllPresent,
} from "../runner/accounting.js";

export type CodexTokenState = "pending" | "observed";

export interface RunningEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly issueState: string;
  readonly startedAt: Date;
  readonly retryAttempt: number;
  sessionId: string | null;
  turnCount: number;
  accounting: RunnerAccountingSnapshot;
  codexTokenState: CodexTokenState;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  accountingCostUsd: number | null;
  codexLastReportedInputTokens: number;
  codexLastReportedOutputTokens: number;
  codexLastReportedTotalTokens: number;
  accountingLastReportedCostUsd: number | null;
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
    accounting: createRunnerAccountingSnapshot(),
    codexTokenState: "pending",
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    accountingCostUsd: null,
    codexLastReportedInputTokens: 0,
    codexLastReportedOutputTokens: 0,
    codexLastReportedTotalTokens: 0,
    accountingLastReportedCostUsd: null,
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
  readonly costUsd: number;
  readonly costObserved: boolean;
}

interface ExtractedAccountingTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asObservedNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function deriveTotalTokens(input: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}): number | null {
  if (input.totalTokens !== null) {
    return input.totalTokens;
  }
  if (input.inputTokens !== null && input.outputTokens !== null) {
    return input.inputTokens + input.outputTokens;
  }
  return null;
}

function sumObservedNumbers(values: readonly (number | null)[]): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === 0
    ? null
    : observed.reduce((sum, value) => sum + value, 0);
}

function readClaudeModelUsageTotals(
  value: unknown,
): ExtractedAccountingTotals | null {
  const modelUsage = asRecord(value);
  if (modelUsage === null) {
    return null;
  }

  const entries = Object.values(modelUsage)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (entries.length === 0) {
    return null;
  }

  const inputTokens = sumObservedNumbers(
    entries.map((entry) =>
      asObservedNumber(
        getMapKey(entry, ["inputTokens", "input_tokens", "prompt_tokens"]),
      ),
    ),
  );
  const outputTokens = sumObservedNumbers(
    entries.map((entry) =>
      asObservedNumber(
        getMapKey(entry, [
          "outputTokens",
          "output_tokens",
          "completion_tokens",
        ]),
      ),
    ),
  );
  const explicitTotalTokens = sumIfAllPresent(
    entries.map((entry) =>
      asObservedNumber(
        getMapKey(entry, ["totalTokens", "total_tokens", "total"]),
      ),
    ),
  );
  const totalTokens = deriveTotalTokens({
    inputTokens,
    outputTokens,
    totalTokens: explicitTotalTokens,
  });
  const costUsd = sumObservedNumbers(
    entries.map((entry) =>
      asObservedNumber(
        getMapKey(entry, [
          "costUsd",
          "cost_usd",
          "totalCostUsd",
          "total_cost_usd",
        ]),
      ),
    ),
  );

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    costUsd === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
  };
}

function extractAccountingTotals(
  payload: Record<string, unknown>,
): ExtractedAccountingTotals {
  const claudeModelUsage =
    readClaudeModelUsageTotals(getMapKey(payload, ["modelUsage"])) ??
    readClaudeModelUsageTotals(mapPath(payload, ["payload", "modelUsage"])) ??
    readClaudeModelUsageTotals(
      mapPath(payload, ["payload", "info", "modelUsage"]),
    ) ??
    readClaudeModelUsageTotals(
      mapPath(payload, ["params", "msg", "payload", "modelUsage"]),
    ) ??
    readClaudeModelUsageTotals(
      mapPath(payload, ["params", "msg", "payload", "info", "modelUsage"]),
    ) ??
    readClaudeModelUsageTotals(
      mapPath(payload, ["params", "msg", "info", "modelUsage"]),
    ) ??
    readClaudeModelUsageTotals(
      mapPath(payload, ["params", "usage", "modelUsage"]),
    ) ??
    readClaudeModelUsageTotals(mapPath(payload, ["usage", "modelUsage"]));

  const inputTokens =
    asObservedNumber(getMapKey(payload, ["input_tokens", "inputTokens"])) ??
    asObservedNumber(
      mapPath(payload, ["payload", "total_token_usage", "input_tokens"]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "payload",
        "info",
        "total_token_usage",
        "input_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "payload",
        "total_token_usage",
        "input_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "payload",
        "info",
        "total_token_usage",
        "input_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "info",
        "total_token_usage",
        "input_tokens",
      ]),
    ) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "inputTokens"])) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "input_tokens"])) ??
    asObservedNumber(mapPath(payload, ["usage", "inputTokens"])) ??
    asObservedNumber(mapPath(payload, ["usage", "input_tokens"])) ??
    claudeModelUsage?.inputTokens ??
    null;
  const outputTokens =
    asObservedNumber(getMapKey(payload, ["output_tokens", "outputTokens"])) ??
    asObservedNumber(
      mapPath(payload, ["payload", "total_token_usage", "output_tokens"]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "payload",
        "info",
        "total_token_usage",
        "output_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "payload",
        "total_token_usage",
        "output_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "payload",
        "info",
        "total_token_usage",
        "output_tokens",
      ]),
    ) ??
    asObservedNumber(
      mapPath(payload, [
        "params",
        "msg",
        "info",
        "total_token_usage",
        "output_tokens",
      ]),
    ) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "outputTokens"])) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "output_tokens"])) ??
    asObservedNumber(mapPath(payload, ["usage", "outputTokens"])) ??
    asObservedNumber(mapPath(payload, ["usage", "output_tokens"])) ??
    claudeModelUsage?.outputTokens ??
    null;
  const totalTokens = deriveTotalTokens({
    inputTokens,
    outputTokens,
    totalTokens:
      asObservedNumber(getMapKey(payload, ["total_tokens", "totalTokens"])) ??
      asObservedNumber(
        mapPath(payload, ["payload", "total_token_usage", "total_tokens"]),
      ) ??
      asObservedNumber(
        mapPath(payload, [
          "payload",
          "info",
          "total_token_usage",
          "total_tokens",
        ]),
      ) ??
      asObservedNumber(
        mapPath(payload, [
          "params",
          "msg",
          "payload",
          "total_token_usage",
          "total_tokens",
        ]),
      ) ??
      asObservedNumber(
        mapPath(payload, [
          "params",
          "msg",
          "payload",
          "info",
          "total_token_usage",
          "total_tokens",
        ]),
      ) ??
      asObservedNumber(
        mapPath(payload, [
          "params",
          "msg",
          "info",
          "total_token_usage",
          "total_tokens",
        ]),
      ) ??
      asObservedNumber(mapPath(payload, ["params", "usage", "totalTokens"])) ??
      asObservedNumber(mapPath(payload, ["params", "usage", "total_tokens"])) ??
      asObservedNumber(mapPath(payload, ["usage", "totalTokens"])) ??
      asObservedNumber(mapPath(payload, ["usage", "total_tokens"])) ??
      claudeModelUsage?.totalTokens ??
      null,
  });
  const costUsd =
    asObservedNumber(
      getMapKey(payload, [
        "cost_usd",
        "costUsd",
        "total_cost_usd",
        "totalCostUsd",
      ]),
    ) ??
    asObservedNumber(mapPath(payload, ["payload", "cost_usd"])) ??
    asObservedNumber(mapPath(payload, ["payload", "costUsd"])) ??
    asObservedNumber(mapPath(payload, ["payload", "info", "cost_usd"])) ??
    asObservedNumber(mapPath(payload, ["payload", "info", "costUsd"])) ??
    asObservedNumber(
      mapPath(payload, ["params", "msg", "payload", "cost_usd"]),
    ) ??
    asObservedNumber(
      mapPath(payload, ["params", "msg", "payload", "costUsd"]),
    ) ??
    asObservedNumber(
      mapPath(payload, ["params", "msg", "payload", "info", "cost_usd"]),
    ) ??
    asObservedNumber(
      mapPath(payload, ["params", "msg", "payload", "info", "costUsd"]),
    ) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "costUsd"])) ??
    asObservedNumber(mapPath(payload, ["params", "usage", "cost_usd"])) ??
    asObservedNumber(mapPath(payload, ["usage", "costUsd"])) ??
    asObservedNumber(mapPath(payload, ["usage", "cost_usd"])) ??
    claudeModelUsage?.costUsd ??
    null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
  };
}

function extractTokenDelta(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): TokenDelta {
  const totals = extractAccountingTotals(payload);
  const reportedInput = totals.inputTokens;
  const reportedOutput = totals.outputTokens;
  const reportedTotal = totals.totalTokens;
  const reportedCost = totals.costUsd;

  if (
    reportedInput === null &&
    reportedOutput === null &&
    reportedTotal === null &&
    reportedCost === null
  ) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      costObserved: false,
    };
  }

  const delta = {
    inputTokens:
      reportedInput === null
        ? 0
        : Math.max(0, reportedInput - entry.codexLastReportedInputTokens),
    outputTokens:
      reportedOutput === null
        ? 0
        : Math.max(0, reportedOutput - entry.codexLastReportedOutputTokens),
    totalTokens:
      reportedTotal === null
        ? 0
        : Math.max(0, reportedTotal - entry.codexLastReportedTotalTokens),
    costUsd:
      reportedCost === null
        ? 0
        : Math.max(
            0,
            reportedCost - (entry.accountingLastReportedCostUsd ?? 0),
          ),
    costObserved: reportedCost !== null,
  };

  // Update high-water marks using Math.max so they never decrease.
  // A decrease (API quirk, race) would otherwise lower the baseline and
  // cause the next increase to double-count the difference.
  if (reportedInput !== null) {
    entry.codexLastReportedInputTokens = Math.max(
      entry.codexLastReportedInputTokens,
      reportedInput,
    );
  }
  if (reportedOutput !== null) {
    entry.codexLastReportedOutputTokens = Math.max(
      entry.codexLastReportedOutputTokens,
      reportedOutput,
    );
  }
  if (reportedTotal !== null) {
    entry.codexLastReportedTotalTokens = Math.max(
      entry.codexLastReportedTotalTokens,
      reportedTotal,
    );
  }
  if (reportedCost !== null) {
    entry.accountingLastReportedCostUsd = Math.max(
      entry.accountingLastReportedCostUsd ?? 0,
      reportedCost,
    );
  }

  return delta;
}

function extractSessionId(
  entry: RunningEntry,
  payload: Record<string, unknown>,
): string | null {
  const raw =
    getMapKey(payload, ["session_id", "sessionId"]) ??
    mapPath(payload, ["payload", "sessionId"]) ??
    mapPath(payload, ["payload", "session_id"]) ??
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
  readonly accounting: RunnerAccountingSnapshot;
}

function hasObservedTokenAccounting(
  accounting: RunnerAccountingSnapshot,
): boolean {
  return (
    accounting.inputTokens !== null ||
    accounting.outputTokens !== null ||
    accounting.totalTokens !== null
  );
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
    entry.accountingLastReportedCostUsd = null;
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
  entry.accountingCostUsd =
    tokenDelta.costObserved || entry.accountingCostUsd !== null
      ? (entry.accountingCostUsd ?? 0) + tokenDelta.costUsd
      : null;
  entry.accounting = createRunnerAccountingSnapshot({
    inputTokens:
      entry.accounting.inputTokens !== null || tokenDelta.inputTokens > 0
        ? entry.codexInputTokens
        : null,
    outputTokens:
      entry.accounting.outputTokens !== null || tokenDelta.outputTokens > 0
        ? entry.codexOutputTokens
        : null,
    totalTokens:
      entry.accounting.totalTokens !== null || tokenDelta.totalTokens > 0
        ? entry.codexTotalTokens
        : null,
    costUsd: entry.accountingCostUsd,
  });
  if (
    tokenDelta.inputTokens > 0 ||
    tokenDelta.outputTokens > 0 ||
    tokenDelta.totalTokens > 0 ||
    hasObservedTokenAccounting(entry.accounting)
  ) {
    entry.codexTokenState = "observed";
  }

  if (normalizedEvent === "turn/completed") {
    entry.turnCount += 1;
  }

  return {
    tokenDelta,
    accounting: entry.accounting,
  };
}
