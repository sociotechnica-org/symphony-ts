/**
 * Pure frame-formatting helpers for the Symphony factory TUI.
 */

import { getKey, getMapKey, mapPath } from "../domain/codex-payload.js";
import type { TuiSnapshot } from "../orchestrator/service.js";
import type { RunnerVisibilitySnapshot } from "../runner/service.js";

// ─── ANSI constants ────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DEFAULT_FOREGROUND = "\x1b[39m";
const RED = "\x1b[1;31m";
const GREEN = "\x1b[1;32m";
const YELLOW = "\x1b[1;33m";
const BLUE = "\x1b[1;34m";
const MAGENTA = "\x1b[1;35m";
const CYAN = BLUE;
const PRIMARY_TEXT = DEFAULT_FOREGROUND;
const SECONDARY_TEXT = DEFAULT_FOREGROUND;
const SEPARATOR_TEXT = BLUE;
const ACCENT_TEXT = BLUE;

function colorize(text: string, code: string): string {
  return `${code}${text}${RESET}`;
}

export function renderOfflineStatusFrame(): string {
  return [
    colorize("╭─ SYMPHONY STATUS", BOLD),
    colorize("│ app_status=offline", RED),
    "╰─",
  ].join("\n");
}

// ─── Column widths ──────────────────────────────────────────────────────────

const ID_WIDTH = 8;
const STATUS_WIDTH = 16;
const ACTIVITY_WIDTH = 18;
const RUNNER_WIDTH = 16;
const TOKENS_WIDTH = 12;
const DETAIL_MIN_WIDTH = 20;
const DEFAULT_TERMINAL_COLUMNS = 115;

// ─── Snapshot formatter ───────────────────────────────────────────────────

export function formatSnapshotContent(
  snapshot: TuiSnapshot | null,
  tps: number,
  terminalColumnsOverride?: number,
  sparkline?: string,
  nowMs?: number,
): string {
  const sparklineSuffix =
    sparkline !== undefined && sparkline !== "" ? ` ${sparkline}` : "";
  if (snapshot === null) {
    return [
      colorize("╭─ SYMPHONY STATUS", BOLD),
      colorize("│ Orchestrator snapshot unavailable", RED),
      colorize("│ Throughput: ", BOLD) +
        colorize(`${formatTps(tps)} tps`, CYAN) +
        sparklineSuffix,
      formatRefreshLine(null, nowMs ?? Date.now()),
      "╰─",
    ]
      .flat()
      .join("\n");
  }

  const {
    trackerKind,
    trackerSubject,
    tickets,
    liveRunCount,
    running,
    retrying,
    codexTotals,
    rateLimits,
    factoryHalt = {
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    },
    dispatchPressure,
    recoveryPosture,
    lastAction,
    polling,
    maxConcurrentRuns,
    maxTurns,
    projectUrl,
  } = snapshot;
  const visibleCodexTotals = resolveVisibleHeaderTotals(codexTotals, running);
  const renderedTickets =
    tickets.length > 0 ? tickets : running.map(legacyRunningEntryToTicket);
  const detailWidth = ticketDetailWidth(terminalColumnsOverride);
  const effectiveNowMs = nowMs ?? Date.now();
  const ticketRows = formatTicketRows(
    renderedTickets,
    detailWidth,
    effectiveNowMs,
    maxTurns,
    trackerKind,
  );
  const ticketsToBackoffSpacer = renderedTickets.length > 0 ? ["│"] : [];
  const backoffRows = formatRetryRows(retrying);
  const recoveryRows = formatRecoveryRows(recoveryPosture);
  const lastActionLine =
    lastAction === null
      ? []
      : [formatLastActionLine(lastAction, effectiveNowMs)];

  const projectLine =
    projectUrl !== null
      ? [colorize("│ Project: ", BOLD) + colorize(projectUrl, CYAN)]
      : [];
  const trackerLine =
    trackerSubject.trim() === ""
      ? []
      : [
          colorize(
            trackerKind === "github" || trackerKind === "github-bootstrap"
              ? "│ Repo: "
              : "│ Tracker: ",
            BOLD,
          ) + colorize(trackerSubject, CYAN),
        ];

  return [
    colorize("╭─ SYMPHONY STATUS", BOLD),
    colorize("│ Tickets: ", BOLD) +
      colorize(String(renderedTickets.length), GREEN) +
      colorize(" active", SECONDARY_TEXT) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize("agents ", BOLD) +
      colorize(String(liveRunCount), GREEN) +
      colorize("/", SEPARATOR_TEXT) +
      colorize(String(maxConcurrentRuns), SECONDARY_TEXT),
    colorize("│ Throughput: ", BOLD) +
      colorize(`${formatTps(tps)} tps`, CYAN) +
      sparklineSuffix,
    colorize("│ Runtime: ", BOLD) +
      colorize(
        formatRuntimeSeconds(visibleCodexTotals.secondsRunning),
        MAGENTA,
      ),
    colorize("│ Factory tokens: ", BOLD) +
      formatHeaderTokens(visibleCodexTotals),
    colorize("│ Rate Limits: ", BOLD) + formatRateLimits(rateLimits),
    colorize("│ Dispatch: ", BOLD) +
      formatDispatchState(factoryHalt, dispatchPressure, effectiveNowMs),
    ...lastActionLine,
    ...trackerLine,
    ...projectLine,
    formatRefreshLine(polling, effectiveNowMs),
    colorize("├─ Recovery posture", BOLD),
    "│",
    ...recoveryRows,
    "│",
    colorize("├─ Tickets", BOLD),
    "│",
    ticketTableHeaderRow(detailWidth),
    ticketTableSeparatorRow(detailWidth),
    ...ticketRows,
    ...ticketsToBackoffSpacer,
    colorize("├─ Backoff queue", BOLD),
    "│",
    ...backoffRows,
    "╰─",
  ]
    .flat()
    .join("\n");
}

