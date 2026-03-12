/**
 * StatusDashboard — terminal status TUI for the Symphony factory.
 *
 * Pull-based: polls orchestrator.snapshot() on a configurable tick interval.
 * Push-aware: accepts refresh() calls from the orchestrator on state changes.
 * Rate-limited: throttles renders to at most once per renderIntervalMs.
 * Observability-only: never mutates orchestrator state.
 */

import type { ObservabilityConfig } from "../domain/workflow.js";
import type { TuiSnapshot } from "../orchestrator/service.js";

// ─── ANSI constants ────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function colorize(text: string, code: string): string {
  return `${code}${text}${RESET}`;
}

// ─── Column widths ──────────────────────────────────────────────────────────

const ID_WIDTH = 8;
const STAGE_WIDTH = 14;
const PID_WIDTH = 8;
const AGE_WIDTH = 12;
const TOKENS_WIDTH = 10;
const SESSION_WIDTH = 14;
const EVENT_MIN_WIDTH = 12;
const ROW_CHROME_WIDTH = 10;
const DEFAULT_TERMINAL_COLUMNS = 115;
const THROUGHPUT_WINDOW_MS = 5_000;
const MINIMUM_IDLE_RERENDER_MS = 1_000;
const SPARKLINE_WINDOW_MS = 600_000; // 10 minutes
const SPARKLINE_BUCKETS = 24;
const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";

// ─── Types ──────────────────────────────────────────────────────────────────

type TokenSample = readonly [timestampMs: number, totalTokens: number];

interface DashboardState {
  refreshMs: number;
  enabled: boolean;
  renderIntervalMs: number;
  renderFn: (content: string) => void;
  tokenSamples: TokenSample[];
  sparklineSamples: TokenSample[];
  lastTpsSecond: number | null;
  lastTpsValue: number;
  lastRenderedContent: string | null;
  lastRenderedAtMs: number | null;
  pendingContent: string | null;
  flushTimerRef: NodeJS.Timeout | null;
  lastSnapshotFingerprint: string | null;
  tickTimer: NodeJS.Timeout | null;
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface StatusDashboardOptions {
  readonly enabled?: boolean;
  readonly refreshMs?: number;
  readonly renderIntervalMs?: number;
  readonly renderFn?: (content: string) => void;
}

export class StatusDashboard {
  readonly #getSnapshot: () => TuiSnapshot;
  readonly #getConfig: () => ObservabilityConfig;
  readonly #state: DashboardState;
  readonly #explicitEnabled: boolean | undefined;
  #stopped = false;

  constructor(
    getSnapshot: () => TuiSnapshot,
    getConfig: () => ObservabilityConfig,
    options?: StatusDashboardOptions,
  ) {
    this.#getSnapshot = getSnapshot;
    this.#getConfig = getConfig;
    this.#explicitEnabled = options?.enabled;

    const config = getConfig();
    const enabled =
      this.#explicitEnabled ?? (config.dashboardEnabled && isTerminalEnabled());

    this.#state = {
      refreshMs: options?.refreshMs ?? config.refreshMs,
      enabled,
      renderIntervalMs: options?.renderIntervalMs ?? config.renderIntervalMs,
      renderFn: options?.renderFn ?? renderToTerminal,
      tokenSamples: [],
      sparklineSamples: [],
      lastTpsSecond: null,
      lastTpsValue: 0,
      lastRenderedContent: null,
      lastRenderedAtMs: null,
      pendingContent: null,
      flushTimerRef: null,
      lastSnapshotFingerprint: null,
      tickTimer: null,
    };
  }

