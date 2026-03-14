import { randomUUID } from "node:crypto";
import { OrchestratorError, RunnerAbortedError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryState } from "../domain/retry.js";
import type { RunSession, RunTurn, RunUpdateEvent } from "../domain/run.js";
import type {
  PromptBuilder,
  ResolvedConfig,
  WatchdogConfig,
} from "../domain/workflow.js";
import type {
  IssueArtifactAttemptSnapshot,
  IssueArtifactCheckSnapshot,
  IssueArtifactEvent,
  IssueArtifactLogPointer,
  IssueArtifactLogPointerSessionEntry,
  IssueArtifactObservation,
  IssueArtifactOutcome,
  IssueArtifactPullRequestSnapshot,
  IssueArtifactReviewSnapshot,
  IssueArtifactSessionSnapshot,
  IssueArtifactStore,
} from "../observability/issue-artifacts.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  LocalIssueArtifactStore,
} from "../observability/issue-artifacts.js";
import type { Logger } from "../observability/logger.js";
import {
  deriveStatusFilePath,
  writeFactoryStatusSnapshot,
} from "../observability/status.js";
import type {
  FactoryCheckStatus,
  FactoryIssueStatus,
  FactoryPullRequestStatus,
  FactoryReviewStatus,
  FactoryStatusAction,
} from "../observability/status.js";
import type {
  LiveRunnerSession,
  Runner,
  RunnerEvent,
  RunnerSpawnedEvent,
  RunnerVisibilitySnapshot,
  RunnerTurnResult,
} from "../runner/service.js";
import type { Tracker } from "../tracker/service.js";
import type { LandingExecutionResult } from "../tracker/service.js";
import type { WorkspaceManager } from "../workspace/service.js";
import {
  createContinuationRunTurn,
  type RunSessionArtifactsState,
  summarizeMissingTargetFailure,
  shouldContinueTurnLoop,
} from "./continuation-turns.js";
import {
  clearLandingRuntimeState,
  noteLandingAttempt,
  shouldExecuteLanding,
} from "./landing-state.js";
import {
  clearFollowUpRuntimeState,
  noteLifecycleObservation,
  noteRetryScheduled,
  resolveFailureRetryAttempt,
  resolveRunSequence,
} from "./follow-up-state.js";
import { LocalIssueLeaseManager } from "./issue-lease.js";
import type { LivenessProbe } from "./liveness-probe.js";
import {
  createRunningEntry,
  integrateCodexUpdate,
  type CodexTokenState,
} from "./running-entry.js";
import {
  type LivenessSource,
  type StallReason,
  checkStall,
  canRecover,
  DEFAULT_WATCHDOG_CONFIG,
} from "./stall-detector.js";
import {
  createOrchestratorState,
  type CodexTotals,
  type RateLimits,
  type PollingState,
} from "./state.js";
import {
  adjustTrackerIssueCounts,
  buildFactoryStatusSnapshot,
  clearActiveIssue,
  noteLifecycleForIssue,
  noteStatusAction,
  setTrackerIssueCounts,
  upsertActiveIssue,
} from "./status-state.js";
import {
  clearActiveWatchdogEntry,
  clearWatchdogAbortReason,
  clearWatchdogIssueState,
  initWatchdogEntry,
  noteWatchdogAbortReason,
  readWatchdogAbortReason,
  recordWatchdogRecovery,
} from "./watchdog-state.js";
import { summarizeRunnerText } from "../runner/service.js";

export interface TuiRunningEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly issueState: string;
  readonly lifecycle?: TuiLifecycleSnapshot | null;
  readonly startedAt: Date;
  readonly retryAttempt: number;
  readonly sessionId: string | null;
  readonly turnCount: number;
  readonly codexTokenState: CodexTokenState;
  readonly codexTotalTokens: number;
  readonly codexInputTokens: number;
  readonly codexOutputTokens: number;
  readonly codexAppServerPid: number | null;
  readonly lastCodexEvent: string | null;
  readonly lastCodexMessage: unknown;
  readonly lastCodexTimestamp: string | null;
  readonly runnerVisibility: RunnerVisibilitySnapshot | null;
}

export interface TuiLifecycleSnapshot {
  readonly status: FactoryIssueStatus;
  readonly summary: string;
  readonly pullRequest: FactoryPullRequestStatus | null;
  readonly checks: FactoryCheckStatus;
  readonly review: FactoryReviewStatus;
}

export interface TuiRetryEntry {
  readonly issueNumber: number;
  readonly identifier: string;
  readonly nextAttempt: number;
  readonly dueInMs: number;
  readonly lastError: string;
}

export interface TuiCodexTotals extends CodexTotals {
  readonly pendingRunCount: number;
  readonly secondsRunning: number;
}

export interface TuiSnapshot {
  readonly running: readonly TuiRunningEntry[];
  readonly retrying: readonly TuiRetryEntry[];
  readonly codexTotals: TuiCodexTotals;
  readonly rateLimits: RateLimits | null;
  readonly lastAction: FactoryStatusAction | null;
  readonly polling: PollingState;
  readonly maxConcurrentRuns: number;
  readonly maxTurns: number;
  readonly projectUrl: string | null;
}

export interface Orchestrator {
  runOnce(signal?: AbortSignal): Promise<void>;
  runLoop(signal?: AbortSignal): Promise<void>;
}

interface QueueEntry {
  readonly issue: RuntimeIssue;
  readonly attempt: number;
  readonly source: "ready" | "running";
}

export class BootstrapOrchestrator implements Orchestrator {
  readonly #config: ResolvedConfig;
  readonly #promptBuilder: PromptBuilder;
  readonly #tracker: Tracker;
  readonly #workspaceManager: WorkspaceManager;
  readonly #runner: Runner;
  readonly #logger: Logger;
  readonly #state: ReturnType<typeof createOrchestratorState>;
  readonly #instanceId = randomUUID();
  readonly #leaseManager: LocalIssueLeaseManager;
  readonly #issueArtifactStore: IssueArtifactStore;
  readonly #statusFilePath: string;
  readonly #livenessProbe: LivenessProbe | null;
  readonly #watchdogConfig: WatchdogConfig;
  readonly #factoryStartedAt: number = Date.now();
  #shutdownSignal: AbortSignal | undefined;
  #dashboardNotify: (() => void) | null = null;
  // Guard startup placeholder publication so a later initializing write cannot
  // clobber a current snapshot that has already been persisted.
  #startupStatusPublished = false;