function formatRecoveryRows(
  recoveryPosture: TuiSnapshot["recoveryPosture"],
): string[] {
  const rows = [
    "│  " +
      colorize(recoveryPosture.summary.family, ACCENT_TEXT) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize(recoveryPosture.summary.summary, PRIMARY_TEXT),
  ];
  if (recoveryPosture.entries.length === 0) {
    rows.push(
      "│  " + colorize("No issue-level recovery entries", SECONDARY_TEXT),
    );
    return rows;
  }
  for (const entry of recoveryPosture.entries.slice(0, 4)) {
    const issuePrefix =
      entry.issueNumber === null
        ? entry.source
        : `#${entry.issueNumber.toString()} ${entry.issueIdentifier ?? ""}`.trimEnd();
    rows.push(
      "│  " +
        colorize(`[${entry.family}]`, YELLOW) +
        " " +
        colorize(issuePrefix, PRIMARY_TEXT) +
        " " +
        colorize(truncate(entry.summary, 92), PRIMARY_TEXT),
    );
  }
  if (recoveryPosture.entries.length > 4) {
    rows.push(
      "│  " +
        colorize(
          `+${String(recoveryPosture.entries.length - 4)} more recovery entries`,
          SECONDARY_TEXT,
        ),
    );
  }
  return rows;
}

function formatDispatchState(
  factoryHalt: TuiSnapshot["factoryHalt"],
  dispatchPressure: TuiSnapshot["dispatchPressure"],
  nowMs: number,
): string {
  const halt = factoryHalt ?? {
    state: "clear",
    reason: null,
    haltedAt: null,
    source: null,
    actor: null,
    detail: null,
  };
  if (halt.state === "halted") {
    const detail =
      halt.reason === null
        ? "explicit resume required"
        : truncate(halt.reason, 80);
    const pressureSuffix =
      dispatchPressure === null
        ? ""
        : colorize(" | ", SEPARATOR_TEXT) +
          colorize(
            `pressure ${dispatchPressure.retryClass} until ${formatDueIn(
              Date.parse(dispatchPressure.resumeAt) - nowMs,
            )}`,
            YELLOW,
          );
    return (
      colorize("halted", RED) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize(detail, PRIMARY_TEXT) +
      pressureSuffix
    );
  }
  if (halt.state === "degraded") {
    const pressureSuffix =
      dispatchPressure === null
        ? ""
        : colorize(" | ", SEPARATOR_TEXT) +
          colorize(
            `pressure ${dispatchPressure.retryClass} until ${formatDueIn(
              Date.parse(dispatchPressure.resumeAt) - nowMs,
            )}`,
            YELLOW,
          );
    return (
      colorize("halt degraded", RED) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize(
        truncate(halt.detail ?? "unreadable halt state", 80),
        PRIMARY_TEXT,
      ) +
      pressureSuffix
    );
  }
  return formatDispatchPressure(dispatchPressure, nowMs);
}

// ─── Header helpers ───────────────────────────────────────────────────────

function formatRefreshLine(
  polling: TuiSnapshot["polling"] | null,
  nowMs: number,
): string {
  if (polling === null) {
    return colorize("│ Next refresh: ", BOLD) + colorize("n/a", SECONDARY_TEXT);
  }
  if (polling.checkingNow) {
    return colorize("│ Next refresh: ", BOLD) + colorize("checking now…", CYAN);
  }
  const dueInMs = Math.max(0, polling.nextPollAtMs - nowMs);
  const seconds = Math.ceil(dueInMs / 1000);
  return (
    colorize("│ Next refresh: ", BOLD) + colorize(`${String(seconds)}s`, CYAN)
  );
}

function formatRateLimits(rateLimits: TuiSnapshot["rateLimits"]): string {
  if (rateLimits === null) {
    return colorize("unavailable", SECONDARY_TEXT);
  }
  const { limitId, primary, secondary, credits } = rateLimits;
  const idPart = colorize(limitId ?? "unknown", YELLOW);
  const primaryPart = colorize(
    `primary ${formatRateLimitBucket(primary)}`,
    CYAN,
  );
  const secondaryPart = colorize(
    `secondary ${formatRateLimitBucket(secondary)}`,
    CYAN,
  );
  const creditsPart = colorize(credits ?? "credits n/a", GREEN);
  return (
    idPart +
    colorize(" | ", SEPARATOR_TEXT) +
    primaryPart +
    colorize(" | ", SEPARATOR_TEXT) +
    secondaryPart +
    colorize(" | ", SEPARATOR_TEXT) +
    creditsPart
  );
}

function formatRateLimitBucket(
  bucket: {
    readonly used: number;
    readonly limit: number;
    readonly resetInMs: number;
  } | null,
): string {
  if (bucket === null) return "n/a";
  const resetSecs = Math.ceil(bucket.resetInMs / 1000);
  return `${formatCount(bucket.used)}/${formatCount(bucket.limit)} reset ${String(resetSecs)}s`;
}

function formatDispatchPressure(
  dispatchPressure: TuiSnapshot["dispatchPressure"],
  nowMs: number,
): string {
  if (dispatchPressure === null) {
    return colorize("open", GREEN);
  }
  const remainingMs = Math.max(
    0,
    Date.parse(dispatchPressure.resumeAt) - nowMs,
  );
  return (
    colorize(dispatchPressure.retryClass, YELLOW) +
    colorize(" until ", SEPARATOR_TEXT) +
    colorize(formatDueIn(remainingMs), CYAN) +
    colorize(" | ", SEPARATOR_TEXT) +
    colorize(truncate(dispatchPressure.reason, 80), PRIMARY_TEXT)
  );
}

function formatLastActionLine(
  action: NonNullable<TuiSnapshot["lastAction"]>,
  nowMs: number,
): string {
  const issuePart =
    action.issueNumber === null ? "" : ` #${action.issueNumber.toString()}`;
  const line =
    colorize("│ Last action: ", BOLD) +
    colorize(`${action.kind}${issuePart}`, CYAN);
  const elapsedSuffix = formatElapsedActionSuffix(action.at, nowMs);
  const detail = action.summary.trim();
  if (detail === "") {
    return line + elapsedSuffix;
  }
  return (
    line +
    colorize(" | ", SEPARATOR_TEXT) +
    colorize(detail, PRIMARY_TEXT) +
    elapsedSuffix
  );
}

// ─── Ticket table ─────────────────────────────────────────────────────────

