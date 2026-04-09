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
import { getLogFilePath, setLogFile } from "./logger.js";
import {
  formatSnapshotContent,
  legacyRunningEntryToTicket,
  renderOfflineStatusFrame,
} from "./tui-render.js";

const THROUGHPUT_WINDOW_MS = 5_000;
const MINIMUM_IDLE_RERENDER_MS = 1_000;
const SPARKLINE_WINDOW_MS = 600_000; // 10 minutes
const SPARKLINE_BUCKETS = 24;
const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";

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

export interface StatusDashboardOptions {
  readonly enabled?: boolean;
  readonly refreshMs?: number;
  readonly renderIntervalMs?: number;
  readonly renderFn?: (content: string) => void;
  /** When set, logs are redirected to this file while the TUI is active. */
  readonly logFile?: string;
}

export class StatusDashboard {
  readonly #getSnapshot: () => TuiSnapshot;
  readonly #getConfig: () => ObservabilityConfig;
  readonly #state: DashboardState;
  readonly #explicitEnabled: boolean | undefined;
  readonly #explicitRefreshMs: number | undefined;
  readonly #explicitRenderIntervalMs: number | undefined;
  readonly #logFile: string | undefined;
  #stopped = false;

  constructor(
    getSnapshot: () => TuiSnapshot,
    getConfig: () => ObservabilityConfig,
    options?: StatusDashboardOptions,
  ) {
    this.#getSnapshot = getSnapshot;
    this.#getConfig = getConfig;
    this.#explicitEnabled = options?.enabled;
    this.#explicitRefreshMs = options?.refreshMs;
    this.#explicitRenderIntervalMs = options?.renderIntervalMs;
    this.#logFile = options?.logFile;

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
    if (this.#stopped || this.#state.tickTimer !== null || !this.#state.enabled)
      return;
    if (this.#logFile !== undefined) {
      setLogFile(this.#logFile);
    }
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
    const wasLogFile = getLogFilePath();
    setLogFile(null);
    if (wasLogFile !== null) {
      process.stderr.write(`Logs written to ${wasLogFile}\n`);
    }
  }

  refresh(): void {
    if (this.#stopped || !this.#state.enabled) return;
    this.#refreshRuntimeConfig();
    this.#maybeRender();
  }

  renderOfflineStatus(): void {
    try {
      this.#state.renderFn(renderOfflineStatusFrame());
    } catch {
      // best-effort
    }
  }

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
    this.#state.refreshMs = this.#explicitRefreshMs ?? config.refreshMs;
    this.#state.renderIntervalMs =
      this.#explicitRenderIntervalMs ?? config.renderIntervalMs;
    this.#state.enabled =
      this.#explicitEnabled ?? (config.dashboardEnabled && isTerminalEnabled());
  }

  #maybeRender(): void {
    const nowMs = Date.now();
    let snapshot: TuiSnapshot | null = null;
    try {
      snapshot = this.#getSnapshot();
    } catch {
      // snapshot unavailable
    }

    const fingerprint =
      snapshot !== null ? snapshotFingerprint(snapshot) : null;
    const snapshotChanged = fingerprint !== this.#state.lastSnapshotFingerprint;
    const periodicDue = isPeriodicRerenderDue(
      this.#state.lastRenderedAtMs,
      nowMs,
    );

    if (!snapshotChanged && !periodicDue) return;

    if (snapshotChanged) {
      this.#state.lastSnapshotFingerprint = fingerprint;
    }

    const currentTokens = snapshot?.codexTotals.totalTokens ?? 0;
    if (snapshot !== null) {
      this.#state.tokenSamples = updateSamples(
        this.#state.tokenSamples,
        nowMs,
        currentTokens,
        THROUGHPUT_WINDOW_MS,
      );
      this.#state.sparklineSamples = updateSamples(
        this.#state.sparklineSamples,
        nowMs,
        currentTokens,
        SPARKLINE_WINDOW_MS,
      );
    } else {
      this.#state.tokenSamples = pruneSamples(
        this.#state.tokenSamples,
        nowMs,
        THROUGHPUT_WINDOW_MS,
      );
      this.#state.sparklineSamples = pruneSamples(
        this.#state.sparklineSamples,
        nowMs,
        SPARKLINE_WINDOW_MS,
      );
    }

    const { second: tpsSecond, tps } = throttledTps(
      this.#state.lastTpsSecond,
      this.#state.lastTpsValue,
      nowMs,
      this.#state.tokenSamples,
      currentTokens,
    );
    this.#state.lastTpsSecond = tpsSecond;
    this.#state.lastTpsValue = tps;

    const sparkline = tpsSparkline(this.#state.sparklineSamples, nowMs);
    const content = formatSnapshotContent(
      snapshot,
      tps,
      undefined,
      sparkline,
      nowMs,
    );
    this.#maybeEnqueueRender(content, nowMs);
  }

  #maybeEnqueueRender(content: string, nowMs: number): void {
    if (content === this.#state.lastRenderedContent) return;

    if (
      isRenderNow(this.#state.lastRenderedAtMs, this.#state.renderIntervalMs)
    ) {
      if (this.#state.flushTimerRef !== null) {
        clearTimeout(this.#state.flushTimerRef);
        this.#state.flushTimerRef = null;
      }
      this.#state.pendingContent = null;
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
    if (this.#stopped) return;
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

function renderToTerminal(content: string): void {
  process.stdout.write(`\x1b[H\x1b[2J${content}\n`);
}

function isTerminalEnabled(): boolean {
  return process.env["NODE_ENV"] !== "test" && process.stdout.isTTY === true;
}

export { formatSnapshotContent, humanizeEvent } from "./tui-render.js";
export { legacyRunningEntryToTicket } from "./tui-render.js";

export function rollingTps(
  samples: readonly TokenSample[],
  nowMs: number,
  currentTokens: number,
): number {
  const updated: TokenSample[] = [[nowMs, currentTokens], ...samples];
  const pruned = pruneSamples(updated, nowMs, THROUGHPUT_WINDOW_MS);

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

function updateSamples(
  samples: TokenSample[],
  nowMs: number,
  totalTokens: number,
  windowMs: number,
): TokenSample[] {
  return pruneSamples([[nowMs, totalTokens], ...samples], nowMs, windowMs);
}

function pruneSamples(
  samples: readonly TokenSample[],
  nowMs: number,
  windowMs: number,
): TokenSample[] {
  const minTs = nowMs - windowMs;
  return samples.filter(([ts]) => ts >= minTs) as TokenSample[];
}

export function tpsSparkline(
  samples: readonly TokenSample[],
  nowMs: number,
): string {
  if (samples.length < 2) return "";

  const bucketMs = SPARKLINE_WINDOW_MS / SPARKLINE_BUCKETS;
  const windowStart = nowMs - SPARKLINE_WINDOW_MS;
  const bucketTpsSum: number[] = new Array(SPARKLINE_BUCKETS).fill(
    0,
  ) as number[];
  const bucketCounts: number[] = new Array(SPARKLINE_BUCKETS).fill(
    0,
  ) as number[];

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
      bucketTpsSum[bucketIndex] = bucketTpsSum[bucketIndex]! + pairTps;
      bucketCounts[bucketIndex] = bucketCounts[bucketIndex]! + 1;
    }
  }

  const bucketTps: number[] = bucketTpsSum.map((sum, i) =>
    bucketCounts[i]! > 0 ? sum / bucketCounts[i]! : 0,
  );

  const maxTps = Math.max(...bucketTps);
  if (maxTps === 0) return "";

  const levels = SPARKLINE_CHARS.length;
  return bucketTps
    .map((value) => {
      if (value === 0) return " ";
      const index = Math.min(
        levels - 1,
        Math.floor((value / maxTps) * (levels - 1)),
      );
      return SPARKLINE_CHARS[index] ?? SPARKLINE_CHARS[levels - 1]!;
    })
    .join("");
}

function snapshotFingerprint(snapshot: TuiSnapshot): string {
  const tickets =
    snapshot.tickets.length > 0
      ? snapshot.tickets
      : snapshot.running.map(legacyRunningEntryToTicket);
  return JSON.stringify({
    trackerKind: snapshot.trackerKind,
    trackerSubject: snapshot.trackerSubject,
    liveRunCount: snapshot.liveRunCount,
    tickets: tickets.map((entry) => ({
      issueNumber: entry.issueNumber,
      identifier: entry.identifier,
      title: entry.title,
      status: entry.status,
      summary: entry.summary,
      updatedAt: entry.updatedAt,
      pullRequestNumber: entry.pullRequest?.number ?? null,
      pendingChecks: entry.checks.pendingNames.length,
      failingChecks: entry.checks.failingNames.length,
      actionableReview: entry.review.actionableCount,
      unresolvedThreads: entry.review.unresolvedThreadCount,
      blockedReason: entry.blockedReason,
      runnerAccounting:
        entry.runnerAccounting === undefined
          ? null
          : {
              inputTokens: entry.runnerAccounting.inputTokens,
              outputTokens: entry.runnerAccounting.outputTokens,
              totalTokens: entry.runnerAccounting.totalTokens,
            },
      liveRun:
        entry.liveRun === null
          ? null
          : {
              startedAt: entry.liveRun.startedAt,
              retryAttempt: entry.liveRun.retryAttempt,
              sessionId: entry.liveRun.sessionId,
              turnCount: entry.liveRun.turnCount,
              codexTokenState: entry.liveRun.codexTokenState,
              codexTotalTokens: entry.liveRun.codexTotalTokens,
              codexInputTokens: entry.liveRun.codexInputTokens,
              codexOutputTokens: entry.liveRun.codexOutputTokens,
              codexAppServerPid: entry.liveRun.codexAppServerPid,
              lastCodexEvent: entry.liveRun.lastCodexEvent,
              lastCodexMessage: entry.liveRun.lastCodexMessage,
              lastCodexTimestamp: entry.liveRun.lastCodexTimestamp,
            },
      runnerVisibility:
        entry.runnerVisibility === null
          ? null
          : {
              state: entry.runnerVisibility.state,
              session: {
                provider: entry.runnerVisibility.session.provider,
                model: entry.runnerVisibility.session.model,
                backendSessionId:
                  entry.runnerVisibility.session.backendSessionId,
                backendThreadId: entry.runnerVisibility.session.backendThreadId,
                latestTurnId: entry.runnerVisibility.session.latestTurnId,
                latestTurnNumber:
                  entry.runnerVisibility.session.latestTurnNumber,
              },
              lastActionSummary: entry.runnerVisibility.lastActionSummary,
              waitingReason: entry.runnerVisibility.waitingReason,
              stdoutSummary: entry.runnerVisibility.stdoutSummary,
              errorSummary: entry.runnerVisibility.errorSummary,
              cancelledAt: entry.runnerVisibility.cancelledAt,
              timedOutAt: entry.runnerVisibility.timedOutAt,
            },
    })),
    running: snapshot.running.map((entry) => ({
      issueNumber: entry.issueNumber,
      identifier: entry.identifier,
      issueState: entry.issueState,
      lifecycle:
        entry.lifecycle == null
          ? null
          : {
              status: entry.lifecycle.status,
              summary: entry.lifecycle.summary,
              pullRequestNumber: entry.lifecycle.pullRequest?.number ?? null,
              pendingChecks: entry.lifecycle.checks.pendingNames.length,
              failingChecks: entry.lifecycle.checks.failingNames.length,
              actionableReview: entry.lifecycle.review.actionableCount,
              unresolvedThreads: entry.lifecycle.review.unresolvedThreadCount,
            },
      startedAt: entry.startedAt,
      retryAttempt: entry.retryAttempt,
      sessionId: entry.sessionId,
      turnCount: entry.turnCount,
      codexTokenState: entry.codexTokenState,
      codexTotalTokens: entry.codexTotalTokens,
      codexInputTokens: entry.codexInputTokens,
      codexOutputTokens: entry.codexOutputTokens,
      codexAppServerPid: entry.codexAppServerPid,
      lastCodexEvent: entry.lastCodexEvent,
      lastCodexMessage: entry.lastCodexMessage,
      lastCodexTimestamp: entry.lastCodexTimestamp,
      runnerVisibility:
        entry.runnerVisibility === null
          ? null
          : {
              state: entry.runnerVisibility.state,
              session: {
                provider: entry.runnerVisibility.session.provider,
                model: entry.runnerVisibility.session.model,
                backendSessionId:
                  entry.runnerVisibility.session.backendSessionId,
                backendThreadId: entry.runnerVisibility.session.backendThreadId,
                latestTurnId: entry.runnerVisibility.session.latestTurnId,
                latestTurnNumber:
                  entry.runnerVisibility.session.latestTurnNumber,
              },
              lastActionSummary: entry.runnerVisibility.lastActionSummary,
              waitingReason: entry.runnerVisibility.waitingReason,
              stdoutSummary: entry.runnerVisibility.stdoutSummary,
              errorSummary: entry.runnerVisibility.errorSummary,
              cancelledAt: entry.runnerVisibility.cancelledAt,
              timedOutAt: entry.runnerVisibility.timedOutAt,
            },
    })),
    retrying: snapshot.retrying.map((entry) => ({
      issueNumber: entry.issueNumber,
      identifier: entry.identifier,
      nextAttempt: entry.nextAttempt,
      preferredHost: entry.preferredHost,
      retryClass: entry.retryClass,
      lastError: entry.lastError,
    })),
    codexTotals: {
      inputTokens: snapshot.codexTotals.inputTokens,
      outputTokens: snapshot.codexTotals.outputTokens,
      totalTokens: snapshot.codexTotals.totalTokens,
      pendingRunCount: snapshot.codexTotals.pendingRunCount,
    },
    rateLimits: snapshot.rateLimits,
    factoryHalt: snapshot.factoryHalt,
    recoveryPosture: {
      summary: {
        family: snapshot.recoveryPosture.summary.family,
        summary: snapshot.recoveryPosture.summary.summary,
        issueCount: snapshot.recoveryPosture.summary.issueCount,
      },
      entries: snapshot.recoveryPosture.entries.map((entry) => ({
        family: entry.family,
        issueNumber: entry.issueNumber,
        source: entry.source,
        summary: entry.summary,
      })),
    },
    lastAction:
      snapshot.lastAction === null
        ? null
        : {
            kind: snapshot.lastAction.kind,
            issueNumber: snapshot.lastAction.issueNumber,
            summary: snapshot.lastAction.summary,
            at: snapshot.lastAction.at,
          },
    polling: {
      checkingNow: snapshot.polling.checkingNow,
      intervalMs: snapshot.polling.intervalMs,
    },
    maxConcurrentRuns: snapshot.maxConcurrentRuns,
    maxTurns: snapshot.maxTurns,
    projectUrl: snapshot.projectUrl,
  });
}

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