  constructor(
    config: ResolvedConfig,
    promptBuilder: PromptBuilder,
    tracker: Tracker,
    workspaceManager: WorkspaceManager,
    runner: Runner,
    logger: Logger,
    issueArtifactStore?: IssueArtifactStore,
    livenessProbe?: LivenessProbe,
  ) {
    this.#config = config;
    this.#promptBuilder = promptBuilder;
    this.#tracker = tracker;
    this.#workspaceManager = workspaceManager;
    this.#runner = runner;
    this.#logger = logger;
    this.#state = createOrchestratorState(config.polling.intervalMs);
    this.#leaseManager = new LocalIssueLeaseManager(
      config.workspace.root,
      logger,
    );
    this.#issueArtifactStore =
      issueArtifactStore ?? new LocalIssueArtifactStore(config.workspace.root);
    this.#statusFilePath = deriveStatusFilePath(config.workspace.root);
    this.#watchdogConfig = config.polling.watchdog ?? DEFAULT_WATCHDOG_CONFIG;
    this.#livenessProbe = livenessProbe ?? null;
  }

  setDashboardNotify(notify: (() => void) | null): void {
    this.#dashboardNotify = notify;
  }

  snapshot(): TuiSnapshot {
    const now = Date.now();
    const running: TuiRunningEntry[] = [];
    let pendingRunCount = 0;
    for (const entry of this.#state.runningEntries.values()) {
      const activeIssue = this.#state.status.activeIssues.get(
        entry.issueNumber,
      );
      if (entry.codexTokenState === "pending") {
        pendingRunCount += 1;
      }
      running.push({
        issueNumber: entry.issueNumber,
        identifier: entry.identifier,
        issueState: entry.issueState,
        lifecycle:
          activeIssue === undefined
            ? null
            : {
                status: activeIssue.status,
                summary: activeIssue.summary,
                pullRequest: activeIssue.pullRequest,
                checks: activeIssue.checks,
                review: activeIssue.review,
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
        runnerVisibility: activeIssue?.runnerVisibility ?? null,
      });
    }
    running.sort((a, b) => a.identifier.localeCompare(b.identifier));

    const retrying: TuiRetryEntry[] = [];
    for (const retry of this.#state.retries.values()) {
      retrying.push({
        issueNumber: retry.issue.number,
        identifier: retry.issue.identifier,
        nextAttempt: retry.nextAttempt,
        dueInMs: Math.max(0, retry.dueAt - now),
        lastError: retry.lastError,
      });
    }
    retrying.sort((a, b) => a.dueInMs - b.dueInMs);

    return {
      running,
      retrying,
      codexTotals: {
        ...this.#state.codexTotals,
        pendingRunCount,
        secondsRunning: Math.floor((now - this.#factoryStartedAt) / 1000),
      },
      rateLimits: this.#state.rateLimits,
      lastAction: this.#state.status.lastAction,
      polling: { ...this.#state.polling },
      maxConcurrentRuns: this.#config.polling.maxConcurrentRuns,
      maxTurns: this.#config.agent.maxTurns,
      projectUrl: this.#deriveProjectUrl(),
    };
  }

  #deriveProjectUrl(): string | null {
    // Linear URLs require a workspace slug not yet available in LinearTrackerConfig.
    // GitHub has no single canonical project board URL in the current config shape.
    // Both cases return null until the config shape is extended.
    return null;
  }

  #notifyDashboard(): void {
    try {
      this.#dashboardNotify?.();
    } catch {
      // Dashboard is observability-only — never mask orchestrator exceptions.
    }
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    await this.#publishStartupStatusSnapshot();
    // Allow callers (e.g. --once CLI path) to plumb a shutdown signal
    // that propagates to child agent processes via #shutdownSignal.
    const handleAbort =
      signal !== undefined
        ? (): void => {
            this.#abortActiveRuns();
          }
        : undefined;
    if (signal !== undefined) {
      this.#shutdownSignal = signal;
      signal.addEventListener("abort", handleAbort!, { once: true });
    }
    try {
      await this.#runOnceInner();
    } finally {
      if (signal !== undefined) {
        signal.removeEventListener("abort", handleAbort!);
        if (this.#shutdownSignal === signal) {
          this.#shutdownSignal = undefined;
        }
      }
    }
  }

  async #runOnceInner(): Promise<void> {
    this.#state.polling.checkingNow = true;
    this.#notifyDashboard();

    let readyCandidates: readonly RuntimeIssue[];
    let runningCandidates: readonly RuntimeIssue[];
    let failedCandidates: readonly RuntimeIssue[];
    let queue: readonly QueueEntry[];
    let availableSlots: number;

    try {
      noteStatusAction(this.#state.status, {
        kind: "poll-started",
        summary: "Polling tracker for ready and running issues",
        issueNumber: null,
      });
      await this.#persistStatusSnapshot();
      await this.#tracker.ensureLabels();
      this.#logger.info("Poll started");
      [readyCandidates, runningCandidates, failedCandidates] =
        await Promise.all([
          this.#tracker.fetchReadyIssues(),
          this.#tracker.fetchRunningIssues(),
          this.#fetchFailedCandidatesForStatus(),
        ]);
      setTrackerIssueCounts(this.#state.status, {
        ready: readyCandidates.length,
        running: runningCandidates.length,
        failed: failedCandidates.length,
      });
      this.#pruneStaleActiveIssues(readyCandidates, runningCandidates);
      await this.#reconcileRunningIssueOwnership(runningCandidates);
      const dueRetries = this.#collectDueRetries();
      queue = this.#mergeQueue(readyCandidates, runningCandidates, dueRetries);
      availableSlots =
        this.#config.polling.maxConcurrentRuns -
        this.#state.runningIssueNumbers.size;
      this.#logger.info("Poll candidates fetched", {
        readyCount: readyCandidates.length,
        runningCount: runningCandidates.length,
        failedCount: failedCandidates.length,
        candidateCount: queue.length,
        availableSlots,
      });
      noteStatusAction(this.#state.status, {
        kind: "poll-fetched",
        summary: `Found ${readyCandidates.length.toString()} ready, ${runningCandidates.length.toString()} running, ${failedCandidates.length.toString()} failed issues`,
        issueNumber: null,
      });
    } catch (err) {
      this.#state.polling.checkingNow = false;
      try {
        this.#notifyDashboard();
      } catch {
        /* don't mask the original error */
      }
      throw err;
    }
    this.#state.polling.checkingNow = false;
    this.#notifyDashboard();
    await this.#persistStatusSnapshot();

    if (availableSlots <= 0) {
      return;
    }

    const runs: Promise<void>[] = [];
    for (const entry of queue) {
      if (runs.length >= availableSlots) {
        break;
      }
      if (this.#state.runningIssueNumbers.has(entry.issue.number)) {
        continue;
      }
      runs.push(
        entry.source === "ready"
          ? this.#processReadyIssue(entry.issue, entry.attempt)
          : this.#processRunningIssue(entry.issue, entry.attempt),
      );
    }

    await Promise.all(runs);
  }

  async runLoop(signal?: AbortSignal): Promise<void> {
    await this.#publishStartupStatusSnapshot();
    this.#shutdownSignal = signal;
    const handleAbort = (): void => {
      this.#abortActiveRuns();
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    while (!signal?.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.#logger.error("Poll cycle failed", {
          error: this.#normalizeFailure(error as Error),
        });
      }
      if (signal?.aborted) {
        break;
      }
      this.#state.polling.nextPollAtMs =
        Date.now() + this.#config.polling.intervalMs;
      this.#notifyDashboard();
      await this.#sleep(this.#config.polling.intervalMs, signal);
    }
    // signal is optional — keep ?. for safety even though TypeScript narrows
    // it to non-null after the while loop (the loop runs forever if undefined).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    signal?.removeEventListener("abort", handleAbort);
    if (this.#shutdownSignal === signal) {
      this.#shutdownSignal = undefined;
    }
  }

  #collectDueRetries(): readonly RetryState[] {
    const now = Date.now();
    const due: RetryState[] = [];
    for (const [issueNumber, entry] of this.#state.retries.entries()) {
      if (entry.dueAt <= now) {
        due.push(entry);
        this.#state.retries.delete(issueNumber);
      }
    }
    return due;
  }

  #mergeQueue(
    readyCandidates: readonly RuntimeIssue[],
    runningCandidates: readonly RuntimeIssue[],
    dueRetries: readonly RetryState[],
  ): readonly QueueEntry[] {
    const retryAttempts = new Map<number, number>();
    for (const retry of dueRetries) {
      retryAttempts.set(retry.issue.number, retry.nextAttempt);
    }

    const merged = new Map<number, QueueEntry>();
    for (const issue of runningCandidates) {
      if (
        !retryAttempts.has(issue.number) &&
        this.#state.retries.has(issue.number)
      ) {
        continue;
      }
      merged.set(issue.number, {
        issue,
        attempt: this.#resolveAttemptNumber(issue.number, retryAttempts),
        source: "running",
      });
    }
    for (const issue of readyCandidates) {
      if (
        !retryAttempts.has(issue.number) &&
        this.#state.retries.has(issue.number)
      ) {
        continue;
      }
      if (merged.has(issue.number)) {
        continue;
      }
      merged.set(issue.number, {
        issue,
        attempt: this.#resolveAttemptNumber(issue.number, retryAttempts),
        source: "ready",
      });
    }

    return [...merged.values()].sort((left, right) => {
      if (left.source !== right.source) {
        return left.source === "running" ? -1 : 1;
      }
      return left.issue.number - right.issue.number;
    });
  }

  #resolveAttemptNumber(
    issueNumber: number,
    retryAttempts: ReadonlyMap<number, number>,
  ): number {
    return resolveRunSequence(this.#state.followUp, issueNumber, retryAttempts);
  }

  async #processReadyIssue(
    issue: RuntimeIssue,
    attempt: number,
  ): Promise<void> {
    await this.#withIssueLease(issue, attempt, async (lockDir) => {
      const claimed = await this.#tracker.claimIssue(issue.number);
      if (claimed === null) {
        this.#logger.info("Issue was no longer claimable", {
          issueNumber: issue.number,
        });
        noteStatusAction(this.#state.status, {
          kind: "claim-skipped",
          summary: `Issue #${issue.number.toString()} was no longer claimable`,
          issueNumber: issue.number,
        });
        await this.#persistStatusSnapshot();
        return;
      }
      upsertActiveIssue(this.#state.status, claimed, {
        source: "ready",
        runSequence: attempt,
        branchName: this.#branchName(claimed.number),
        status: "queued",
        summary: `Claimed ${claimed.identifier}`,
        ownerPid: process.pid,
      });
      adjustTrackerIssueCounts(this.#state.status, {
        ready: -1,
        running: 1,
      });
      noteStatusAction(this.#state.status, {
        kind: "issue-claimed",
        summary: `Claimed ${claimed.identifier}`,
        issueNumber: claimed.number,
      });
      await this.#persistStatusSnapshot();
      const observedAt = new Date().toISOString();
      await this.#recordIssueArtifact({
        issue: this.#createIssueArtifactUpdate(claimed, {
          observedAt,
          outcome: "claimed",
          summary: `Claimed ${claimed.identifier}`,
          branchName: this.#branchName(claimed.number),
          latestAttemptNumber: attempt,
        }),
        events: [
          this.#createIssueEvent("claimed", claimed, {
            observedAt,
            attemptNumber: attempt,
            details: {
              branch: this.#branchName(claimed.number),
            },
          }),
        ],
      });
      await this.#processClaimedIssue(
        claimed,
        attempt,
        lockDir,
        this.#missingLifecycle(claimed.number),
      );
    });
  }

  async #processRunningIssue(
    issue: RuntimeIssue,
    attempt: number,
  ): Promise<void> {
    await this.#withIssueLease(issue, attempt, async (lockDir) => {
      upsertActiveIssue(this.#state.status, issue, {
        source: "running",
        runSequence: attempt,
        branchName: this.#branchName(issue.number),
        status: "queued",
        summary: `Inspecting ${issue.identifier}`,
        ownerPid: process.pid,
      });
      noteStatusAction(this.#state.status, {
        kind: "issue-resumed",
        summary: `Inspecting running issue ${issue.identifier}`,
        issueNumber: issue.number,
      });
      await this.#persistStatusSnapshot();
      const observedAt = new Date().toISOString();
      await this.#recordIssueArtifact({
        issue: this.#createIssueArtifactUpdate(issue, {
          observedAt,
          outcome: "running",
          summary: `Inspecting ${issue.identifier}`,
          branchName: this.#branchName(issue.number),
        }),
      });
      await this.#processClaimedIssue(issue, attempt, lockDir);
    });
  }

  async #withIssueLease(
    issue: RuntimeIssue,
    attempt: number,
    work: (lockDir: string) => Promise<void>,
  ): Promise<void> {
    const lease = await this.#leaseManager.acquire(issue.number);
    if (!lease) {
      return;
    }
    this.#state.runningIssueNumbers.add(issue.number);
    try {
      await work(lease);
    } catch (error) {
      await this.#handleUnexpectedFailure(issue, attempt, error as Error);
    } finally {
      this.#state.runningIssueNumbers.delete(issue.number);
      await this.#leaseManager.release(lease);
      await this.#persistStatusSnapshot();
    }
  }

  async #processClaimedIssue(
    issue: RuntimeIssue,
    attempt: number,
    lockDir: string,
    initialLifecycle?: HandoffLifecycle,
  ): Promise<void> {
    const branchName = this.#branchName(issue.number);
    const issueSource = initialLifecycle !== undefined ? "ready" : "running";
    const lifecycle =
      initialLifecycle ?? (await this.#refreshLifecycle(branchName));

    if (lifecycle.kind === "handoff-ready") {
      clearLandingRuntimeState(this.#state.landing, issue.number);
      await this.#completeIssue(issue);
      await this.#cleanupIssueWorkspaceIfNeeded(issue);
      return;
    }

    if (
      lifecycle.kind === "awaiting-system-checks" ||
      lifecycle.kind === "awaiting-human-handoff" ||
      lifecycle.kind === "awaiting-human-review" ||
      lifecycle.kind === "awaiting-landing-command"
    ) {
      clearLandingRuntimeState(this.#state.landing, issue.number);
      noteLifecycleForIssue(
        this.#state.status,
        issue,
        issueSource,
        attempt,
        branchName,
        lifecycle,
      );
      this.#logger.info("Issue remains in handoff review", {
        issueNumber: issue.number,
        summary: lifecycle.summary,
      });
      noteStatusAction(this.#state.status, {
        kind: lifecycle.kind,
        summary: lifecycle.summary,
        issueNumber: issue.number,
      });
      await this.#persistStatusSnapshot();
      await this.#recordIssueArtifact(
        this.#createLifecycleObservation(issue, attempt, branchName, lifecycle),
      );
      return;
    }

    if (lifecycle.kind === "awaiting-landing") {
      await this.#handleLandingLifecycle(
        issue,
        attempt,
        issueSource,
        branchName,
        lifecycle,
      );
      return;
    }

    await this.#runIssue(
      issue,
      attempt,
      lockDir,
      issueSource,
      lifecycle.kind === "missing-target" ? null : lifecycle,
    );
  }

  async #handleLandingLifecycle(
    issue: RuntimeIssue,
    attempt: number,
    source: "ready" | "running",
    branchName: string,
    lifecycle: HandoffLifecycle,
  ): Promise<void> {
    const headSha = lifecycle.pullRequest?.headSha ?? null;
    if (shouldExecuteLanding(this.#state.landing, issue.number, headSha)) {
      await this.#executeLanding(issue, attempt, source, branchName, lifecycle);
      return;
    }

    noteLifecycleForIssue(
      this.#state.status,
      issue,
      source,
      attempt,
      branchName,
      lifecycle,
    );
    noteStatusAction(this.#state.status, {
      kind: lifecycle.kind,
      summary: lifecycle.summary,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createLifecycleObservation(issue, attempt, branchName, lifecycle),
    );
  }

  async #executeLanding(
    issue: RuntimeIssue,
    attempt: number,
    source: "ready" | "running",
    branchName: string,
    lifecycle: HandoffLifecycle,
  ): Promise<void> {
    const observedAt = new Date().toISOString();
    noteStatusAction(this.#state.status, {
      kind: "landing-started",
      summary: `Executing landing for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    noteLifecycleForIssue(
      this.#state.status,
      issue,
      source,
      attempt,
      branchName,
      lifecycle,
    );
    await this.#persistStatusSnapshot();

    let landingError: string | null = null;
    let landingResult: LandingExecutionResult | null = null;
    try {
      noteLandingAttempt(
        this.#state.landing,
        issue.number,
        lifecycle.pullRequest?.headSha ?? null,
      );
      if (lifecycle.pullRequest === null) {
        throw new Error("Cannot execute landing without a pull request handle");
      }
      landingResult = await this.#tracker.executeLanding(lifecycle.pullRequest);
      if (landingResult.kind === "blocked") {
        this.#logger.info("Landing blocked by guard", {
          issueNumber: issue.number,
          branchName,
          pullRequestNumber: lifecycle.pullRequest.number,
          reason: landingResult.reason,
          lifecycleKind: landingResult.lifecycleKind,
          summary: landingResult.summary,
        });
      }
    } catch (error) {
      landingError = this.#normalizeFailure(error as Error);
      this.#logger.warn("Landing execution failed", {
        issueNumber: issue.number,
        branchName,
        pullRequestNumber: lifecycle.pullRequest?.number ?? null,
        error: landingError,
      });
    }
    await this.#recordIssueArtifact(
      this.#createLandingObservation(
        issue,
        attempt,
        branchName,
        lifecycle,
        observedAt,
        landingResult,
        landingError,
      ),
    );

    const refreshedLifecycle = await this.#refreshLifecycle(branchName);
    if (refreshedLifecycle.kind === "handoff-ready") {
      clearLandingRuntimeState(this.#state.landing, issue.number);
      await this.#completeIssue(issue, {
        attemptNumber: attempt,
        branchName,
        finishedAt: new Date().toISOString(),
      });
      await this.#cleanupIssueWorkspaceIfNeeded(issue);
      return;
    }

    if (
      landingResult?.kind === "blocked" ||
      refreshedLifecycle.kind !== "awaiting-landing"
    ) {
      clearLandingRuntimeState(this.#state.landing, issue.number);
    }

    // Intentionally record the post-request lifecycle after the landing event.
    // The landing artifact captures that the merge command was issued; this
    // follow-up observation captures the tracker-visible state after refresh.
    noteLifecycleForIssue(
      this.#state.status,
      issue,
      source,
      attempt,
      branchName,
      refreshedLifecycle,
    );
    if (landingResult?.kind === "blocked") {
      upsertActiveIssue(this.#state.status, issue, {
        source,
        runSequence: attempt,
        branchName,
        status: landingResult.lifecycleKind,
        summary: landingResult.summary,
        blockedReason: landingResult.summary,
      });
    }
    noteStatusAction(this.#state.status, {
      kind:
        landingError !== null
          ? "landing-failed"
          : landingResult?.kind === "blocked"
            ? "landing-blocked"
            : refreshedLifecycle.kind,
      summary:
        landingError !== null
          ? `Landing request failed for ${issue.identifier}: ${landingError}`
          : landingResult?.kind === "blocked"
            ? landingResult.summary
            : refreshedLifecycle.summary,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    if (landingError === null) {
      await this.#recordIssueArtifact(
        this.#createLifecycleObservation(
          issue,
          attempt,
          branchName,
          refreshedLifecycle,
        ),
      );
    }
  }

  async #runIssue(
    issue: RuntimeIssue,
    attempt: number,
    lockDir: string,
    source: "ready" | "running",
    pullRequest: HandoffLifecycle | null,
  ): Promise<void> {
    upsertActiveIssue(this.#state.status, issue, {
      source,
      runSequence: attempt,
      branchName: this.#branchName(issue.number),
      status: "preparing",
      summary: `Preparing workspace for ${issue.identifier}`,
      ownerPid: process.pid,
      runnerPid: null,
      blockedReason: null,
      runnerVisibility: null,
    });
    noteStatusAction(this.#state.status, {
      kind: "run-preparing",
      summary: `Preparing workspace for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    const workspace = await this.#workspaceManager.prepareWorkspace({ issue });
    const initialPrompt = await this.#promptBuilder.build({
      issue,
      attempt: attempt > 1 ? attempt : null,
      pullRequest,
    });
    const session = this.#createRunSession(
      issue,
      workspace,
      initialPrompt,
      attempt,
    );
    let sessionState: RunSessionArtifactsState = {
      runSession: session,
      description: this.#runner.describeSession(session),
      latestTurnNumber: null,
    };
    upsertActiveIssue(this.#state.status, issue, {
      source,
      runSequence: attempt,
      branchName: workspace.branchName,
      status: "running",
      summary: `Running ${issue.identifier}`,
      workspacePath: workspace.path,
      runSessionId: session.id,
      ownerPid: process.pid,
      runnerPid: null,
      startedAt: new Date().toISOString(),
      pullRequest:
        pullRequest?.pullRequest === undefined ||
        pullRequest.pullRequest === null
          ? null
          : {
              number: pullRequest.pullRequest.number,
              url: pullRequest.pullRequest.url,
              headSha: pullRequest.pullRequest.headSha,
              latestCommitAt: pullRequest.pullRequest.latestCommitAt,
            },
      checks: {
        pendingNames: pullRequest?.pendingCheckNames ?? [],
        failingNames: pullRequest?.failingCheckNames ?? [],
      },
      review: {
        actionableCount: pullRequest?.actionableReviewFeedback.length ?? 0,
        unresolvedThreadCount: pullRequest?.unresolvedThreadIds.length ?? 0,
      },
      blockedReason: null,
      runnerVisibility: this.#buildRunnerVisibility(sessionState.description, {
        state: "starting",
        phase: "boot",
        lastHeartbeatAt: session.startedAt,
        lastActionAt: session.startedAt,
        lastActionSummary: "Runner session created",
      }),
    });
    noteStatusAction(this.#state.status, {
      kind: "run-started",
      summary: `Started agent run for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createRunStartedObservation(
        issue,
        attempt,
        sessionState,
        pullRequest,
      ),
    );
    await this.#leaseManager.recordRun(lockDir, session);
    const abortController = new AbortController();
    const shutdownSignal = this.#shutdownSignal;
    const handleShutdown = (): void => {
      abortController.abort();
    };
    if (shutdownSignal?.aborted) {
      abortController.abort();
    } else if (shutdownSignal) {
      shutdownSignal.addEventListener("abort", handleShutdown, { once: true });
    }
    this.#state.runAbortControllers.set(issue.number, abortController);
    this.#initWatchdogEntry(issue.number);

    const watchdogStop = new AbortController();
    const watchdogPromise = this.#runWatchdogLoop(
      issue.number,
      watchdogStop.signal,
    );
    let watchdogStopped = false;
    const stopWatchdog = async (): Promise<void> => {
      if (watchdogStopped) {
        return;
      }
      watchdogStopped = true;
      watchdogStop.abort();
      await watchdogPromise;
    };
    const runEntry = createRunningEntry(
      issue.number,
      issue.identifier,
      issue.state,
      attempt,
    );
    this.#state.runningEntries.set(issue.number, runEntry);
    this.#notifyDashboard();

    let liveRunnerSession: LiveRunnerSession | undefined;
    try {
      liveRunnerSession = await this.#runner.startSession?.(session);
      this.#warnIfContinuationSessionUnavailable(
        issue,
        workspace.branchName,
        session,
        liveRunnerSession,
      );
      let currentLifecycle = pullRequest;
      let turnNumber = 1;

      while (true) {
        const turn = await this.#createRunTurn(
          session.prompt,
          issue,
          currentLifecycle,
          turnNumber,
        );
        this.#setIssueRunnerVisibility(
          issue.number,
          this.#buildRunnerVisibility(sessionState.description, {
            state: "running",
            phase: "turn-execution",
            lastHeartbeatAt: new Date().toISOString(),
            lastActionAt: new Date().toISOString(),
            lastActionSummary: `Starting turn ${turn.turnNumber.toString()}`,
          }),
        );
        await this.#persistStatusSnapshot();
        const result = await this.#runRunnerTurn(
          session,
          liveRunnerSession,
          turn,
          lockDir,
          abortController.signal,
        );
        sessionState = {
          runSession: session,
          description: result.session,
          latestTurnNumber: turn.turnNumber,
        };

        if (result.exitCode !== 0) {
          await stopWatchdog();
          this.#setIssueRunnerVisibility(
            issue.number,
            this.#buildRunnerVisibility(result.session, {
              state: "failed",
              phase: "turn-finished",
              lastHeartbeatAt: result.finishedAt,
              lastActionAt: result.finishedAt,
              lastActionSummary: `Turn ${turn.turnNumber.toString()} failed`,
              stdoutSummary: summarizeRunnerText(result.stdout),
              stderrSummary: summarizeRunnerText(result.stderr),
              errorSummary: summarizeRunnerText(
                `Runner exited with ${result.exitCode}\n${result.stderr}`,
              ),
            }),
          );
          await this.#handleFailure(
            sessionState,
            attempt,
            `Runner exited with ${result.exitCode}\n${result.stderr}`,
            result.finishedAt,
          );
          return;
        }

        this.#setIssueRunnerVisibility(
          issue.number,
          this.#buildRunnerVisibility(result.session, {
            state: "completed",
            phase: "turn-finished",
            lastHeartbeatAt: result.finishedAt,
            lastActionAt: result.finishedAt,
            lastActionSummary: `Turn ${turn.turnNumber.toString()} completed`,
            stdoutSummary: summarizeRunnerText(result.stdout),
            stderrSummary: summarizeRunnerText(result.stderr),
          }),
        );

        this.#setIssueRunnerVisibility(
          issue.number,
          this.#buildRunnerVisibility(result.session, {
            state: "waiting",
            phase: "handoff-reconciliation",
            lastHeartbeatAt: result.finishedAt,
            lastActionAt: result.finishedAt,
            lastActionSummary: `Reconciling handoff after turn ${turn.turnNumber.toString()}`,
            waitingReason: "Waiting for tracker reconciliation",
            stdoutSummary: summarizeRunnerText(result.stdout),
            stderrSummary: summarizeRunnerText(result.stderr),
          }),
          result.finishedAt,
        );
        await this.#persistStatusSnapshot();
        const nextLifecycle = await this.#tracker.reconcileSuccessfulRun(
          workspace.branchName,
          currentLifecycle,
        );

        if (nextLifecycle.kind === "handoff-ready") {
          await stopWatchdog();
          await this.#completeIssue(issue, {
            attemptNumber: attempt,
            branchName: workspace.branchName,
            session: sessionState,
            finishedAt: result.finishedAt,
          });
          await this.#cleanupWorkspaceIfNeeded(workspace, issue.number);
          return;
        }

        if (
          shouldContinueTurnLoop(
            nextLifecycle,
            turn.turnNumber,
            this.#config.agent.maxTurns,
          )
        ) {
          this.#logger.info("Continuing agent turn on live session", {
            issueNumber: issue.number,
            branchName: workspace.branchName,
            runSessionId: session.id,
            backendSessionId: result.session.backendSessionId,
            lifecycle: nextLifecycle.kind,
            turnNumber: turn.turnNumber + 1,
            maxTurns: this.#config.agent.maxTurns,
          });
          currentLifecycle = nextLifecycle;
          turnNumber += 1;
          continue;
        }

        await stopWatchdog();
        await this.#handleTurnLifecycleExit(
          issue,
          attempt,
          source,
          workspace.branchName,
          nextLifecycle,
          sessionState,
          result.finishedAt,
        );
        return;
      }
    } catch (error) {
      await stopWatchdog();
      const normalizedFailure = this.#resolveRunFailureMessage(
        sessionState.runSession.issue.number,
        error as Error,
      );
      this.#setIssueFailureVisibility(
        sessionState.runSession.issue.number,
        sessionState.description,
        error as Error,
        normalizedFailure,
      );
      await this.#handleFailure(
        sessionState,
        attempt,
        normalizedFailure,
        new Date().toISOString(),
      );
    } finally {
      await liveRunnerSession?.close().catch((error) => {
        this.#logger.warn("Failed to close live runner session cleanly", {
          issueNumber: issue.number,
          branchName: workspace.branchName,
          runSessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await stopWatchdog();
      shutdownSignal?.removeEventListener("abort", handleShutdown);
      this.#state.runAbortControllers.delete(issue.number);
      clearActiveWatchdogEntry(this.#state.watchdog, issue.number);
      this.#state.runningEntries.delete(issue.number);
      this.#notifyDashboard();
    }
  }

  async #createRunTurn(
    initialPrompt: string,
    issue: RuntimeIssue,
    pullRequest: HandoffLifecycle | null,
    turnNumber: number,
  ): Promise<RunTurn> {
    return await createContinuationRunTurn({
      initialPrompt,
      promptBuilder: this.#promptBuilder,
      issue,
      pullRequest,
      turnNumber,
      maxTurns: this.#config.agent.maxTurns,
    });
  }

  async #runRunnerTurn(
    session: RunSession,
    liveRunnerSession: LiveRunnerSession | undefined,
    turn: RunTurn,
    lockDir: string,
    signal: AbortSignal,
  ): Promise<RunnerTurnResult> {
    const onEvent = (event: RunnerEvent): void => {
      switch (event.kind) {
        case "spawned":
          this.#recordRunnerSpawn(
            {
              runSession: session,
              description:
                liveRunnerSession?.describe() ??
                this.#runner.describeSession(session),
              latestTurnNumber: turn.turnNumber,
            },
            lockDir,
            event,
            turn.turnNumber,
          );
          this.#notifyDashboard();
          return;
        case "visibility":
          this.#setIssueRunnerVisibility(
            session.issue.number,
            event.visibility,
            event.visibility.lastHeartbeatAt ?? undefined,
          );
          void this.#persistStatusSnapshot();
          return;
      }
    };
    const onUpdate = (event: RunUpdateEvent): void => {
      try {
        const entry = this.#state.runningEntries.get(session.issue.number);
        if (entry !== undefined) {
          const { tokenDelta } = integrateCodexUpdate(entry, event);
          this.#state.codexTotals.inputTokens += tokenDelta.inputTokens;
          this.#state.codexTotals.outputTokens += tokenDelta.outputTokens;
          this.#state.codexTotals.totalTokens += tokenDelta.totalTokens;
        }
      } catch (err: unknown) {
        this.#logger.warn("onUpdate integration error", {
          issueNumber: session.issue.number,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        this.#notifyDashboard();
      } catch {
        /* don't crash the runner stdout handler */
      }
    };
    if (liveRunnerSession !== undefined) {
      return await liveRunnerSession.runTurn(turn, {
        signal,
        onEvent,
        onUpdate,
      });
    }
    const result = await this.#runner.run(
      {
        ...session,
        prompt: turn.prompt,
      },
      {
        signal,
        onEvent,
        onUpdate,
      },
    );
    return {
      ...result,
      session: this.#runner.describeSession(session),
    };
  }

  #warnIfContinuationSessionUnavailable(
    issue: RuntimeIssue,
    branchName: string,
    session: RunSession,
    liveRunnerSession: LiveRunnerSession | undefined,
  ): void {
    if (liveRunnerSession !== undefined || this.#config.agent.maxTurns <= 1) {
      return;
    }

    this.#logger.warn(
      "Runner does not support live continuation sessions; continuation turns will cold-start new subprocesses",
      {
        issueNumber: issue.number,
        branchName,
        runSessionId: session.id,
        maxTurns: this.#config.agent.maxTurns,
      },
    );
  }

  async #handleTurnLifecycleExit(
    issue: RuntimeIssue,
    attempt: number,
    source: "ready" | "running",
    branchName: string,
    lifecycle: HandoffLifecycle,
    session: RunSessionArtifactsState,
    finishedAt: string,
  ): Promise<void> {
    if (
      lifecycle.kind === "awaiting-system-checks" ||
      lifecycle.kind === "awaiting-human-handoff" ||
      lifecycle.kind === "awaiting-human-review" ||
      lifecycle.kind === "awaiting-landing-command" ||
      lifecycle.kind === "awaiting-landing" ||
      lifecycle.kind === "rework-required"
    ) {
      if (lifecycle.kind !== "awaiting-landing") {
        clearLandingRuntimeState(this.#state.landing, issue.number);
      }
      const summary = lifecycle.summary;
      this.#setIssueRunnerVisibility(
        issue.number,
        this.#buildRunnerVisibility(session.description, {
          state: "waiting",
          phase: "awaiting-external",
          lastHeartbeatAt: finishedAt,
          lastActionAt: finishedAt,
          lastActionSummary: `Turn ${session.latestTurnNumber?.toString() ?? "?"} handed off`,
          waitingReason: summary,
        }),
        finishedAt,
      );
      noteLifecycleForIssue(
        this.#state.status,
        issue,
        source,
        attempt,
        branchName,
        lifecycle,
      );
      this.#logger.info("Issue remains in handoff lifecycle", {
        issueNumber: issue.number,
        branchName,
        runSessionId: session.runSession.id,
        backendSessionId: session.description.backendSessionId,
        lifecycle: lifecycle.kind,
        summary,
        turnNumber: session.latestTurnNumber,
      });
      noteStatusAction(this.#state.status, {
        kind: lifecycle.kind,
        summary,
        issueNumber: issue.number,
      });
      await this.#persistStatusSnapshot();
      await this.#recordIssueArtifact(
        this.#createLifecycleObservation(
          issue,
          attempt,
          branchName,
          lifecycle,
          {
            session,
            finishedAt,
          },
        ),
      );

      noteLifecycleObservation(
        this.#state.followUp,
        issue.number,
        attempt,
        lifecycle,
      );
      return;
    }

    if (lifecycle.kind === "missing-target") {
      await this.#handleFailure(
        session,
        attempt,
        summarizeMissingTargetFailure(lifecycle, this.#config.agent.maxTurns),
        finishedAt,
      );
      return;
    }

    throw new OrchestratorError(
      `Unsupported lifecycle exit from runner turn loop: ${lifecycle.kind}`,
    );
  }

  async #completeIssue(
    issue: RuntimeIssue,
    options?: {
      readonly attemptNumber?: number;
      readonly branchName?: string | null;
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string;
    },
  ): Promise<void> {
    const runnerPid = this.#currentRunnerPid(issue.number);
    await this.#tracker.completeIssue(issue.number);
    this.#state.retries.delete(issue.number);
    clearWatchdogIssueState(this.#state.watchdog, issue.number);
    clearFollowUpRuntimeState(this.#state.followUp, issue.number);
    clearLandingRuntimeState(this.#state.landing, issue.number);
    clearActiveIssue(this.#state.status, issue.number);
    adjustTrackerIssueCounts(this.#state.status, {
      running: -1,
    });
    this.#logger.info("Issue completed", { issueNumber: issue.number });
    noteStatusAction(this.#state.status, {
      kind: "issue-completed",
      summary: `Completed issue #${issue.number.toString()}`,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createTerminalObservation(issue, "succeeded", {
        observedAt: options?.finishedAt ?? new Date().toISOString(),
        summary: `Completed ${issue.identifier}`,
        attemptNumber: options?.attemptNumber,
        branchName: options?.branchName ?? this.#branchName(issue.number),
        session: options?.session,
        runnerPid,
      }),
    );
  }

  async #cleanupIssueWorkspaceIfNeeded(issue: RuntimeIssue): Promise<void> {
    if (!this.#config.workspace.cleanupOnSuccess) {
      return;
    }

    try {
      await this.#workspaceManager.cleanupWorkspaceForIssue({ issue });
    } catch (error) {
      this.#logger.error("Workspace cleanup failed", {
        issueNumber: issue.number,
        error: this.#normalizeFailure(error as Error),
      });
    }
  }

  async #cleanupWorkspaceIfNeeded(
    workspace: RunSession["workspace"],
    issueNumber: number,
  ): Promise<void> {
    if (!this.#config.workspace.cleanupOnSuccess) {
      return;
    }

    try {
      await this.#workspaceManager.cleanupWorkspace(workspace);
    } catch (error) {
      this.#logger.error("Workspace cleanup failed", {
        issueNumber,
        workspacePath: workspace.path,
        error: this.#normalizeFailure(error as Error),
      });
    }
  }

  async #refreshLifecycle(branchName: string): Promise<HandoffLifecycle> {
    return await this.#tracker.inspectIssueHandoff(branchName);
  }

  async #reconcileRunningIssueOwnership(
    issues: readonly RuntimeIssue[],
  ): Promise<void> {
    const recoveries = await Promise.allSettled(
      issues.map(async (issue) => ({
        issueNumber: issue.number,
        snapshot: await this.#leaseManager.reconcile(issue.number),
      })),
    );

    for (const [index, recovery] of recoveries.entries()) {
      if (recovery.status === "rejected") {
        this.#logger.error("Failed to reconcile running issue ownership", {
          issueNumber: issues[index]?.number,
          error: this.#normalizeFailure(
            recovery.reason instanceof Error
              ? recovery.reason
              : new Error(String(recovery.reason)),
          ),
        });
        continue;
      }
      const { issueNumber, snapshot } = recovery.value;
      if (snapshot.kind === "missing" || snapshot.kind === "active") {
        continue;
      }
      this.#logger.warn("Recovered stale local run ownership", {
        issueNumber,
        ownershipState: snapshot.kind,
        ownerPid: snapshot.ownerPid,
        runnerPid: snapshot.runnerPid,
        runSessionId: snapshot.record?.runSessionId ?? null,
      });
      noteStatusAction(this.#state.status, {
        kind: "ownership-recovered",
        summary: `Recovered stale ownership for issue #${issueNumber.toString()}`,
        issueNumber,
      });
      await this.#persistStatusSnapshot();
    }
  }

  #pruneStaleActiveIssues(
    readyIssues: readonly RuntimeIssue[],
    runningIssues: readonly RuntimeIssue[],
  ): void {
    const retainedIssueNumbers = new Set<number>([
      ...readyIssues.map((issue) => issue.number),
      ...runningIssues.map((issue) => issue.number),
      ...this.#state.runningIssueNumbers,
      ...this.#state.retries.keys(),
    ]);

    for (const issueNumber of this.#state.status.activeIssues.keys()) {
      if (retainedIssueNumbers.has(issueNumber)) {
        continue;
      }
      clearActiveIssue(this.#state.status, issueNumber);
    }
  }

  #createRunSession(
    issue: RuntimeIssue,
    workspace: RunSession["workspace"],
    prompt: string,
    attempt: number,
  ): RunSession {
    return {
      id: `${issue.identifier}/attempt-${attempt}-${this.#instanceId}`,
      issue,
      workspace,
      prompt,
      startedAt: new Date().toISOString(),
      attempt: {
        sequence: attempt,
      },
    };
  }

  #branchName(issueNumber: number): string {
    return `${this.#config.workspace.branchPrefix}${issueNumber.toString()}`;
  }

  #missingLifecycle(issueNumber: number): HandoffLifecycle {
    const branchName = this.#branchName(issueNumber);
    return {
      kind: "missing-target",
      branchName,
      pullRequest: null,
      checks: [],
      pendingCheckNames: [],
      failingCheckNames: [],
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      summary: `No open pull request found for ${branchName}`,
    };
  }

  async #handleFailure(
    session: RunSession | RunSessionArtifactsState,
    attempt: number,
    message: string,
    finishedAt = new Date().toISOString(),
  ): Promise<void> {
    const runSession = "runSession" in session ? session.runSession : session;
    const sessionState =
      "runSession" in session
        ? session
        : {
            runSession,
            description: this.#runner.describeSession(runSession),
            latestTurnNumber: null,
          };
    this.#logger.error("Issue run failed", {
      issueNumber: runSession.issue.number,
      attempt,
      error: message,
      workspacePath: runSession.workspace.path,
      runSessionId: runSession.id,
    });
    noteStatusAction(this.#state.status, {
      kind: "run-failed",
      summary: message,
      issueNumber: runSession.issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createAttemptFailureObservation(
        sessionState,
        attempt,
        message,
        finishedAt,
      ),
    );
    await this.#scheduleRetryOrFailSafely(runSession.issue, attempt, message, {
      session: sessionState,
      finishedAt,
    });
  }

  async #handleUnexpectedFailure(
    issue: RuntimeIssue,
    attempt: number,
    error: Error,
  ): Promise<void> {
    const message = this.#normalizeFailure(error);
    this.#logger.error("Unexpected issue failure", {
      issueNumber: issue.number,
      attempt,
      error: message,
    });
    noteStatusAction(this.#state.status, {
      kind: "unexpected-failure",
      summary: message,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#scheduleRetryOrFailSafely(issue, attempt, message);
  }

  async #scheduleRetryOrFailSafely(
    issue: RuntimeIssue,
    attempt: number,
    message: string,
    options?: {
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string;
    },
  ): Promise<void> {
    try {
      await this.#scheduleRetryOrFail(issue, attempt, message, options);
    } catch (error) {
      this.#logger.error("Failure handling failed", {
        issueNumber: issue.number,
        attempt,
        originalError: message,
        error: this.#normalizeFailure(error as Error),
      });
    }
  }

  async #scheduleRetryOrFail(
    issue: RuntimeIssue,
    runSequence: number,
    message: string,
    options?: {
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string;
    },
  ): Promise<void> {
    if (
      await this.#completeIssueIfMergedDuringFailure(
        issue,
        runSequence,
        message,
        options,
      )
    ) {
      return;
    }

    const failureRetryAttempt = resolveFailureRetryAttempt(
      this.#state.followUp,
      issue.number,
    );
    if (failureRetryAttempt < this.#config.polling.retry.maxAttempts) {
      await this.#tracker.recordRetry(issue.number, message);
      this.#state.retries.set(
        issue.number,
        noteRetryScheduled(
          this.#state.followUp,
          issue,
          runSequence,
          failureRetryAttempt,
          this.#config.polling.retry.backoffMs,
          message,
        ),
      );
      clearActiveIssue(this.#state.status, issue.number);
      noteStatusAction(this.#state.status, {
        kind: "retry-scheduled",
        summary: `Retry ${this.#state.retries
          .get(issue.number)!
          .nextAttempt.toString()} scheduled for ${issue.identifier}`,
        issueNumber: issue.number,
      });
      this.#notifyDashboard();
      await this.#persistStatusSnapshot();
      await this.#recordIssueArtifact(
        this.#createRetryScheduledObservation(
          issue,
          runSequence,
          message,
          this.#state.retries.get(issue.number)!.nextAttempt,
        ),
      );
      return;
    }
    const failureOptions = {
      attemptNumber: runSequence,
      branchName:
        options?.session?.runSession.workspace.branchName ??
        this.#branchName(issue.number),
      ...(options?.session === undefined ? {} : { session: options.session }),
      ...(options?.finishedAt === undefined
        ? {}
        : { finishedAt: options.finishedAt }),
    };
    await this.#failIssue(issue, message, failureOptions);
  }

  async #completeIssueIfMergedDuringFailure(
    issue: RuntimeIssue,
    runSequence: number,
    message: string,
    options?: {
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string;
    },
  ): Promise<boolean> {
    const branchName =
      options?.session?.runSession.workspace.branchName ??
      this.#branchName(issue.number);
    const refreshedLifecycle = await this.#refreshLifecycle(branchName);
    if (refreshedLifecycle.kind !== "handoff-ready") {
      return false;
    }

    this.#logger.info(
      "Suppressing retry and failure handling after merged terminal reconciliation",
      {
        issueNumber: issue.number,
        branchName,
        attempt: runSequence,
        summary: refreshedLifecycle.summary,
        originalFailure: message,
      },
    );
    // The attempt-failed observation recorded earlier preserves the original
    // failure detail. The issue-level terminal outcome must converge to the
    // merged success story, so do not forward that failure message here.
    await this.#completeIssue(issue, {
      attemptNumber: runSequence,
      branchName,
      ...(options?.session === undefined ? {} : { session: options.session }),
      ...(options?.finishedAt === undefined
        ? {}
        : { finishedAt: options.finishedAt }),
    });
    if (options?.session !== undefined) {
      await this.#cleanupWorkspaceIfNeeded(
        options.session.runSession.workspace,
        issue.number,
      );
      return true;
    }
    await this.#cleanupIssueWorkspaceIfNeeded(issue);
    return true;
  }

  async #failIssue(
    issue: RuntimeIssue,
    message: string,
    options?: {
      readonly attemptNumber?: number;
      readonly branchName?: string | null;
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string;
      readonly lifecycle?: HandoffLifecycle | null;
    },
  ): Promise<void> {
    const runnerPid = this.#currentRunnerPid(issue.number);
    await this.#tracker.markIssueFailed(issue.number, message);
    this.#state.retries.delete(issue.number);
    clearWatchdogIssueState(this.#state.watchdog, issue.number);
    clearFollowUpRuntimeState(this.#state.followUp, issue.number);
    clearLandingRuntimeState(this.#state.landing, issue.number);
    clearActiveIssue(this.#state.status, issue.number);
    adjustTrackerIssueCounts(this.#state.status, {
      running: -1,
      failed: 1,
    });
    noteStatusAction(this.#state.status, {
      kind: "issue-failed",
      summary: message,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createTerminalObservation(issue, "failed", {
        observedAt: options?.finishedAt ?? new Date().toISOString(),
        summary: message,
        attemptNumber: options?.attemptNumber,
        branchName: options?.branchName ?? this.#branchName(issue.number),
        session: options?.session,
        runnerPid,
        lifecycle: options?.lifecycle ?? null,
      }),
    );
  }

  async #recordIssueArtifact(
    observation: IssueArtifactObservation,
  ): Promise<void> {
    const issueNumber = observation.issue.issueNumber;
    const write = async (): Promise<void> => {
      try {
        await this.#issueArtifactStore.recordObservation(observation);
      } catch (error) {
        this.#logger.warn("Failed to write issue artifact", {
          issueNumber: observation.issue.issueNumber,
          attemptNumber: observation.issue.latestAttemptNumber ?? null,
          sessionId: observation.issue.latestSessionId ?? null,
          error: this.#normalizeFailure(error as Error),
        });
      }
    };

    const previousQueue =
      this.#state.artifactWriteQueues.get(issueNumber) ?? Promise.resolve();
    const nextQueue = previousQueue.then(write, write);
    this.#state.artifactWriteQueues.set(issueNumber, nextQueue);
    try {
      await nextQueue;
    } catch {
      // write() logs and absorbs its own failures; this is purely defensive.
    } finally {
      if (this.#state.artifactWriteQueues.get(issueNumber) === nextQueue) {
        this.#state.artifactWriteQueues.delete(issueNumber);
      }
    }
  }

  #createIssueArtifactUpdate(
    issue: RuntimeIssue,
    options: {
      readonly observedAt: string;
      readonly outcome: IssueArtifactOutcome;
      readonly summary: string;
      readonly branchName?: string | null | undefined;
      readonly latestAttemptNumber?: number | null | undefined;
      readonly latestSessionId?: string | null | undefined;
    },
  ) {
    return {
      issueNumber: issue.number,
      issueIdentifier: issue.identifier,
      repo: this.#trackerSubject(),
      title: issue.title,
      issueUrl: issue.url,
      branch: options.branchName,
      currentOutcome: options.outcome,
      currentSummary: options.summary,
      observedAt: options.observedAt,
      latestAttemptNumber: options.latestAttemptNumber,
      latestSessionId: options.latestSessionId,
    } as const;
  }

  #trackerSubject(): string {
    return this.#tracker.subject();
  }

  #createIssueEvent(
    kind: IssueArtifactEvent["kind"],
    issue: RuntimeIssue,
    options: {
      readonly observedAt: string;
      readonly attemptNumber?: number | null | undefined;
      readonly sessionId?: string | null | undefined;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ): IssueArtifactEvent {
    return {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      kind,
      issueNumber: issue.number,
      observedAt: options.observedAt,
      attemptNumber: options.attemptNumber ?? null,
      sessionId: options.sessionId ?? null,
      details: options.details ?? {},
    };
  }

  #createRunStartedObservation(
    issue: RuntimeIssue,
    attempt: number,
    session: RunSessionArtifactsState,
    lifecycle: HandoffLifecycle | null,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(session);
    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt: session.runSession.startedAt,
        outcome: "running",
        summary: `Running ${issue.identifier}`,
        branchName: session.runSession.workspace.branchName,
        latestAttemptNumber: attempt,
        latestSessionId: session.runSession.id,
      }),
      attempt: this.#createAttemptArtifact(issue, attempt, {
        outcome: "running",
        summary: `Running ${issue.identifier}`,
        branchName: session.runSession.workspace.branchName,
        sessionId: session.runSession.id,
        startedAt: session.runSession.startedAt,
        lifecycle,
        latestTurnNumber: session.latestTurnNumber,
      }),
      ...sessionArtifacts,
    };
  }

  #createLifecycleObservation(
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    lifecycle: HandoffLifecycle,
    options?: {
      readonly session?: RunSessionArtifactsState;
      readonly finishedAt?: string | undefined;
    },
  ): IssueArtifactObservation {
    const observedAt = options?.finishedAt ?? new Date().toISOString();
    const currentOutcome = this.#createLifecycleOutcome(lifecycle);
    const event = this.#createLifecycleEvent(
      issue,
      attempt,
      options?.session?.runSession.id ?? null,
      lifecycle,
      observedAt,
      options?.session?.latestTurnNumber ?? null,
      options?.session?.description.backendSessionId ?? null,
    );
    const sessionArtifacts =
      options?.session === undefined
        ? undefined
        : this.#createSessionObservationArtifacts(options.session, observedAt);

    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt,
        outcome: currentOutcome,
        summary: lifecycle.summary,
        branchName,
        latestAttemptNumber:
          options?.session === undefined ? undefined : attempt,
        latestSessionId: options?.session?.runSession.id,
      }),
      events: event === null ? [] : [event],
      attempt:
        options?.session === undefined
          ? undefined
          : this.#createAttemptArtifact(issue, attempt, {
              outcome: currentOutcome,
              summary: lifecycle.summary,
              branchName,
              sessionId: options.session.runSession.id,
              startedAt: options.session.runSession.startedAt,
              finishedAt: observedAt,
              lifecycle,
              runnerPid: this.#currentRunnerPid(issue.number),
              latestTurnNumber: options.session.latestTurnNumber,
            }),
      session: sessionArtifacts?.session,
      logPointers: sessionArtifacts?.logPointers,
    };
  }

  #createAttemptFailureObservation(
    session: RunSessionArtifactsState,
    attempt: number,
    message: string,
    finishedAt: string,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(
      session,
      finishedAt,
    );
    return {
      issue: this.#createIssueArtifactUpdate(session.runSession.issue, {
        observedAt: finishedAt,
        outcome: "attempt-failed",
        summary: `Run failed for ${session.runSession.issue.identifier}; evaluating retry state`,
        branchName: session.runSession.workspace.branchName,
        latestAttemptNumber: attempt,
        latestSessionId: session.runSession.id,
      }),
      attempt: this.#createAttemptArtifact(session.runSession.issue, attempt, {
        outcome: "failed",
        summary: message,
        branchName: session.runSession.workspace.branchName,
        sessionId: session.runSession.id,
        startedAt: session.runSession.startedAt,
        finishedAt,
        runnerPid: this.#currentRunnerPid(session.runSession.issue.number),
        latestTurnNumber: session.latestTurnNumber,
      }),
      ...sessionArtifacts,
    };
  }

  #createRetryScheduledObservation(
    issue: RuntimeIssue,
    attempt: number,
    message: string,
    nextAttempt: number,
  ): IssueArtifactObservation {
    const observedAt = new Date().toISOString();
    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt,
        outcome: "retry-scheduled",
        summary: `Retry ${nextAttempt.toString()} scheduled for ${issue.identifier}`,
        branchName: this.#branchName(issue.number),
        latestAttemptNumber: attempt,
      }),
      events: [
        this.#createIssueEvent("retry-scheduled", issue, {
          observedAt,
          attemptNumber: attempt,
          details: {
            nextAttempt,
            reason: message,
          },
        }),
      ],
    };
  }

  #createTerminalObservation(
    issue: RuntimeIssue,
    outcome: "succeeded" | "failed",
    options: {
      readonly observedAt: string;
      readonly summary: string;
      readonly attemptNumber?: number | undefined;
      readonly branchName?: string | null | undefined;
      readonly session?: RunSessionArtifactsState | undefined;
      readonly runnerPid?: number | null | undefined;
      readonly lifecycle?: HandoffLifecycle | null | undefined;
    },
  ): IssueArtifactObservation {
    const sessionArtifacts =
      options.session === undefined
        ? undefined
        : this.#createSessionObservationArtifacts(
            options.session,
            options.observedAt,
          );
    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt: options.observedAt,
        outcome,
        summary: options.summary,
        branchName: options.branchName,
        latestAttemptNumber: options.attemptNumber,
        latestSessionId: options.session?.runSession.id,
      }),
      events: [
        this.#createIssueEvent(outcome, issue, {
          observedAt: options.observedAt,
          attemptNumber: options.attemptNumber,
          sessionId: options.session?.runSession.id,
          details: {
            branch: options.branchName ?? null,
            summary: options.summary,
            latestTurnNumber: options.session?.latestTurnNumber ?? null,
            backendSessionId:
              options.session?.description.backendSessionId ?? null,
          },
        }),
      ],
      attempt:
        options.attemptNumber === undefined
          ? undefined
          : this.#createAttemptArtifact(issue, options.attemptNumber, {
              outcome,
              summary: options.summary,
              branchName: options.branchName ?? null,
              sessionId: options.session?.runSession.id ?? null,
              startedAt: options.session?.runSession.startedAt ?? null,
              finishedAt: options.observedAt,
              lifecycle: options.lifecycle ?? null,
              runnerPid: options.runnerPid ?? null,
              latestTurnNumber: options.session?.latestTurnNumber ?? null,
            }),
      session: sessionArtifacts?.session,
      logPointers: sessionArtifacts?.logPointers,
    };
  }

  #createRunnerSpawnObservation(
    session: RunSessionArtifactsState,
    event: RunnerSpawnedEvent,
    turnNumber: number,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(session);
    return {
      issue: this.#createIssueArtifactUpdate(session.runSession.issue, {
        observedAt: event.spawnedAt,
        outcome: "running",
        summary: `Running ${session.runSession.issue.identifier}`,
        branchName: session.runSession.workspace.branchName,
        latestAttemptNumber: session.runSession.attempt.sequence,
        latestSessionId: session.runSession.id,
      }),
      events: [
        this.#createIssueEvent("runner-spawned", session.runSession.issue, {
          observedAt: event.spawnedAt,
          attemptNumber: session.runSession.attempt.sequence,
          sessionId: session.runSession.id,
          details: {
            pid: event.pid,
            turnNumber,
            backendSessionId: session.description.backendSessionId,
          },
        }),
      ],
      attempt: this.#createAttemptArtifact(
        session.runSession.issue,
        session.runSession.attempt.sequence,
        {
          outcome: "running",
          summary: `Running ${session.runSession.issue.identifier}`,
          branchName: session.runSession.workspace.branchName,
          sessionId: session.runSession.id,
          startedAt: session.runSession.startedAt,
          runnerPid: event.pid,
          latestTurnNumber: session.latestTurnNumber,
        },
      ),
      ...sessionArtifacts,
    };
  }

  #createLifecycleEvent(
    issue: RuntimeIssue,
    attempt: number,
    sessionId: string | null,
    lifecycle: HandoffLifecycle,
    observedAt: string,
    latestTurnNumber: number | null,
    backendSessionId: string | null,
  ): IssueArtifactEvent | null {
    if (lifecycle.kind === "awaiting-human-handoff") {
      return this.#createIssueEvent("plan-ready", issue, {
        observedAt,
        attemptNumber: attempt,
        sessionId,
        details: this.#createLifecycleEventDetails(
          lifecycle,
          latestTurnNumber,
          backendSessionId,
        ),
      });
    }

    if (
      lifecycle.kind !== "awaiting-landing-command" &&
      lifecycle.kind !== "awaiting-human-review" &&
      lifecycle.kind !== "awaiting-system-checks" &&
      lifecycle.kind !== "awaiting-landing" &&
      lifecycle.kind !== "rework-required"
    ) {
      return null;
    }

    const kind =
      lifecycle.actionableReviewFeedback.length > 0 ||
      lifecycle.unresolvedThreadIds.length > 0
        ? "review-feedback"
        : "pr-opened";

    return this.#createIssueEvent(kind, issue, {
      observedAt,
      attemptNumber: attempt,
      sessionId,
      details: this.#createLifecycleEventDetails(
        lifecycle,
        latestTurnNumber,
        backendSessionId,
      ),
    });
  }

  #createLifecycleOutcome(
    lifecycle: HandoffLifecycle,
  ): Extract<
    IssueArtifactOutcome,
    | "awaiting-plan-review"
    | "awaiting-human-review"
    | "awaiting-system-checks"
    | "awaiting-landing-command"
    | "awaiting-landing"
    | "rework-required"
  > {
    switch (lifecycle.kind) {
      case "awaiting-human-handoff":
        return "awaiting-plan-review";
      case "awaiting-human-review":
        return "awaiting-human-review";
      case "awaiting-system-checks":
        return "awaiting-system-checks";
      case "awaiting-landing-command":
        return "awaiting-landing-command";
      case "awaiting-landing":
        return "awaiting-landing";
      case "rework-required":
        return "rework-required";
      case "missing-target":
      case "handoff-ready":
        break;
    }
    throw new OrchestratorError(
      `Unsupported lifecycle kind for issue artifact outcome: ${lifecycle.kind}`,
    );
  }

  #createLifecycleEventDetails(
    lifecycle: HandoffLifecycle,
    latestTurnNumber?: number | null,
    backendSessionId?: string | null,
  ): Readonly<Record<string, unknown>> {
    return {
      lifecycleKind: lifecycle.kind,
      branch: lifecycle.branchName,
      summary: lifecycle.summary,
      latestTurnNumber: latestTurnNumber ?? null,
      backendSessionId: backendSessionId ?? null,
      pullRequest:
        lifecycle.pullRequest === null
          ? null
          : {
              number: lifecycle.pullRequest.number,
              url: lifecycle.pullRequest.url,
              headSha: lifecycle.pullRequest.headSha,
              latestCommitAt: lifecycle.pullRequest.latestCommitAt,
            },
      checks: {
        pendingNames: [...lifecycle.pendingCheckNames],
        failingNames: [...lifecycle.failingCheckNames],
      },
      review: {
        actionableCount: lifecycle.actionableReviewFeedback.length,
        unresolvedThreadCount: lifecycle.unresolvedThreadIds.length,
      },
    };
  }

  #createLandingObservation(
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    lifecycle: HandoffLifecycle,
    observedAt: string,
    result: LandingExecutionResult | null,
    error: string | null,
  ): IssueArtifactObservation {
    const isBlocked = result?.kind === "blocked";
    const isFailed = error !== null;
    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt,
        outcome: isFailed
          ? "attempt-failed"
          : isBlocked
            ? result.lifecycleKind
            : "awaiting-landing",
        summary: isFailed
          ? `Landing request failed for ${issue.identifier}: ${error}`
          : isBlocked
            ? result.summary
            : `Landing requested for ${issue.identifier}`,
        branchName,
        latestAttemptNumber: attempt,
      }),
      events: [
        this.#createIssueEvent(
          isFailed
            ? "landing-failed"
            : isBlocked
              ? "landing-blocked"
              : "landing-requested",
          issue,
          {
            observedAt,
            attemptNumber: attempt,
            details: {
              branch: branchName,
              pullRequest:
                lifecycle.pullRequest === null
                  ? null
                  : {
                      number: lifecycle.pullRequest.number,
                      url: lifecycle.pullRequest.url,
                      headSha: lifecycle.pullRequest.headSha,
                    },
              success: error === null && !isBlocked,
              error,
              reason: isBlocked ? result.reason : null,
              summary: isFailed
                ? `Landing request failed for ${issue.identifier}: ${error}`
                : isBlocked
                  ? result.summary
                  : null,
              lifecycleKind: isFailed
                ? "attempt-failed"
                : isBlocked
                  ? result.lifecycleKind
                  : "awaiting-landing",
            },
          },
        ),
      ],
    };
  }

  #createSessionObservationArtifacts(
    session: RunSessionArtifactsState,
    finishedAt?: string,
  ): {
    readonly session: IssueArtifactSessionSnapshot;
    readonly logPointers: IssueArtifactLogPointerSessionEntry;
  } {
    return {
      session: this.#createSessionArtifact(session, finishedAt),
      logPointers: this.#createSessionLogPointers(session),
    };
  }

  #createAttemptArtifact(
    issue: RuntimeIssue,
    attempt: number,
    options: {
      readonly outcome: IssueArtifactOutcome;
      readonly summary: string;
      readonly branchName: string | null;
      readonly sessionId: string | null;
      readonly startedAt: string | null;
      readonly finishedAt?: string | null;
      readonly lifecycle?: HandoffLifecycle | null;
      readonly runnerPid?: number | null;
      readonly latestTurnNumber?: number | null;
    },
  ): IssueArtifactAttemptSnapshot {
    return {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber: issue.number,
      attemptNumber: attempt,
      branch: options.branchName,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt ?? null,
      outcome: options.outcome,
      summary: options.summary,
      sessionId: options.sessionId,
      latestTurnNumber: options.latestTurnNumber ?? null,
      runnerPid: options.runnerPid ?? null,
      pullRequest: this.#createPullRequestArtifactSnapshot(
        options.lifecycle ?? null,
      ),
      review: this.#createReviewArtifactSnapshot(options.lifecycle ?? null),
      checks: this.#createCheckArtifactSnapshot(options.lifecycle ?? null),
    };
  }

  #createSessionArtifact(
    session: RunSessionArtifactsState,
    finishedAt?: string,
  ): IssueArtifactSessionSnapshot {
    return {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber: session.runSession.issue.number,
      attemptNumber: session.runSession.attempt.sequence,
      sessionId: session.runSession.id,
      provider: session.description.provider,
      model: session.description.model,
      backendSessionId: session.description.backendSessionId,
      backendThreadId: session.description.backendThreadId,
      latestTurnId: session.description.latestTurnId,
      appServerPid: session.description.appServerPid,
      latestTurnNumber: session.latestTurnNumber,
      startedAt: session.runSession.startedAt,
      finishedAt: finishedAt ?? null,
      workspacePath: session.runSession.workspace.path,
      branch: session.runSession.workspace.branchName,
      logPointers: session.description.logPointers.map((pointer) =>
        this.#createLogPointer(pointer),
      ),
    };
  }

  #createSessionLogPointers(
    session: RunSessionArtifactsState,
  ): IssueArtifactLogPointerSessionEntry {
    return {
      sessionId: session.runSession.id,
      pointers: session.description.logPointers.map((pointer) =>
        this.#createLogPointer(pointer),
      ),
      archiveLocation: null,
    };
  }

  #createLogPointer(pointer: {
    readonly name: string;
    readonly location: string | null;
    readonly archiveLocation: string | null;
  }): IssueArtifactLogPointer {
    return {
      name: pointer.name,
      location: pointer.location,
      archiveLocation: pointer.archiveLocation,
    };
  }

  #createPullRequestArtifactSnapshot(
    lifecycle: HandoffLifecycle | null,
  ): IssueArtifactPullRequestSnapshot | null {
    if (lifecycle === null || lifecycle.pullRequest === null) {
      return null;
    }
    return {
      number: lifecycle.pullRequest.number,
      url: lifecycle.pullRequest.url,
      headSha: lifecycle.pullRequest.headSha,
      latestCommitAt: lifecycle.pullRequest.latestCommitAt,
    };
  }

  #createReviewArtifactSnapshot(
    lifecycle: HandoffLifecycle | null,
  ): IssueArtifactReviewSnapshot | null {
    if (lifecycle === null) {
      return null;
    }
    return {
      actionableCount: lifecycle.actionableReviewFeedback.length,
      unresolvedThreadCount: lifecycle.unresolvedThreadIds.length,
    };
  }

  #createCheckArtifactSnapshot(
    lifecycle: HandoffLifecycle | null,
  ): IssueArtifactCheckSnapshot | null {
    if (lifecycle === null) {
      return null;
    }
    return {
      pendingNames: [...lifecycle.pendingCheckNames],
      failingNames: [...lifecycle.failingCheckNames],
    };
  }

  #currentRunnerPid(issueNumber: number): number | null {
    return this.#state.status.activeIssues.get(issueNumber)?.runnerPid ?? null;
  }

  #normalizeFailure(error: Error): string {
    if (error instanceof RunnerAbortedError) {
      return error.message;
    }
    return error instanceof OrchestratorError
      ? error.message
      : `${error.name}: ${error.message}`;
  }

  #recordRunnerSpawn(
    session: RunSessionArtifactsState,
    lockDir: string,
    event: RunnerSpawnedEvent,
    turnNumber: number,
  ): void {
    const issueNumber = session.runSession.issue.number;
    this.#leaseManager.recordRunnerSpawn(lockDir, event);
    const entry = this.#state.status.activeIssues.get(issueNumber);
    if (entry) {
      this.#state.status.activeIssues.set(issueNumber, {
        ...entry,
        runnerPid: event.pid,
        updatedAt: event.spawnedAt,
        runnerVisibility: this.#buildRunnerVisibility(
          {
            ...(entry.runnerVisibility?.session ?? session.description),
            appServerPid: event.pid,
          },
          {
            ...(entry.runnerVisibility === null
              ? {
                  state: "starting",
                  phase: "session-start",
                }
              : {
                  state: entry.runnerVisibility.state,
                  phase: entry.runnerVisibility.phase,
                }),
            lastHeartbeatAt:
              entry.runnerVisibility?.lastHeartbeatAt ?? event.spawnedAt,
            lastActionAt: event.spawnedAt,
            lastActionSummary: `Runner process spawned for turn ${turnNumber.toString()}`,
            waitingReason: entry.runnerVisibility?.waitingReason ?? null,
            stdoutSummary: entry.runnerVisibility?.stdoutSummary ?? null,
            stderrSummary: entry.runnerVisibility?.stderrSummary ?? null,
            errorSummary: entry.runnerVisibility?.errorSummary ?? null,
            cancelledAt: entry.runnerVisibility?.cancelledAt ?? null,
            timedOutAt: entry.runnerVisibility?.timedOutAt ?? null,
          },
        ),
      });
    }
    noteStatusAction(this.#state.status, {
      kind: "runner-spawned",
      summary: `Runner PID ${event.pid.toString()} attached for turn ${turnNumber.toString()}`,
      issueNumber,
      at: event.spawnedAt,
    });
    // The runner event callback is synchronous; snapshot persistence is optional.
    void this.#persistStatusSnapshot();
    void this.#recordIssueArtifact(
      this.#createRunnerSpawnObservation(session, event, turnNumber),
    );
    this.#logger.info("Runner process attached to active issue", {
      issueNumber,
      runnerPid: event.pid,
      spawnedAt: event.spawnedAt,
      turnNumber,
    });
  }

  #setIssueRunnerVisibility(
    issueNumber: number,
    runnerVisibility: RunnerVisibilitySnapshot,
    updatedAt?: string,
  ): void {
    const entry = this.#state.status.activeIssues.get(issueNumber);
    if (entry === undefined) {
      return;
    }
    this.#state.status.activeIssues.set(issueNumber, {
      ...entry,
      updatedAt: updatedAt ?? runnerVisibility.lastActionAt ?? entry.updatedAt,
      runnerVisibility,
    });
  }

  #setIssueFailureVisibility(
    issueNumber: number,
    session: RunSessionArtifactsState["description"],
    error: Error,
    normalizedError = this.#normalizeFailure(error),
  ): void {
    const observedAt = new Date().toISOString();
    if (error instanceof RunnerAbortedError) {
      this.#setIssueRunnerVisibility(
        issueNumber,
        this.#buildRunnerVisibility(session, {
          state: "cancelled",
          phase: "shutdown",
          lastHeartbeatAt: observedAt,
          lastActionAt: observedAt,
          lastActionSummary: "Runner cancelled",
          errorSummary: normalizedError,
          cancelledAt: observedAt,
        }),
        observedAt,
      );
      return;
    }
    const timedOut = normalizedError.includes("timed out");
    this.#setIssueRunnerVisibility(
      issueNumber,
      this.#buildRunnerVisibility(session, {
        state: timedOut ? "timed-out" : "failed",
        phase: timedOut ? "shutdown" : "turn-finished",
        lastHeartbeatAt: observedAt,
        lastActionAt: observedAt,
        lastActionSummary: timedOut ? "Runner timed out" : "Runner failed",
        errorSummary: normalizedError,
        ...(timedOut ? { timedOutAt: observedAt } : {}),
      }),
      observedAt,
    );
  }

  #resolveRunFailureMessage(issueNumber: number, error: Error): string {
    if (error instanceof RunnerAbortedError) {
      const watchdogAbort = readWatchdogAbortReason(
        this.#state.watchdog,
        issueNumber,
      );
      if (watchdogAbort !== null) {
        return watchdogAbort.summary;
      }
    }
    return this.#normalizeFailure(error);
  }

  #formatWatchdogAbortSummary(
    issueNumber: number,
    reason: StallReason,
    stalledForMs: number,
    lastObservableActivityAt: number,
    lastObservableActivitySource: LivenessSource | null,
    recoveryExhausted: boolean,
  ): string {
    const lastObservedAt = new Date(lastObservableActivityAt).toISOString();
    const source =
      lastObservableActivitySource === null
        ? "unknown"
        : lastObservableActivitySource;
    const recoveryText = recoveryExhausted
      ? "recovery limit reached, aborting"
      : "aborting runner for retry";
    return `Stall detected (${reason}) for issue #${issueNumber.toString()} after ${stalledForMs.toString()}ms since ${source} at ${lastObservedAt}; ${recoveryText}`;
  }

  #buildRunnerVisibility(
    session: RunSessionArtifactsState["description"],
    options: {
      readonly state: RunnerVisibilitySnapshot["state"];
      readonly phase: RunnerVisibilitySnapshot["phase"];
      readonly lastHeartbeatAt?: string | null;
      readonly lastActionAt?: string | null;
      readonly lastActionSummary?: string | null;
      readonly waitingReason?: string | null;
      readonly stdoutSummary?: string | null;
      readonly stderrSummary?: string | null;
      readonly errorSummary?: string | null;
      readonly cancelledAt?: string | null;
      readonly timedOutAt?: string | null;
    },
  ): RunnerVisibilitySnapshot {
    return {
      state: options.state,
      phase: options.phase,
      session,
      lastHeartbeatAt: options.lastHeartbeatAt ?? null,
      lastActionAt: options.lastActionAt ?? null,
      lastActionSummary: options.lastActionSummary ?? null,
      waitingReason: options.waitingReason ?? null,
      stdoutSummary: options.stdoutSummary ?? null,
      stderrSummary: options.stderrSummary ?? null,
      errorSummary: options.errorSummary ?? null,
      cancelledAt: options.cancelledAt ?? null,
      timedOutAt: options.timedOutAt ?? null,
    };
  }

  #abortActiveRuns(): void {
    for (const controller of this.#state.runAbortControllers.values()) {
      controller.abort();
    }
  }

  async #persistStatusSnapshot(): Promise<void> {
    try {
      await writeFactoryStatusSnapshot(
        this.#statusFilePath,
        buildFactoryStatusSnapshot({
          state: this.#state.status,
          instanceId: this.#instanceId,
          workerPid: process.pid,
          pollIntervalMs: this.#config.polling.intervalMs,
          maxConcurrentRuns: this.#config.polling.maxConcurrentRuns,
          activeLocalRuns: this.#state.runningIssueNumbers.size,
          retries: this.#state.retries,
        }),
      );
      // Prevent a later #publishStartupStatusSnapshot call from overwriting
      // this current snapshot with an initializing placeholder.
      this.#startupStatusPublished = true;
    } catch (error) {
      this.#logger.warn("Failed to write status snapshot", {
        statusFilePath: this.#statusFilePath,
        error: this.#normalizeFailure(error as Error),
      });
    }
  }

  async #fetchFailedCandidatesForStatus(): Promise<readonly RuntimeIssue[]> {
    try {
      return await this.#tracker.fetchFailedIssues();
    } catch (error) {
      this.#logger.warn("Failed to fetch failed issues for status snapshot", {
        error: this.#normalizeFailure(error as Error),
      });
      return [];
    }
  }

  async #publishStartupStatusSnapshot(): Promise<void> {
    if (this.#startupStatusPublished) {
      return;
    }
    try {
      await writeFactoryStatusSnapshot(
        this.#statusFilePath,
        buildFactoryStatusSnapshot({
          state: this.#state.status,
          instanceId: this.#instanceId,
          workerPid: process.pid,
          pollIntervalMs: this.#config.polling.intervalMs,
          maxConcurrentRuns: this.#config.polling.maxConcurrentRuns,
          activeLocalRuns: this.#state.runningIssueNumbers.size,
          retries: this.#state.retries,
          publicationState: "initializing",
          publicationDetail:
            "Factory startup is in progress; no current runtime snapshot is available yet.",
        }),
      );
      this.#startupStatusPublished = true;
    } catch (error) {
      this.#logger.warn("Failed to write startup status snapshot", {
        statusFilePath: this.#statusFilePath,
        error: this.#normalizeFailure(error as Error),
      });
    }
  }

  async #sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, durationMs);
      const handleAbort = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      };
      if (!signal) {
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    });
  }
  #initWatchdogEntry(issueNumber: number): void {
    if (
      !this.#watchdogConfig.enabled ||
      this.#livenessProbe === null ||
      this.#state.watchdog.activeEntries.has(issueNumber)
    ) {
      return;
    }
    clearWatchdogAbortReason(this.#state.watchdog, issueNumber);
    const activeIssue = this.#state.status.activeIssues.get(issueNumber);
    const now = Date.now();
    initWatchdogEntry(this.#state.watchdog, issueNumber, {
      logSizeBytes: null,
      workspaceDiffHash: null,
      prHeadSha: null,
      runStartedAt: activeIssue?.startedAt ?? null,
      runnerPhase: activeIssue?.runnerVisibility?.phase ?? null,
      runnerHeartbeatAt: activeIssue?.runnerVisibility?.lastHeartbeatAt ?? null,
      runnerActionAt: activeIssue?.runnerVisibility?.lastActionAt ?? null,
      hasActionableFeedback: (activeIssue?.review.actionableCount ?? 0) > 0,
      capturedAt: now,
    });
  }

  async #runWatchdogLoop(
    issueNumber: number,
    stopSignal: AbortSignal,
  ): Promise<void> {
    if (!this.#watchdogConfig.enabled) {
      return;
    }
    if (this.#livenessProbe === null) {
      this.#logger.warn(
        "Watchdog is enabled but no liveness probe was provided; stall detection is disabled",
        { issueNumber },
      );
      return;
    }
    const entry = this.#state.watchdog.activeEntries.get(issueNumber);
    if (!entry) {
      return;
    }
    while (!stopSignal.aborted) {
      await this.#sleep(this.#watchdogConfig.checkIntervalMs, stopSignal);
      // Re-check after sleep: the signal may have fired during the await.
      // TypeScript narrows .aborted to false at loop entry and does not
      // widen it back after the await, so we suppress the lint here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (stopSignal.aborted) {
        break;
      }
      const activeIssue = this.#state.status.activeIssues.get(issueNumber);
      try {
        const snapshot = await this.#livenessProbe.capture({
          issueNumber,
          workspacePath: activeIssue?.workspacePath ?? null,
          runSessionId: activeIssue?.runSessionId ?? null,
          prHeadSha: activeIssue?.pullRequest?.headSha ?? null,
          runStartedAt: activeIssue?.startedAt ?? null,
          runnerPhase: activeIssue?.runnerVisibility?.phase ?? null,
          runnerHeartbeatAt:
            activeIssue?.runnerVisibility?.lastHeartbeatAt ?? null,
          runnerActionAt: activeIssue?.runnerVisibility?.lastActionAt ?? null,
          hasActionableFeedback: (activeIssue?.review.actionableCount ?? 0) > 0,
        });
        const result = checkStall(entry, snapshot, this.#watchdogConfig);
        if (result.stalled && result.reason !== null) {
          if (canRecover(entry, this.#watchdogConfig)) {
            await this.#recoverStalledRunner(issueNumber, {
              reason: result.reason,
              stalledForMs: result.stalledForMs,
              lastObservableActivityAt: result.lastObservableActivityAt,
              lastObservableActivitySource: result.lastObservableActivitySource,
            });
            break;
          }
          const observedAt = new Date().toISOString();
          const summary = this.#formatWatchdogAbortSummary(
            issueNumber,
            result.reason,
            result.stalledForMs,
            result.lastObservableActivityAt,
            result.lastObservableActivitySource,
            true,
          );
          this.#logger.warn("Stalled runner exceeded recovery limit", {
            issueNumber,
            reason: result.reason,
            recoveryCount: entry.recoveryCount,
            lastObservableActivityAt: new Date(
              result.lastObservableActivityAt,
            ).toISOString(),
            lastObservableActivitySource: result.lastObservableActivitySource,
          });
          noteStatusAction(this.#state.status, {
            kind: "watchdog-recovery-exhausted",
            summary,
            issueNumber,
            at: observedAt,
          });
          noteWatchdogAbortReason(this.#state.watchdog, issueNumber, {
            reason: result.reason,
            summary,
            observedAt,
            recoveryExhausted: true,
            lastObservableActivityAt: result.lastObservableActivityAt,
            lastObservableActivitySource: result.lastObservableActivitySource,
          });
          await this.#persistStatusSnapshot();
          const controller = this.#state.runAbortControllers.get(issueNumber);
          if (controller) {
            controller.abort();
          }
          break;
        }
      } catch (error) {
        this.#logger.warn("Watchdog liveness probe failed", {
          issueNumber,
          error: this.#normalizeFailure(error as Error),
        });
      }
    }
  }

  async #recoverStalledRunner(
    issueNumber: number,
    result: {
      readonly reason: StallReason;
      readonly stalledForMs: number;
      readonly lastObservableActivityAt: number;
      readonly lastObservableActivitySource: LivenessSource | null;
    },
  ): Promise<void> {
    const entry = this.#state.watchdog.activeEntries.get(issueNumber);
    if (!entry) {
      return;
    }
    recordWatchdogRecovery(this.#state.watchdog, entry);
    const observedAt = new Date().toISOString();
    const summary = this.#formatWatchdogAbortSummary(
      issueNumber,
      result.reason,
      result.stalledForMs,
      result.lastObservableActivityAt,
      result.lastObservableActivitySource,
      false,
    );
    this.#logger.warn("Recovering stalled runner", {
      issueNumber,
      reason: result.reason,
      recoveryCount: entry.recoveryCount,
      lastObservableActivityAt: new Date(
        result.lastObservableActivityAt,
      ).toISOString(),
      lastObservableActivitySource: result.lastObservableActivitySource,
    });
    noteStatusAction(this.#state.status, {
      kind: "watchdog-recovery",
      summary,
      issueNumber,
      at: observedAt,
    });
    noteWatchdogAbortReason(this.#state.watchdog, issueNumber, {
      reason: result.reason,
      summary,
      observedAt,
      recoveryExhausted: false,
      lastObservableActivityAt: result.lastObservableActivityAt,
      lastObservableActivitySource: result.lastObservableActivitySource,
    });
    await this.#persistStatusSnapshot();
    const controller = this.#state.runAbortControllers.get(issueNumber);
    if (controller) {
      controller.abort();
    }
  }
}