function ticketTableHeaderRow(detailWidth: number): string {
  const header = [
    formatCell("ID", ID_WIDTH),
    formatCell("STATUS", STATUS_WIDTH),
    formatCell("AGE / TURN", ACTIVITY_WIDTH),
    formatCell("RUNNER", RUNNER_WIDTH),
    formatCell("TOKENS", TOKENS_WIDTH),
    formatCell("DETAIL", detailWidth),
  ].join(" ");
  return "│   " + colorize(header, ACCENT_TEXT);
}

function ticketTableSeparatorRow(detailWidth: number): string {
  const width =
    ID_WIDTH +
    STATUS_WIDTH +
    ACTIVITY_WIDTH +
    RUNNER_WIDTH +
    TOKENS_WIDTH +
    detailWidth +
    5;
  return "│   " + colorize("─".repeat(width), SEPARATOR_TEXT);
}

function formatTicketRows(
  tickets: readonly TuiSnapshot["tickets"][number][],
  detailWidth: number,
  nowMs: number,
  maxTurns: number,
  trackerKind: TuiSnapshot["trackerKind"],
): string[] {
  if (tickets.length === 0) {
    return ["│  " + colorize("No active tickets", SECONDARY_TEXT), "│"];
  }
  return tickets.map((entry) =>
    formatTicketRow(entry, detailWidth, nowMs, maxTurns, trackerKind),
  );
}

function formatTicketRow(
  entry: TuiSnapshot["tickets"][number],
  detailWidth: number,
  nowMs: number,
  maxTurns: number,
  trackerKind: TuiSnapshot["trackerKind"],
): string {
  const issue = formatCell(shortTicketIdentifier(entry, trackerKind), ID_WIDTH);
  const stage = formatCell(resolveTicketStatusLabel(entry), STATUS_WIDTH);
  const activity = formatCell(
    formatTicketActivity(entry, nowMs, maxTurns),
    ACTIVITY_WIDTH,
  );
  const ageColor = turnBudgetColor(entry, maxTurns);
  const runner = formatCell(formatTicketRunner(entry), RUNNER_WIDTH);
  const tokens = formatCell(formatTicketTokens(entry), TOKENS_WIDTH, "right");
  const detail = formatCell(describeTicketDetail(entry), detailWidth);

  const statusColor = ticketStatusColor(entry);

  return (
    "│ " +
    colorize("●", statusColor) +
    " " +
    colorize(issue, PRIMARY_TEXT) +
    " " +
    colorize(stage, PRIMARY_TEXT) +
    " " +
    colorize(activity, ageColor) +
    " " +
    colorize(runner, ACCENT_TEXT) +
    " " +
    colorize(tokens, MAGENTA) +
    " " +
    colorize(detail, PRIMARY_TEXT)
  );
}

// Event names are normalized to canonical slash form by integrateCodexUpdate,
// so downstream consumers only need to handle one form per event.
function statusDotColor(
  event: string | null,
  visibility: RunnerVisibilitySnapshot | null,
): string {
  if (visibility !== null) {
    switch (visibility.state) {
      case "completed":
        return MAGENTA;
      case "failed":
      case "timed-out":
      case "cancelled":
        return RED;
      case "starting":
        return CYAN;
      case "waiting":
        return YELLOW;
      case "running":
        return BLUE;
      case "idle":
        return SECONDARY_TEXT;
    }
    return unreachableVisibilityState(visibility.state);
  }
  if (event === null || event === "none") return RED;
  if (event === "codex/event/token_count") return YELLOW;
  if (event === "codex/event/task_started") return GREEN;
  if (event === "turn/completed") return MAGENTA;
  return BLUE;
}

function formatHeaderTokens(codexTotals: TuiSnapshot["codexTotals"]): string {
  if (
    codexTotals.pendingRunCount > 0 &&
    codexTotals.inputTokens === 0 &&
    codexTotals.outputTokens === 0 &&
    codexTotals.totalTokens === 0
  ) {
    return (
      colorize("in pending", YELLOW) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize("out pending", YELLOW) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize("total pending", YELLOW) +
      colorize(" | ", SEPARATOR_TEXT) +
      colorize(`${String(codexTotals.pendingRunCount)} pending`, YELLOW)
    );
  }

  const pendingSuffix =
    codexTotals.pendingRunCount > 0
      ? colorize(" | ", SEPARATOR_TEXT) +
        colorize(`${String(codexTotals.pendingRunCount)} pending`, YELLOW)
      : "";

  return (
    colorize(`in ${formatCount(codexTotals.inputTokens)}`, YELLOW) +
    colorize(" | ", SEPARATOR_TEXT) +
    colorize(`out ${formatCount(codexTotals.outputTokens)}`, YELLOW) +
    colorize(" | ", SEPARATOR_TEXT) +
    colorize(`total ${formatCount(codexTotals.totalTokens)}`, YELLOW) +
    pendingSuffix
  );
}

function formatTicketTokens(entry: TuiSnapshot["tickets"][number]): string {
  const liveRun = entry.liveRun;
  if (liveRun !== null) {
    switch (liveRun.codexTokenState) {
      case "pending":
        return "pending";
      case "observed":
        return formatCount(resolveDisplayedLiveRunTokenTotal(liveRun));
      default:
        return unreachableCodexTokenState(liveRun.codexTokenState);
    }
  }

  const totalTokens = resolveDisplayedTokenTotal(entry.runnerAccounting);
  if (totalTokens !== null) {
    return formatCount(totalTokens);
  }
  return "n/a";
}

function resolveDisplayedTokenTotal(
  accounting:
    | {
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly totalTokens: number | null;
      }
    | undefined,
): number | null {
  if (accounting === undefined) {
    return null;
  }
  if (accounting.totalTokens !== null) {
    return accounting.totalTokens;
  }
  if (accounting.inputTokens !== null && accounting.outputTokens !== null) {
    return accounting.inputTokens + accounting.outputTokens;
  }
  return null;
}

function resolveDisplayedLiveRunTokenTotal(
  liveRun: TuiSnapshot["running"][number],
): number {
  if (liveRun.codexTotalTokens > 0) {
    return liveRun.codexTotalTokens;
  }
  if (liveRun.codexInputTokens > 0 || liveRun.codexOutputTokens > 0) {
    return liveRun.codexInputTokens + liveRun.codexOutputTokens;
  }
  return resolveDisplayedTokenTotal(liveRun.accounting) ?? 0;
}