  start(): void {
    if (!this.#state.enabled) return;
    this.#scheduleTick();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#state.tickTimer !== null) {
      clearTimeout(this.#state.tickTimer);
      this.#state.tickTimer = null;
    }
    if (this.#state.flushTimerRef !== null) {
      clearTimeout(this.#state.flushTimerRef);
      this.#state.flushTimerRef = null;
    }
    if (this.#state.enabled) {
      this.renderOfflineStatus();
    }
  }

  refresh(): void {
    if (this.#stopped || !this.#state.enabled) return;
    this.#refreshRuntimeConfig();
    this.#maybeRender();
  }

  renderOfflineStatus(): void {
    const content = [
      colorize("╭─ SYMPHONY STATUS", BOLD),
      colorize("│ app_status=offline", RED),
      "╰─",
    ].join("\n");
    try {
      this.#state.renderFn(content);
    } catch {
      // best-effort
    }
  }

  // ─── Tick loop ────────────────────────────────────────────────────────────

  #scheduleTick(): void {
    this.#state.tickTimer = setTimeout(() => {
      this.#onTick();
    }, this.#state.refreshMs);
  }

  #onTick(): void {
    if (this.#stopped || !this.#state.enabled) return;
    this.#refreshRuntimeConfig();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.#state.enabled) return;
    this.#maybeRender();
    this.#scheduleTick();
  }

  #refreshRuntimeConfig(): void {
    const config = this.#getConfig();
    this.#state.refreshMs = config.refreshMs;
    this.#state.renderIntervalMs = config.renderIntervalMs;
    this.#state.enabled =
      this.#explicitEnabled ?? (config.dashboardEnabled && isTerminalEnabled());
  }

  // ─── Render pipeline ─────────────────────────────────────────────────────

  #maybeRender(): void {
    const nowMs = Date.now();
    let snapshot: TuiSnapshot | null = null;
    try {
      snapshot = this.#getSnapshot();
    } catch {
      // snapshot unavailable
    }

    const currentTokens = snapshot?.codexTotals.totalTokens ?? 0;

    // Update token samples (5-second TPS window)
    if (snapshot !== null) {
      this.#state.tokenSamples = updateTokenSamples(
        this.#state.tokenSamples,
        nowMs,
        currentTokens,
      );
    } else {
      this.#state.tokenSamples = pruneTokenSamples(
        this.#state.tokenSamples,
        nowMs,
      );
    }

    // Update sparkline samples (10-minute window)
    if (snapshot !== null) {
      this.#state.sparklineSamples = updateSparklineSamples(
        this.#state.sparklineSamples,
        nowMs,
        currentTokens,
      );
    } else {
      this.#state.sparklineSamples = pruneSparklineSamples(
        this.#state.sparklineSamples,
        nowMs,
      );
    }

    // Throttled TPS
    const { second: tpsSecond, tps } = throttledTps(
      this.#state.lastTpsSecond,
      this.#state.lastTpsValue,
      nowMs,
      this.#state.tokenSamples,
      currentTokens,
    );
    this.#state.lastTpsSecond = tpsSecond;
    this.#state.lastTpsValue = tps;

    // Snapshot fingerprinting
    const fingerprint = snapshot !== null ? JSON.stringify(snapshot) : null;
    const snapshotChanged = fingerprint !== this.#state.lastSnapshotFingerprint;
    const periodicDue = isPeriodicRerenderDue(
      this.#state.lastRenderedAtMs,
      nowMs,
    );

    if (!snapshotChanged && !periodicDue) return;

    if (snapshotChanged) {
      this.#state.lastSnapshotFingerprint = fingerprint;
    }

    const sparkline = tpsSparkline(this.#state.sparklineSamples, nowMs);
    const content = formatSnapshotContent(snapshot, tps, undefined, sparkline);
    this.#maybeEnqueueRender(content, nowMs);
  }

  #maybeEnqueueRender(content: string, nowMs: number): void {
    if (content === this.#state.lastRenderedContent) return;

    if (
      isRenderNow(this.#state.lastRenderedAtMs, this.#state.renderIntervalMs)
    ) {
      this.#renderContent(content, nowMs);
    } else {
      this.#scheduleFlushRender(content, nowMs);
    }
  }

  #scheduleFlushRender(content: string, nowMs: number): void {
    this.#state.pendingContent = content;
    if (this.#state.flushTimerRef !== null) return;

    const delayMs = flushDelayMs(
      this.#state.lastRenderedAtMs,
      this.#state.renderIntervalMs,
      nowMs,
    );
    this.#state.flushTimerRef = setTimeout(() => {
      this.#onFlushRender();
    }, delayMs);
  }

  #onFlushRender(): void {
    this.#state.flushTimerRef = null;
    const content = this.#state.pendingContent;
    this.#state.pendingContent = null;
    if (content !== null) {
      this.#renderContent(content, Date.now());
    }
  }

  #renderContent(content: string, nowMs: number): void {
    try {
      this.#state.renderFn(content);
      this.#state.lastRenderedContent = content;
      this.#state.lastRenderedAtMs = nowMs;
    } catch {
      // best-effort
    }
  }
}