function resolveVisibleHeaderTotals(
  codexTotals: TuiSnapshot["codexTotals"],
  running: readonly TuiSnapshot["running"][number][],
): TuiSnapshot["codexTotals"] {
  if (
    codexTotals.inputTokens > 0 ||
    codexTotals.outputTokens > 0 ||
    codexTotals.totalTokens > 0
  ) {
    return codexTotals;
  }

  const observedRuns = running.filter(
    (entry) => entry.codexTokenState === "observed",
  );
  if (observedRuns.length === 0) {
    return codexTotals;
  }

  return {
    ...codexTotals,
    inputTokens: observedRuns.reduce((sum, entry) => {
      if (entry.codexInputTokens > 0) {
        return sum + entry.codexInputTokens;
      }
      return sum + (entry.accounting?.inputTokens ?? 0);
    }, 0),
    outputTokens: observedRuns.reduce((sum, entry) => {
      if (entry.codexOutputTokens > 0) {
        return sum + entry.codexOutputTokens;
      }
      return sum + (entry.accounting?.outputTokens ?? 0);
    }, 0),
    totalTokens: observedRuns.reduce(
      (sum, entry) => sum + resolveDisplayedLiveRunTokenTotal(entry),
      0,
    ),
  };
}

function unreachableCodexTokenState(state: never): never {
  throw new Error(`Unhandled Codex token state: ${state as string}`);
}

function unreachableVisibilityState(state: never): never {
  throw new Error(`Unhandled runner visibility state: ${state as string}`);
}

// ─── Backoff queue ────────────────────────────────────────────────────────

function formatRetryRows(retrying: TuiSnapshot["retrying"]): string[] {
  if (retrying.length === 0) {
    return ["│  " + colorize("No queued retries", SECONDARY_TEXT)];
  }
  return retrying.map((entry) => {
    const dueStr = formatDueIn(entry.dueInMs);
    const classPart =
      " " + colorize(`class=${entry.retryClass}`, SECONDARY_TEXT);
    const hostPart =
      entry.preferredHost === null
        ? ""
        : " " + colorize(`host=${entry.preferredHost}`, SECONDARY_TEXT);
    const errorPart =
      entry.lastError.trim() !== ""
        ? " " +
          colorize(
            `error=${sanitizeRetryError(entry.lastError)}`,
            SECONDARY_TEXT,
          )
        : "";
    return (
      "│  " +
      colorize("↻", YELLOW) +
      " " +
      colorize(entry.identifier, RED) +
      " " +
      colorize(`attempt=${String(entry.nextAttempt)}`, YELLOW) +
      classPart +
      hostPart +
      colorize(" in ", SEPARATOR_TEXT) +
      colorize(dueStr, CYAN) +
      errorPart
    );
  });
}

function formatDueIn(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${String(secs)}s`;
}

function sanitizeRetryError(error: string): string {
  const cleaned = error
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(cleaned, 96);
}

// ─── Formatting helpers ───────────────────────────────────────────────────

function formatTps(value: number): string {
  return formatCount(Math.floor(value));
}

const intlNumber = new Intl.NumberFormat("en-US");
function formatCount(value: number): string {
  return intlNumber.format(value);
}

function formatRuntimeSeconds(seconds: number): string {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins)}m ${String(secs)}s`;
}

function formatElapsedActionSuffix(
  isoTimestamp: string,
  nowMs: number,
): string {
  const actionAtMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(actionAtMs)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - actionAtMs) / 1000));
  return colorize(
    ` (${formatRuntimeSeconds(elapsedSeconds)} ago)`,
    SECONDARY_TEXT,
  );
}

function formatRuntimeAndTurns(
  seconds: number,
  entry: TuiSnapshot["tickets"][number],
  maxTurns: number,
): string {
  const displayedTurn = resolveDisplayedTurn(entry, maxTurns);
  if (displayedTurn === null) {
    return formatRuntimeSeconds(seconds);
  }
  return `${formatRuntimeSeconds(seconds)} / turn ${displayedTurn.toString()}/${maxTurns.toString()}`;
}

function formatCell(
  value: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const cleaned = value.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const truncated = truncate(cleaned, width);
  return align === "right"
    ? truncated.padStart(width)
    : truncated.padEnd(width);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

function compactSessionId(sessionId: string | null): string {
  if (sessionId === null) return "n/a";
  if (sessionId.length > 10) {
    return sessionId.slice(0, 4) + "..." + sessionId.slice(-6);
  }
  return sessionId;
}

function shortTicketIdentifier(
  entry: TuiSnapshot["tickets"][number],
  trackerKind: TuiSnapshot["trackerKind"],
): string {
  if (trackerKind === "github" || trackerKind === "github-bootstrap") {
    return `#${entry.issueNumber.toString()}`;
  }
  return entry.identifier;
}

function ticketDetailWidth(terminalColumnsOverride?: number): number {
  const cols = terminalColumnsOverride ?? DEFAULT_TERMINAL_COLUMNS;
  const fixedWidth =
    ID_WIDTH + STATUS_WIDTH + ACTIVITY_WIDTH + RUNNER_WIDTH + TOKENS_WIDTH;
  const ticketRowChromeWidth = 9;
  return Math.max(DETAIL_MIN_WIDTH, cols - fixedWidth - ticketRowChromeWidth);
}

// ─── Event humanizer ─────────────────────────────────────────────────────

export function humanizeEvent(
  message: unknown,
  eventType: string | null,
): string {
  if (message === null || message === undefined) return "no codex message yet";
  const payload = unwrapPayload(message);
  const byEvent =
    eventType !== null ? humanizeByEvent(eventType, message, payload) : null;
  return truncate(byEvent ?? humanizePayload(payload), 140);
}

function describeTicketDetail(entry: TuiSnapshot["tickets"][number]): string {
  const liveRun = entry.liveRun;
  const title = entry.title.trim();
  const lifecycleContext = describeTicketLifecycleContext(entry);
  const fromVisibility = humanizeRunnerVisibility(entry.runnerVisibility);
  const liveEvent =
    fromVisibility ??
    humanizeEvent(liveRun?.lastCodexMessage, liveRun?.lastCodexEvent ?? null);
  const meaningfulLiveEvent =
    liveEvent === "no codex message yet" ? null : liveEvent;
  const sessionContext = describeTicketSessionContext(entry);
  const segments = [
    title === "" ? null : title,
    meaningfulLiveEvent,
    lifecycleContext,
    sessionContext,
  ].filter((value): value is string => value !== null && value.trim() !== "");
  if (segments.length > 0) {
    if (
      liveRun !== null &&
      meaningfulLiveEvent === null &&
      liveEvent === "no codex message yet"
    ) {
      segments.push(liveEvent);
    }
    return segments.join(" · ");
  }
  return liveEvent;
}

function resolveSessionDisplay(
  entry: TuiSnapshot["tickets"][number],
): string | null {
  const liveRun = entry.liveRun;
  const visibility = entry.runnerVisibility;
  if (visibility !== null) {
    // Prefer the most specific backend session identity so operators can
    // cross-reference turn-level logs before falling back to the stable thread.
    return (
      visibility.session.backendSessionId ??
      visibility.session.backendThreadId ??
      visibility.session.latestTurnId ??
      liveRun?.sessionId ??
      null
    );
  }
  if (liveRun?.sessionId !== null && liveRun?.sessionId !== undefined) {
    return liveRun.sessionId;
  }
  return null;
}

function resolveTicketStatusLabel(
  entry: TuiSnapshot["tickets"][number],
): string {
  switch (entry.status) {
    case "awaiting-human-handoff":
      return "human-handoff";
    case "awaiting-human-review":
      return "human-review";
    case "awaiting-system-checks":
      return "system-checks";
    case "degraded-review-infrastructure":
      return "degraded-review";
    case "awaiting-landing-command":
      return "landing-command";
    case "awaiting-landing":
      return "awaiting-landing";
    case "rework-required":
      return "rework-required";
    case "queued":
    case "preparing":
    case "running":
    case "shutdown-terminated":
    case "shutdown-forced":
    case "merged":
      return entry.status;
  }
}

function resolveDisplayedTurn(
  entry: TuiSnapshot["tickets"][number],
  maxTurns: number,
): number | null {
  const runnerTurn = entry.runnerVisibility?.session.latestTurnNumber;
  if (typeof runnerTurn === "number" && runnerTurn > 0) {
    return Math.min(maxTurns, runnerTurn);
  }
  if ((entry.liveRun?.turnCount ?? 0) > 0) {
    return Math.min(maxTurns, entry.liveRun!.turnCount);
  }
  if (entry.runnerVisibility !== null) {
    return 1;
  }
  return null;
}

function turnBudgetColor(
  entry: TuiSnapshot["tickets"][number],
  maxTurns: number,
): string {
  const displayedTurn = resolveDisplayedTurn(entry, maxTurns);
  if (displayedTurn === null) {
    return MAGENTA;
  }
  const remainingTurns = maxTurns - displayedTurn;
  if (remainingTurns <= 0) {
    return RED;
  }
  if (remainingTurns === 1) {
    return YELLOW;
  }
  return MAGENTA;
}

function ticketStatusColor(entry: TuiSnapshot["tickets"][number]): string {
  if (entry.liveRun !== null) {
    return statusDotColor(entry.liveRun.lastCodexEvent, entry.runnerVisibility);
  }

  switch (entry.status) {
    case "awaiting-human-handoff":
    case "awaiting-human-review":
    case "awaiting-system-checks":
    case "awaiting-landing-command":
    case "awaiting-landing":
      return YELLOW;
    case "rework-required":
    case "shutdown-forced":
      return RED;
    case "merged":
      return MAGENTA;
    case "degraded-review-infrastructure":
      return RED;
    case "queued":
    case "preparing":
    case "running":
    case "shutdown-terminated":
      return BLUE;
  }
}

function formatTicketActivity(
  entry: TuiSnapshot["tickets"][number],
  nowMs: number,
  maxTurns: number,
): string {
  if (entry.startedAt !== null) {
    const runtimeSecs = Math.floor((nowMs - entry.startedAt.getTime()) / 1000);
    return formatRuntimeAndTurns(runtimeSecs, entry, maxTurns);
  }

  const updatedAgoSeconds = Math.max(
    0,
    Math.floor((nowMs - entry.updatedAt.getTime()) / 1000),
  );
  return `updated ${formatRuntimeSeconds(updatedAgoSeconds)}`;
}

function formatTicketRunner(entry: TuiSnapshot["tickets"][number]): string {
  return (
    formatRunnerLabel(entry.runnerVisibility) ??
    entry.runnerVisibility?.state ??
    "n/a"
  );
}

function describeTicketSessionContext(
  entry: TuiSnapshot["tickets"][number],
): string | null {
  const session = resolveSessionDisplay(entry);
  if (session === null) {
    return null;
  }
  return `session ${compactSessionId(session)}`;
}

export function legacyRunningEntryToTicket(
  entry: TuiSnapshot["running"][number],
): TuiSnapshot["tickets"][number] {
  return {
    issueNumber: entry.issueNumber,
    identifier: entry.identifier,
    title: entry.identifier,
    status: entry.lifecycle?.status ?? "running",
    summary: entry.lifecycle?.summary ?? entry.issueState,
    startedAt: entry.startedAt,
    updatedAt: entry.startedAt,
    pullRequest: entry.lifecycle?.pullRequest ?? null,
    checks: entry.lifecycle?.checks ?? { pendingNames: [], failingNames: [] },
    review: entry.lifecycle?.review ?? {
      actionableCount: 0,
      unresolvedThreadCount: 0,
    },
    blockedReason: null,
    runnerAccounting: entry.accounting,
    runnerVisibility: entry.runnerVisibility,
    liveRun: entry,
  };
}

function formatRunnerLabel(
  visibility: RunnerVisibilitySnapshot | null,
): string | null {
  if (visibility === null) {
    return null;
  }
  const provider = visibility.session.provider.trim();
  if (provider === "") {
    return null;
  }
  const model =
    visibility.session.model === null ? null : visibility.session.model.trim();
  const base =
    model === null || model === "" ? provider : `${provider}/${model}`;
  const remoteSessionId = visibility.session.transport.remoteSessionId;
  if (
    visibility.session.transport.kind === "remote-stdio-session" &&
    remoteSessionId !== null
  ) {
    const host = remoteSessionId.split(":")[0]?.trim() ?? "";
    if (host !== "") {
      return `${base}@${host}`;
    }
  }
  return base;
}

function describeTicketLifecycleContext(
  entry: TuiSnapshot["tickets"][number],
): string | null {
  const segments: string[] = [];
  if (entry.pullRequest !== null) {
    segments.push(`PR #${entry.pullRequest.number.toString()}`);
  }

  const pendingChecks = entry.checks.pendingNames.length;
  const failingChecks = entry.checks.failingNames.length;
  if (pendingChecks > 0 || failingChecks > 0) {
    segments.push(
      `checks p${pendingChecks.toString()} f${failingChecks.toString()}`,
    );
  }

  const actionableReview = entry.review.actionableCount;
  const unresolvedThreads = entry.review.unresolvedThreadCount;
  if (actionableReview > 0 || unresolvedThreads > 0) {
    segments.push(
      `review a${actionableReview.toString()} t${unresolvedThreads.toString()}`,
    );
  }

  if (
    segments.length === 0 &&
    entry.status !== "running" &&
    entry.summary.trim() !== ""
  ) {
    return entry.summary;
  }
  return segments.length === 0 ? null : segments.join(" · ");
}

function humanizeRunnerVisibility(
  visibility: RunnerVisibilitySnapshot | null,
): string | null {
  if (visibility === null) {
    return null;
  }

  const stdoutSummary = visibility.stdoutSummary;
  if (stdoutSummary !== null) {
    const humanized = humanizeVisibilitySummary(stdoutSummary);
    if (humanized !== null) {
      return humanized;
    }
  }

  if (visibility.lastActionSummary !== null) {
    return visibility.lastActionSummary;
  }
  if (visibility.waitingReason !== null) {
    return `waiting: ${visibility.waitingReason}`;
  }
  if (visibility.errorSummary !== null) {
    return visibility.errorSummary;
  }
  return null;
}

function humanizeVisibilitySummary(summary: string): string | null {
  const trimmed = summary.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = parseJsonObject(trimmed);
  if (parsed !== null) {
    return humanizeEvent(parsed, extractEventType(parsed));
  }
  return trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall back to the raw summary
  }
  return null;
}