// ─── Terminal output ──────────────────────────────────────────────────────

function renderToTerminal(content: string): void {
  process.stdout.write(`\x1b[H\x1b[2J${content}\n`);
}

function isTerminalEnabled(): boolean {
  return process.env["NODE_ENV"] !== "test" && process.stdout.isTTY === true;
}

// ─── Snapshot formatter ───────────────────────────────────────────────────

export function formatSnapshotContent(
  snapshot: TuiSnapshot | null,
  tps: number,
  terminalColumnsOverride?: number,
  sparkline?: string,
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
      formatRefreshLine(null),
      "╰─",
    ]
      .flat()
      .join("\n");
  }

  const {
    running,
    retrying,
    codexTotals,
    rateLimits,
    polling,
    maxConcurrentRuns,
    projectUrl,
  } = snapshot;
  const eventWidth = runningEventWidth(terminalColumnsOverride);
  const runningRows = formatRunningRows(running, eventWidth);
  const runningToBackoffSpacer = running.length > 0 ? ["│"] : [];
  const backoffRows = formatRetryRows(retrying);

  const projectLine =
    projectUrl !== null
      ? [colorize("│ Project: ", BOLD) + colorize(projectUrl, CYAN)]
      : [];

  return [
    colorize("╭─ SYMPHONY STATUS", BOLD),
    colorize("│ Agents: ", BOLD) +
      colorize(String(running.length), GREEN) +
      colorize("/", GRAY) +
      colorize(String(maxConcurrentRuns), GRAY),
    colorize("│ Throughput: ", BOLD) +
      colorize(`${formatTps(tps)} tps`, CYAN) +
      sparklineSuffix,
    colorize("│ Runtime: ", BOLD) +
      colorize(formatRuntimeSeconds(codexTotals.secondsRunning), MAGENTA),
    colorize("│ Tokens: ", BOLD) +
      colorize(`in ${formatCount(codexTotals.inputTokens)}`, YELLOW) +
      colorize(" | ", GRAY) +
      colorize(`out ${formatCount(codexTotals.outputTokens)}`, YELLOW) +
      colorize(" | ", GRAY) +
      colorize(`total ${formatCount(codexTotals.totalTokens)}`, YELLOW),
    colorize("│ Rate Limits: ", BOLD) + formatRateLimits(rateLimits),
    ...projectLine,
    formatRefreshLine(polling),
    colorize("├─ Running", BOLD),
    "│",
    runningTableHeaderRow(eventWidth),
    runningTableSeparatorRow(eventWidth),
    ...runningRows,
    ...runningToBackoffSpacer,
    colorize("├─ Backoff queue", BOLD),
    "│",
    ...backoffRows,
    "╰─",
  ]
    .flat()
    .join("\n");
}

// ─── Header helpers ───────────────────────────────────────────────────────

function formatRefreshLine(polling: TuiSnapshot["polling"] | null): string {
  if (polling === null) {
    return colorize("│ Next refresh: ", BOLD) + colorize("n/a", GRAY);
  }
  if (polling.checkingNow) {
    return colorize("│ Next refresh: ", BOLD) + colorize("checking now…", CYAN);
  }
  const dueInMs = Math.max(0, polling.nextPollAtMs - Date.now());
  const seconds = Math.ceil(dueInMs / 1000);
  return (
    colorize("│ Next refresh: ", BOLD) + colorize(`${String(seconds)}s`, CYAN)
  );
}