function extractEventType(payload: Record<string, unknown>): string | null {
  const method = getKey(payload, "method");
  if (typeof method === "string" && method.trim() !== "") {
    return method;
  }
  const type = getMapKey(payload, ["type", "event"]);
  return typeof type === "string" && type.trim() !== "" ? type : null;
}

function unwrapPayload(message: unknown): unknown {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return message;
  }
  const obj = message as Record<string, unknown>;
  if (typeof getKey(obj, "method") === "string") return message;
  if (typeof getKey(obj, "session_id") === "string") return message;
  if (typeof getKey(obj, "reason") === "string") return message;
  return getKey(obj, "payload") ?? message;
}

function humanizeByEvent(
  event: string,
  message: unknown,
  payload: unknown,
): string | null {
  // Wrapper events
  if (event.startsWith("codex/event/")) {
    return humanizeWrapperEvent(event.slice("codex/event/".length), payload);
  }
  // Normalized event atoms (underscore forms are canonicalized to slash
  // by normalizeEventName in running-entry.ts at the integration boundary).
  switch (event) {
    case "session/started": {
      const sessionId = getMapKey(payload, ["session_id", "sessionId"]);
      return typeof sessionId === "string"
        ? `session started (${sessionId})`
        : "session started";
    }
    case "turn/input_required":
      return "turn blocked: waiting for user input";
    case "turn/ended_with_error":
      return `turn ended with error: ${formatReason(message)}`;
    case "startup/failed":
      return `startup failed: ${formatReason(message)}`;
    case "turn/completed":
      return humanizeMethod("turn/completed", payload) ?? "turn completed";
    case "turn/failed":
      return humanizeMethod("turn/failed", payload) ?? "turn failed";
    case "turn/cancelled":
      return "turn cancelled";
    case "malformed":
      return "malformed JSON event from codex";
    default:
      return null;
  }
}

function humanizeWrapperEvent(suffix: string, payload: unknown): string {
  switch (suffix) {
    case "session.start":
      return "session started";
    case "session.end":
      return "session ended";
    case "task_started":
      return "task started";
    case "user_message":
      return "user message received";
    case "mcp_startup_complete":
      return "mcp startup complete";
    case "exec_command_output_delta":
      return "command output streaming";
    case "mcp_tool_call_begin":
      return "mcp tool call started";
    case "mcp_tool_call_end":
      return "mcp tool call completed";
    case "agent_reasoning_section_break":
      return "reasoning section break";
    case "turn_diff":
      return "turn diff updated";
    case "agent_message_delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "agent_message_content_delta":
      return humanizeStreamingEvent("agent message content streaming", payload);
    case "agent_reasoning_delta":
      return humanizeStreamingEvent("reasoning streaming", payload);
    case "reasoning_content_delta":
      return humanizeStreamingEvent("reasoning content streaming", payload);
    case "reasoning":
    case "agent_reasoning":
      return humanizeReasoningUpdate(payload);
    case "exec_command_begin":
      return humanizeExecCommandBegin(payload);
    case "exec_command_end":
      return humanizeExecCommandEnd(payload);
    case "token_count": {
      const usage = extractFirstPath(payload, TOKEN_USAGE_PATHS);
      const usageText = formatUsageCounts(usage);
      return usageText !== null
        ? `token count update (${usageText})`
        : "token count update";
    }
    case "mcp_startup_update": {
      const server = mapPath(payload, ["params", "msg", "server"]) ?? "mcp";
      const state =
        mapPath(payload, ["params", "msg", "status", "state"]) ?? "updated";
      return `mcp startup: ${String(server)} ${String(state)}`;
    }
    case "item_started": {
      const t = wrapperPayloadType(payload);
      if (t === "token_count")
        return humanizeWrapperEvent("token_count", payload);
      return typeof t === "string"
        ? `item started (${humanizeItemType(t)})`
        : "item started";
    }
    case "item_completed": {
      const t = wrapperPayloadType(payload);
      if (t === "token_count")
        return humanizeWrapperEvent("token_count", payload);
      return typeof t === "string"
        ? `item completed (${humanizeItemType(t)})`
        : "item completed";
    }
    default: {
      const msgType = mapPath(payload, ["params", "msg", "type"]);
      return typeof msgType === "string" ? `${suffix} (${msgType})` : suffix;
    }
  }
}