function formatRateLimits(rateLimits: TuiSnapshot["rateLimits"]): string {
  if (rateLimits === null) {
    return colorize("unavailable", GRAY);
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
    colorize(" | ", GRAY) +
    primaryPart +
    colorize(" | ", GRAY) +
    secondaryPart +
    colorize(" | ", GRAY) +
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

// ─── Running table ────────────────────────────────────────────────────────

function runningTableHeaderRow(eventWidth: number): string {
  const header = [
    formatCell("ID", ID_WIDTH),
    formatCell("STAGE", STAGE_WIDTH),
    formatCell("PID", PID_WIDTH),
    formatCell("AGE / TURN", AGE_WIDTH),
    formatCell("TOKENS", TOKENS_WIDTH),
    formatCell("SESSION", SESSION_WIDTH),
    formatCell("EVENT", eventWidth),
  ].join(" ");
  return "│   " + colorize(header, GRAY);
}

function runningTableSeparatorRow(eventWidth: number): string {
  const width =
    ID_WIDTH +
    STAGE_WIDTH +
    PID_WIDTH +
    AGE_WIDTH +
    TOKENS_WIDTH +
    SESSION_WIDTH +
    eventWidth +
    6;
  return "│   " + colorize("─".repeat(width), GRAY);
}

function formatRunningRows(
  running: TuiSnapshot["running"],
  eventWidth: number,
): string[] {
  if (running.length === 0) {
    return ["│  " + colorize("No active agents", GRAY), "│"];
  }
  return running.map((entry) => formatRunningRow(entry, eventWidth));
}

function formatRunningRow(
  entry: TuiSnapshot["running"][number],
  eventWidth: number,
): string {
  const runtimeSecs = Math.floor(
    (Date.now() - entry.startedAt.getTime()) / 1000,
  );
  const issue = formatCell(entry.identifier, ID_WIDTH);
  const stage = formatCell(entry.issueState, STAGE_WIDTH);
  const pid = formatCell(
    entry.codexAppServerPid !== null ? String(entry.codexAppServerPid) : "n/a",
    PID_WIDTH,
  );
  const age = formatCell(
    formatRuntimeAndTurns(runtimeSecs, entry.turnCount),
    AGE_WIDTH,
  );
  const tokens = formatCell(
    formatCount(entry.codexTotalTokens),
    TOKENS_WIDTH,
    "right",
  );
  const session = formatCell(compactSessionId(entry.sessionId), SESSION_WIDTH);
  const eventLabel = formatCell(
    humanizeEvent(entry.lastCodexMessage, entry.lastCodexEvent),
    eventWidth,
  );

  const statusColor = statusDotColor(entry.lastCodexEvent);

  return (
    "│ " +
    colorize("●", statusColor) +
    " " +
    colorize(issue, CYAN) +
    " " +
    colorize(stage, statusColor) +
    " " +
    colorize(pid, YELLOW) +
    " " +
    colorize(age, MAGENTA) +
    " " +
    colorize(tokens, YELLOW) +
    " " +
    colorize(session, CYAN) +
    " " +
    colorize(eventLabel, statusColor)
  );
}

function statusDotColor(event: string | null): string {
  if (event === null || event === "none") return RED;
  if (event === "codex/event/token_count") return YELLOW;
  if (event === "codex/event/task_started") return GREEN;
  if (event === "turn/completed") return MAGENTA;
  return BLUE;
}

// ─── Backoff queue ────────────────────────────────────────────────────────

function formatRetryRows(retrying: TuiSnapshot["retrying"]): string[] {
  if (retrying.length === 0) {
    return ["│  " + colorize("No queued retries", GRAY)];
  }
  return retrying.map((entry) => {
    const dueStr = formatDueIn(entry.dueInMs);
    const errorPart =
      entry.lastError !== null && entry.lastError.trim() !== ""
        ? " " + colorize(`error=${sanitizeRetryError(entry.lastError)}`, DIM)
        : "";
    return (
      "│  " +
      colorize("↻", YELLOW) +
      " " +
      colorize(entry.identifier, RED) +
      " " +
      colorize(`attempt=${String(entry.nextAttempt)}`, YELLOW) +
      colorize(" in ", DIM) +
      colorize(dueStr, CYAN) +
      errorPart
    );
  });
}

function formatDueIn(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const millis = ms % 1000;
  return `${String(secs)}.${String(millis).padStart(3, "0")}s`;
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

// ─── TPS calculation ──────────────────────────────────────────────────────

export function rollingTps(
  samples: readonly TokenSample[],
  nowMs: number,
  currentTokens: number,
): number {
  const updated: TokenSample[] = [[nowMs, currentTokens], ...samples];
  const pruned = pruneTokenSamples(updated, nowMs);

  if (pruned.length < 2) return 0;

  const oldest = pruned[pruned.length - 1]!;
  const [oldestMs, oldestTokens] = oldest;
  const elapsedMs = nowMs - oldestMs;
  const deltaTokens = Math.max(0, currentTokens - oldestTokens);

  if (elapsedMs <= 0) return 0;
  return deltaTokens / (elapsedMs / 1000);
}

export function throttledTps(
  lastSecond: number | null,
  lastValue: number,
  nowMs: number,
  samples: readonly TokenSample[],
  currentTokens: number,
): { second: number; tps: number } {
  const second = Math.floor(nowMs / 1000);
  if (lastSecond !== null && lastSecond === second) {
    return { second, tps: lastValue };
  }
  return { second, tps: rollingTps(samples, nowMs, currentTokens) };
}

function updateTokenSamples(
  samples: TokenSample[],
  nowMs: number,
  totalTokens: number,
): TokenSample[] {
  return pruneTokenSamples([[nowMs, totalTokens], ...samples], nowMs);
}

function pruneTokenSamples(
  samples: readonly TokenSample[],
  nowMs: number,
): TokenSample[] {
  const minTs = nowMs - THROUGHPUT_WINDOW_MS;
  return samples.filter(([ts]) => ts >= minTs) as TokenSample[];
}

function updateSparklineSamples(
  samples: TokenSample[],
  nowMs: number,
  totalTokens: number,
): TokenSample[] {
  return pruneSparklineSamples([[nowMs, totalTokens], ...samples], nowMs);
}

function pruneSparklineSamples(
  samples: readonly TokenSample[],
  nowMs: number,
): TokenSample[] {
  const minTs = nowMs - SPARKLINE_WINDOW_MS;
  return samples.filter(([ts]) => ts >= minTs) as TokenSample[];
}

export function tpsSparkline(
  samples: readonly TokenSample[],
  nowMs: number,
): string {
  if (samples.length < 2) return "";

  const bucketMs = SPARKLINE_WINDOW_MS / SPARKLINE_BUCKETS;
  const windowStart = nowMs - SPARKLINE_WINDOW_MS;
  const bucketTps: number[] = new Array(SPARKLINE_BUCKETS).fill(0) as number[];

  const sorted = [...samples].sort((a, b) => a[0] - b[0]);

  for (let i = 1; i < sorted.length; i++) {
    const [prevMs, prevTokens] = sorted[i - 1]!;
    const [curMs, curTokens] = sorted[i]!;
    const elapsedMs = curMs - prevMs;
    if (elapsedMs <= 0) continue;

    const deltaTokens = Math.max(0, curTokens - prevTokens);
    const pairTps = deltaTokens / (elapsedMs / 1000);

    const midMs = (prevMs + curMs) / 2;
    const bucketIndex = Math.floor((midMs - windowStart) / bucketMs);
    if (bucketIndex >= 0 && bucketIndex < SPARKLINE_BUCKETS) {
      bucketTps[bucketIndex] = Math.max(bucketTps[bucketIndex]!, pairTps);
    }
  }

  const maxTps = Math.max(...bucketTps);
  if (maxTps === 0) return "";

  const levels = SPARKLINE_CHARS.length;
  return bucketTps
    .map((v) => {
      if (v === 0) return " ";
      const idx = Math.min(levels - 1, Math.floor((v / maxTps) * levels));
      return SPARKLINE_CHARS[idx] ?? SPARKLINE_CHARS[levels - 1]!;
    })
    .join("");
}

// ─── Render timing helpers ────────────────────────────────────────────────

function isPeriodicRerenderDue(
  lastRenderedAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastRenderedAtMs === null) return true;
  return nowMs - lastRenderedAtMs >= MINIMUM_IDLE_RERENDER_MS;
}

function isRenderNow(
  lastRenderedAtMs: number | null,
  renderIntervalMs: number,
): boolean {
  if (lastRenderedAtMs === null) return true;
  return Date.now() - lastRenderedAtMs >= renderIntervalMs;
}

function flushDelayMs(
  lastRenderedAtMs: number | null,
  renderIntervalMs: number,
  nowMs: number,
): number {
  if (lastRenderedAtMs === null) return 1;
  const remaining = renderIntervalMs - (nowMs - lastRenderedAtMs);
  return Math.max(1, remaining);
}

// ─── Formatting helpers ───────────────────────────────────────────────────

function formatTps(value: number): string {
  return formatCount(Math.floor(value));
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatRuntimeSeconds(seconds: number): string {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins)}m ${String(secs)}s`;
}

function formatRuntimeAndTurns(seconds: number, turnCount: number): string {
  if (turnCount > 0) {
    return `${formatRuntimeSeconds(seconds)} / ${String(turnCount)}`;
  }
  return formatRuntimeSeconds(seconds);
}

function formatCell(
  value: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const cleaned = value.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const truncated = truncatePlain(cleaned, width);
  return align === "right"
    ? truncated.padStart(width)
    : truncated.padEnd(width);
}

function truncatePlain(value: string, width: number): string {
  if (value.length <= width) return value;
  return value.slice(0, width - 3) + "...";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "...";
}

function compactSessionId(sessionId: string | null): string {
  if (sessionId === null) return "n/a";
  if (sessionId.length > 10) {
    return sessionId.slice(0, 4) + "..." + sessionId.slice(-6);
  }
  return sessionId;
}

function runningEventWidth(terminalColumnsOverride?: number): number {
  const cols = terminalColumnsOverride ?? terminalColumns();
  const fixedWidth =
    ID_WIDTH +
    STAGE_WIDTH +
    PID_WIDTH +
    AGE_WIDTH +
    TOKENS_WIDTH +
    SESSION_WIDTH;
  return Math.max(EVENT_MIN_WIDTH, cols - fixedWidth - ROW_CHROME_WIDTH);
}

function terminalColumns(): number {
  const envCols = process.env["COLUMNS"];
  if (envCols !== undefined) {
    const parsed = parseInt(envCols.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Node.js stdout columns
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return DEFAULT_TERMINAL_COLUMNS;
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
  // Legacy event atoms
  switch (event) {
    case "session_started": {
      const sessionId = getMapKey(payload, ["session_id", "sessionId"]);
      return typeof sessionId === "string"
        ? `session started (${sessionId})`
        : "session started";
    }
    case "turn_input_required":
      return "turn blocked: waiting for user input";
    case "turn_ended_with_error":
      return `turn ended with error: ${formatReason(message)}`;
    case "startup_failed":
      return `startup failed: ${formatReason(message)}`;
    case "turn_failed":
      return humanizeMethod("turn/failed", payload) ?? "turn failed";
    case "turn_cancelled":
      return "turn cancelled";
    case "malformed":
      return "malformed JSON event from codex";
    default:
      return null;
  }
}

function humanizeWrapperEvent(suffix: string, payload: unknown): string {
  switch (suffix) {
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
    case "turn/completed": {
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
    mapPath(payload, ["params", "msg", "exitCode"]);
  return typeof exitCode === "number"
    ? `command completed (exit ${String(exitCode)})`
    : "command completed";
}

function extractCommand(payload: unknown): string | null {
  const parsedCmd = mapPath(payload, ["params", "parsedCmd"]);
  const raw =
    parsedCmd ??
    mapPath(payload, ["params", "msg", "command"]) ??
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
  return truncate(text.replace(/\n/g, " ").replace(/\s+/g, " ").trim(), 80);
}

function sanitize(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\n/g, " ")
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

function getKey(obj: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(obj, key)) return obj[key];
  // camelCase fallback
  const camel = key.replace(/_([a-z])/g, (_, c: string) =>
    (c as string).toUpperCase(),
  );
  if (camel !== key && Object.hasOwn(obj, camel)) return obj[camel];
  // snake_case fallback
  const snake = key.replace(/([A-Z])/g, "_$1").toLowerCase();
  if (snake !== key && Object.hasOwn(obj, snake)) return obj[snake];
  return undefined;
}

function getMapKey(obj: unknown, keys: string[]): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const val = getKey(record, key);
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

function mapPath(obj: unknown, path: string[]): unknown {
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
    current = getKey(current as Record<string, unknown>, key);
  }
  return current;
}

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