function humanizePayload(payload: unknown): string {
  if (typeof payload === "string") {
    return sanitize(payload);
  }
  if (payload === null || payload === undefined) {
    return "no codex message yet";
  }
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const method = getKey(payload as Record<string, unknown>, "method");
    if (typeof method === "string") {
      return humanizeMethod(method, payload) ?? method;
    }
    const sessionId = getKey(payload as Record<string, unknown>, "session_id");
    if (typeof sessionId === "string") {
      return `session started (${sessionId})`;
    }
  }
  return sanitize(JSON.stringify(payload).slice(0, 80));
}

function humanizeMethod(method: string, payload: unknown): string | null {
  switch (method) {
    case "thread/started": {
      const threadId = mapPath(payload, ["params", "thread", "id"]);
      return typeof threadId === "string"
        ? `thread started (${threadId})`
        : "thread started";
    }
    case "turn/started": {
      const turnId = mapPath(payload, ["params", "turn", "id"]);
      return typeof turnId === "string"
        ? `turn started (${turnId})`
        : "turn started";
    }
    case "turn/completed":
    case "turn_completed": {
      const status =
        mapPath(payload, ["params", "turn", "status"]) ?? "completed";
      const usage =
        mapPath(payload, ["params", "usage"]) ??
        mapPath(payload, ["params", "tokenUsage"]) ??
        getMapKey(payload, ["usage"]);
      const usageText = formatUsageCounts(usage);
      const suffix = usageText !== null ? ` (${usageText})` : "";
      return `turn completed (${String(status)})${suffix}`;
    }
    case "turn/failed": {
      const errMsg = mapPath(payload, ["params", "error", "message"]);
      return typeof errMsg === "string"
        ? `turn failed: ${errMsg}`
        : "turn failed";
    }
    case "turn/cancelled":
      return "turn cancelled";
    case "turn/diff/updated": {
      const diff = mapPath(payload, ["params", "diff"]);
      if (typeof diff === "string" && diff !== "") {
        const lines = diff.split("\n").filter((l) => l.trim() !== "").length;
        return `turn diff updated (${String(lines)} lines)`;
      }
      return "turn diff updated";
    }
    case "turn/plan/updated": {
      const plan =
        mapPath(payload, ["params", "plan"]) ??
        mapPath(payload, ["params", "steps"]) ??
        mapPath(payload, ["params", "items"]);
      return Array.isArray(plan)
        ? `plan updated (${String(plan.length)} steps)`
        : "plan updated";
    }
    case "thread/tokenUsage/updated": {
      const usage =
        mapPath(payload, ["params", "tokenUsage", "total"]) ??
        getMapKey(payload, ["usage"]);
      const text = formatUsageCounts(usage);
      return text !== null
        ? `thread token usage updated (${text})`
        : "thread token usage updated";
    }
    case "item/started":
      return humanizeItemLifecycle("started", payload);
    case "item/completed":
      return humanizeItemLifecycle("completed", payload);
    case "item/agentMessage/delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "item/plan/delta":
      return humanizeStreamingEvent("plan streaming", payload);
    case "item/reasoning/summaryTextDelta":
      return humanizeStreamingEvent("reasoning summary streaming", payload);
    case "item/reasoning/summaryPartAdded":
      return humanizeStreamingEvent("reasoning summary section added", payload);
    case "item/reasoning/textDelta":
      return humanizeStreamingEvent("reasoning text streaming", payload);
    case "item/commandExecution/outputDelta":
      return humanizeStreamingEvent("command output streaming", payload);
    case "item/fileChange/outputDelta":
      return humanizeStreamingEvent("file change output streaming", payload);
    case "item/commandExecution/requestApproval": {
      const cmd = extractCommand(payload);
      return typeof cmd === "string"
        ? `command approval requested (${cmd})`
        : "command approval requested";
    }
    case "item/fileChange/requestApproval": {
      const count =
        mapPath(payload, ["params", "fileChangeCount"]) ??
        mapPath(payload, ["params", "changeCount"]);
      return typeof count === "number" && count > 0
        ? `file change approval requested (${String(count)} files)`
        : "file change approval requested";
    }
    case "item/tool/requestUserInput":
    case "tool/requestUserInput": {
      const q =
        mapPath(payload, ["params", "question"]) ??
        mapPath(payload, ["params", "prompt"]);
      return typeof q === "string" && q.trim() !== ""
        ? `tool requires user input: ${inlineText(q)}`
        : "tool requires user input";
    }
    case "item/tool/call": {
      const tool =
        mapPath(payload, ["params", "tool"]) ??
        mapPath(payload, ["params", "name"]);
      return typeof tool === "string" && tool.trim() !== ""
        ? `dynamic tool call requested (${tool.trim()})`
        : "dynamic tool call requested";
    }
    case "account/updated": {
      const auth = mapPath(payload, ["params", "authMode"]) ?? "unknown";
      return `account updated (auth ${String(auth)})`;
    }
    case "account/rateLimits/updated":
      return "rate limits updated";
    case "account/chatgptAuthTokens/refresh":
      return "account auth token refresh requested";
    default: {
      if (method.startsWith("codex/event/")) {
        return humanizeWrapperEvent(
          method.slice("codex/event/".length),
          payload,
        );
      }
      const msgType = mapPath(payload, ["params", "msg", "type"]);
      return typeof msgType === "string" ? `${method} (${msgType})` : method;
    }
  }
}

function humanizeItemLifecycle(state: string, payload: unknown): string {
  const item =
    (mapPath(payload, ["params", "item"]) as Record<string, unknown> | null) ??
    {};
  const itemType = humanizeItemType(
    typeof getMapKey(item, ["type"]) === "string"
      ? (getMapKey(item, ["type"]) as string)
      : null,
  );
  const itemStatus = getMapKey(item, ["status"]);
  const itemId = getMapKey(item, ["id"]);
  const details: string[] = [];
  if (typeof itemId === "string" && itemId.length > 0) {
    details.push(itemId.length > 12 ? itemId.slice(0, 12) : itemId);
  }
  if (typeof itemStatus === "string" && itemStatus.trim() !== "") {
    details.push(humanizeStatus(itemStatus));
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `item ${state}: ${itemType}${suffix}`;
}

function humanizeItemType(type: string | null): string {
  if (type === null) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\//g, " ")
    .toLowerCase()
    .trim();
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/-/g, " ").toLowerCase().trim();
}

function humanizeStreamingEvent(label: string, payload: unknown): string {
  const preview = extractDeltaPreview(payload);
  return preview !== null ? `${label}: ${preview}` : label;
}

function humanizeReasoningUpdate(payload: unknown): string {
  const focus = extractReasoningFocus(payload);
  return focus !== null ? `reasoning update: ${focus}` : "reasoning update";
}

function humanizeExecCommandBegin(payload: unknown): string {
  const command = extractCommand(payload);
  return typeof command === "string" ? command : "command started";
}

function humanizeExecCommandEnd(payload: unknown): string {
  const exitCode =
    mapPath(payload, ["params", "msg", "exit_code"]) ??
    mapPath(payload, ["params", "msg", "exitCode"]) ??
    mapPath(payload, ["params", "msg", "payload", "exit_code"]) ??
    mapPath(payload, ["params", "msg", "payload", "exitCode"]);
  return typeof exitCode === "number"
    ? `command completed (exit ${String(exitCode)})`
    : "command completed";
}

function extractCommand(payload: unknown): string | null {
  const parsedCmd = mapPath(payload, ["params", "parsedCmd"]);
  const raw =
    parsedCmd ??
    mapPath(payload, ["params", "msg", "command"]) ??
    mapPath(payload, ["params", "msg", "payload", "command"]) ??
    mapPath(payload, ["params", "command"]) ??
    mapPath(payload, ["params", "cmd"]) ??
    mapPath(payload, ["params", "argv"]) ??
    mapPath(payload, ["params", "args"]);
  return normalizeCommand(raw);
}

function normalizeCommand(cmd: unknown): string | null {
  if (typeof cmd === "string") return inlineText(cmd);
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === "string")) {
    return inlineText((cmd as string[]).join(" "));
  }
  if (cmd !== null && typeof cmd === "object") {
    const obj = cmd as Record<string, unknown>;
    const binary = getMapKey(obj, ["parsedCmd", "command", "cmd"]);
    const args = getMapKey(obj, ["args", "argv"]);
    if (typeof binary === "string" && Array.isArray(args)) {
      return normalizeCommand([binary, ...(args as string[])]);
    }
    return normalizeCommand(binary ?? args);
  }
  return null;
}

function extractDeltaPreview(payload: unknown): string | null {
  const delta = extractFirstPath(payload, DELTA_PATHS);
  if (typeof delta === "string") {
    const trimmed = delta.trim();
    return trimmed !== "" ? inlineText(trimmed) : null;
  }
  return null;
}

function extractReasoningFocus(payload: unknown): string | null {
  const value = extractFirstPath(payload, REASONING_FOCUS_PATHS);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? inlineText(trimmed) : null;
  }
  return null;
}

function formatUsageCounts(usage: unknown): string | null {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const obj = usage as Record<string, unknown>;
  const input = parseInteger(
    getMapKey(obj, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
    ]),
  );
  const output = parseInteger(
    getMapKey(obj, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
    ]),
  );
  const total = parseInteger(
    getMapKey(obj, ["total_tokens", "totalTokens", "total"]),
  );
  const parts: string[] = [];
  if (input !== null) parts.push(`in ${formatCount(input)}`);
  if (output !== null) parts.push(`out ${formatCount(output)}`);
  if (total !== null) parts.push(`total ${formatCount(total)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatReason(message: unknown): string {
  if (message !== null && typeof message === "object") {
    const reason = getMapKey(message as Record<string, unknown>, ["reason"]);
    if (reason !== null && reason !== undefined) {
      return formatErrorValue(reason);
    }
    return sanitize(JSON.stringify(message).slice(0, 80));
  }
  return formatErrorValue(message);
}

function formatErrorValue(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const msg = (error as Record<string, unknown>)["message"];
    if (typeof msg === "string") return msg;
  }
  return sanitize(String(error).slice(0, 80));
}

function wrapperPayloadType(payload: unknown): unknown {
  return mapPath(payload, ["params", "msg", "payload", "type"]) ?? undefined;
}

function inlineText(text: string): string {
  return truncate(sanitize(text).replace(/\s+/g, " ").trim(), 80);
}

function sanitize(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ─── Map helpers ─────────────────────────────────────────────────────────
// getKey, getMapKey, mapPath imported from ../domain/codex-payload.js

function extractFirstPath(
  payload: unknown,
  paths: readonly (readonly string[])[],
): unknown {
  for (const path of paths) {
    const val = mapPath(payload, path as string[]);
    if (val !== null && val !== undefined) return val;
  }
  return undefined;
}

// ─── Path constants ───────────────────────────────────────────────────────

const TOKEN_USAGE_PATHS = [
  ["params", "msg", "payload", "info", "total_token_usage"],
  ["params", "msg", "info", "total_token_usage"],
  ["params", "tokenUsage", "total"],
] as const;

const DELTA_PATHS = [
  ["params", "delta"],
  ["params", "msg", "delta"],
  ["params", "textDelta"],
  ["params", "msg", "textDelta"],
  ["params", "outputDelta"],
  ["params", "msg", "outputDelta"],
  ["params", "text"],
  ["params", "msg", "text"],
  ["params", "summaryText"],
  ["params", "msg", "summaryText"],
  ["params", "msg", "content"],
  ["params", "msg", "payload", "delta"],
  ["params", "msg", "payload", "textDelta"],
  ["params", "msg", "payload", "outputDelta"],
  ["params", "msg", "payload", "text"],
  ["params", "msg", "payload", "summaryText"],
  ["params", "msg", "payload", "content"],
] as const;

const REASONING_FOCUS_PATHS = [
  ["params", "reason"],
  ["params", "summaryText"],
  ["params", "summary"],
  ["params", "text"],
  ["params", "msg", "reason"],
  ["params", "msg", "summaryText"],
  ["params", "msg", "summary"],
  ["params", "msg", "text"],
  ["params", "msg", "payload", "reason"],
  ["params", "msg", "payload", "summaryText"],
  ["params", "msg", "payload", "summary"],
  ["params", "msg", "payload", "text"],
] as const;
