import { randomUUID } from "node:crypto";
import { OrchestratorError, RunnerAbortedError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryState } from "../domain/retry.js";
import type { RunResult, RunSpawnEvent, RunSession } from "../domain/run.js";
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
import type { Runner, RunnerSessionDescription } from "../runner/service.js";
import type { Tracker } from "../tracker/service.js";
import type { WorkspaceManager } from "../workspace/service.js";
import {
  clearFollowUpRuntimeState,
  noteLifecycleObservation,
  noteRetryScheduled,
  resolveFailureRetryAttempt,
  resolveRunSequence,
} from "./follow-up-state.js";
import { LocalIssueLeaseManager } from "./issue-lease.js";
import { createOrchestratorState } from "./state.js";
import type { LivenessProbe } from "./liveness-probe.js";
import {
  type StallReason,
  createWatchdogEntry,
  checkStall,
  canRecover,
  recordRecovery,
  DEFAULT_WATCHDOG_CONFIG,
} from "./stall-detector.js";
import {
  adjustTrackerIssueCounts,
  buildFactoryStatusSnapshot,
  clearActiveIssue,
  noteLifecycleForIssue,
  noteStatusAction,
  setTrackerIssueCounts,
  upsertActiveIssue,
} from "./status-state.js";

export interface Orchestrator {
  runOnce(): Promise<void>;
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
  readonly #state = createOrchestratorState();
  readonly #instanceId = randomUUID();
  readonly #leaseManager: LocalIssueLeaseManager;
  readonly #issueArtifactStore: IssueArtifactStore;
  readonly #statusFilePath: string;
  readonly #livenessProbe: LivenessProbe | null;
  readonly #watchdogConfig: WatchdogConfig;
  #shutdownSignal: AbortSignal | undefined;

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

  async runOnce(): Promise<void> {
    noteStatusAction(this.#state.status, {
      kind: "poll-started",
      summary: "Polling tracker for ready and running issues",
      issueNumber: null,
    });
    await this.#persistStatusSnapshot();
    await this.#tracker.ensureLabels();
    this.#logger.info("Poll started");
    const [readyCandidates, runningCandidates, failedCandidates] =
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
    const queue = this.#mergeQueue(
      readyCandidates,
      runningCandidates,
      dueRetries,
    );
    const availableSlots =
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
      await this.#sleep(this.#config.polling.intervalMs, signal);
    }
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
      await this.#completeIssue(issue);
      await this.#cleanupIssueWorkspaceIfNeeded(issue);
      return;
    }

    if (
      lifecycle.kind === "awaiting-system-checks" ||
      lifecycle.kind === "awaiting-human-handoff" ||
      lifecycle.kind === "awaiting-landing"
    ) {
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

    await this.#runIssue(
      issue,
      attempt,
      lockDir,
      issueSource,
      lifecycle.kind === "missing-target" ? null : lifecycle,
    );
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
    });
    noteStatusAction(this.#state.status, {
      kind: "run-preparing",
      summary: `Preparing workspace for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    const workspace = await this.#workspaceManager.prepareWorkspace({ issue });
    const prompt = await this.#promptBuilder.build({
      issue,
      attempt: attempt > 1 ? attempt : null,
      pullRequest,
    });
    const session = this.#createRunSession(issue, workspace, prompt, attempt);
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
    });
    noteStatusAction(this.#state.status, {
      kind: "run-started",
      summary: `Started agent run for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createRunStartedObservation(issue, attempt, session, pullRequest),
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

    let result: RunResult;
    try {
      result = await this.#runner.run(session, {
        signal: abortController.signal,
        onSpawn: (event) => {
          this.#recordRunnerSpawn(session, lockDir, event);
        },
      });
    } finally {
      watchdogStop.abort();
      await watchdogPromise;
      shutdownSignal?.removeEventListener("abort", handleShutdown);
      this.#state.runAbortControllers.delete(issue.number);
      this.#state.watchdog.delete(issue.number);
    }

    if (result.exitCode !== 0) {
      await this.#handleFailure(
        session,
        attempt,
        `Runner exited with ${result.exitCode}\n${result.stderr}`,
        result.finishedAt,
      );
      return;
    }

    try {
      const nextLifecycle = await this.#tracker.reconcileSuccessfulRun(
        workspace.branchName,
        pullRequest,
      );

      if (nextLifecycle.kind === "handoff-ready") {
        await this.#completeIssue(issue, {
          attemptNumber: attempt,
          branchName: workspace.branchName,
          session,
          finishedAt: result.finishedAt,
        });
        await this.#cleanupWorkspaceIfNeeded(workspace, issue.number);
        return;
      }

      if (nextLifecycle.kind === "missing-target") {
        await this.#handleFailure(
          session,
          attempt,
          nextLifecycle.summary,
          result.finishedAt,
        );
        return;
      }

      noteLifecycleForIssue(
        this.#state.status,
        issue,
        source,
        attempt,
        workspace.branchName,
        nextLifecycle,
      );
      this.#logger.info("Issue remains in handoff lifecycle", {
        issueNumber: issue.number,
        branchName: workspace.branchName,
        runSessionId: session.id,
        lifecycle: nextLifecycle.kind,
        summary: nextLifecycle.summary,
      });
      noteStatusAction(this.#state.status, {
        kind: nextLifecycle.kind,
        summary: nextLifecycle.summary,
        issueNumber: issue.number,
      });
      await this.#persistStatusSnapshot();
      await this.#recordIssueArtifact(
        this.#createLifecycleObservation(
          issue,
          attempt,
          workspace.branchName,
          nextLifecycle,
          {
            session,
            finishedAt: result.finishedAt,
          },
        ),
      );

      const decision = noteLifecycleObservation(
        this.#state.followUp,
        issue.number,
        attempt,
        nextLifecycle,
        this.#config.polling.retry.maxFollowUpAttempts,
      );
      if (decision.kind === "exhausted") {
        await this.#failIssue(
          issue,
          this.#followUpFailureMessage(nextLifecycle),
          {
            attemptNumber: attempt,
            branchName: workspace.branchName,
            session,
            finishedAt: result.finishedAt,
            lifecycle: nextLifecycle,
          },
        );
      }
    } catch (error) {
      await this.#handleFailure(
        session,
        attempt,
        this.#normalizeFailure(error as Error),
        new Date().toISOString(),
      );
    }
  }

  async #completeIssue(
    issue: RuntimeIssue,
    options?: {
      readonly attemptNumber?: number;
      readonly branchName?: string | null;
      readonly session?: RunSession;
      readonly finishedAt?: string;
    },
  ): Promise<void> {
    const runnerPid = this.#currentRunnerPid(issue.number);
    await this.#tracker.completeIssue(issue.number);
    this.#state.retries.delete(issue.number);
    clearFollowUpRuntimeState(this.#state.followUp, issue.number);
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
    session: RunSession,
    attempt: number,
    message: string,
    finishedAt = new Date().toISOString(),
  ): Promise<void> {
    this.#logger.error("Issue run failed", {
      issueNumber: session.issue.number,
      attempt,
      error: message,
      workspacePath: session.workspace.path,
      runSessionId: session.id,
    });
    noteStatusAction(this.#state.status, {
      kind: "run-failed",
      summary: message,
      issueNumber: session.issue.number,
    });
    await this.#persistStatusSnapshot();
    await this.#recordIssueArtifact(
      this.#createAttemptFailureObservation(
        session,
        attempt,
        message,
        finishedAt,
      ),
    );
    await this.#scheduleRetryOrFailSafely(session.issue, attempt, message, {
      session,
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
      readonly session?: RunSession;
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
      readonly session?: RunSession;
      readonly finishedAt?: string;
    },
  ): Promise<void> {
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
        options?.session?.workspace.branchName ??
        this.#branchName(issue.number),
      ...(options?.session === undefined ? {} : { session: options.session }),
      ...(options?.finishedAt === undefined
        ? {}
        : { finishedAt: options.finishedAt }),
    };
    await this.#failIssue(issue, message, failureOptions);
  }

  async #failIssue(
    issue: RuntimeIssue,
    message: string,
    options?: {
      readonly attemptNumber?: number;
      readonly branchName?: string | null;
      readonly session?: RunSession;
      readonly finishedAt?: string;
      readonly lifecycle?: HandoffLifecycle | null;
    },
  ): Promise<void> {
    const runnerPid = this.#currentRunnerPid(issue.number);
    await this.#tracker.markIssueFailed(issue.number, message);
    this.#state.retries.delete(issue.number);
    clearFollowUpRuntimeState(this.#state.followUp, issue.number);
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
    session: RunSession,
    lifecycle: HandoffLifecycle | null,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(session);
    return {
      issue: this.#createIssueArtifactUpdate(issue, {
        observedAt: session.startedAt,
        outcome: "running",
        summary: `Running ${issue.identifier}`,
        branchName: session.workspace.branchName,
        latestAttemptNumber: attempt,
        latestSessionId: session.id,
      }),
      attempt: this.#createAttemptArtifact(issue, attempt, {
        outcome: "running",
        summary: `Running ${issue.identifier}`,
        branchName: session.workspace.branchName,
        sessionId: session.id,
        startedAt: session.startedAt,
        lifecycle,
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
      readonly session?: RunSession;
      readonly finishedAt?: string | undefined;
    },
  ): IssueArtifactObservation {
    const observedAt = options?.finishedAt ?? new Date().toISOString();
    const currentOutcome = this.#createLifecycleOutcome(lifecycle);
    const event = this.#createLifecycleEvent(
      issue,
      attempt,
      options?.session?.id ?? null,
      lifecycle,
      observedAt,
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
        latestSessionId: options?.session?.id,
      }),
      events: event === null ? [] : [event],
      attempt:
        options?.session === undefined
          ? undefined
          : this.#createAttemptArtifact(issue, attempt, {
              outcome: currentOutcome,
              summary: lifecycle.summary,
              branchName,
              sessionId: options.session.id,
              startedAt: options.session.startedAt,
              finishedAt: observedAt,
              lifecycle,
              runnerPid: this.#currentRunnerPid(issue.number),
            }),
      session: sessionArtifacts?.session,
      logPointers: sessionArtifacts?.logPointers,
    };
  }

  #createAttemptFailureObservation(
    session: RunSession,
    attempt: number,
    message: string,
    finishedAt: string,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(
      session,
      finishedAt,
    );
    return {
      issue: this.#createIssueArtifactUpdate(session.issue, {
        observedAt: finishedAt,
        outcome: "attempt-failed",
        summary: `Run failed for ${session.issue.identifier}; evaluating retry state`,
        branchName: session.workspace.branchName,
        latestAttemptNumber: attempt,
        latestSessionId: session.id,
      }),
      attempt: this.#createAttemptArtifact(session.issue, attempt, {
        outcome: "failed",
        summary: message,
        branchName: session.workspace.branchName,
        sessionId: session.id,
        startedAt: session.startedAt,
        finishedAt,
        runnerPid: this.#currentRunnerPid(session.issue.number),
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
      readonly session?: RunSession | undefined;
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
        latestSessionId: options.session?.id,
      }),
      events: [
        this.#createIssueEvent(outcome, issue, {
          observedAt: options.observedAt,
          attemptNumber: options.attemptNumber,
          sessionId: options.session?.id,
          details: {
            branch: options.branchName ?? null,
            summary: options.summary,
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
              sessionId: options.session?.id ?? null,
              startedAt: options.session?.startedAt ?? null,
              finishedAt: options.observedAt,
              lifecycle: options.lifecycle ?? null,
              runnerPid: options.runnerPid ?? null,
            }),
      session: sessionArtifacts?.session,
      logPointers: sessionArtifacts?.logPointers,
    };
  }

  #createRunnerSpawnObservation(
    session: RunSession,
    event: RunSpawnEvent,
  ): IssueArtifactObservation {
    const sessionArtifacts = this.#createSessionObservationArtifacts(session);
    return {
      issue: this.#createIssueArtifactUpdate(session.issue, {
        observedAt: event.spawnedAt,
        outcome: "running",
        summary: `Running ${session.issue.identifier}`,
        branchName: session.workspace.branchName,
        latestAttemptNumber: session.attempt.sequence,
        latestSessionId: session.id,
      }),
      events: [
        this.#createIssueEvent("runner-spawned", session.issue, {
          observedAt: event.spawnedAt,
          attemptNumber: session.attempt.sequence,
          sessionId: session.id,
          details: {
            pid: event.pid,
          },
        }),
      ],
      attempt: this.#createAttemptArtifact(
        session.issue,
        session.attempt.sequence,
        {
          outcome: "running",
          summary: `Running ${session.issue.identifier}`,
          branchName: session.workspace.branchName,
          sessionId: session.id,
          startedAt: session.startedAt,
          runnerPid: event.pid,
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
  ): IssueArtifactEvent | null {
    if (lifecycle.kind === "awaiting-human-handoff") {
      return this.#createIssueEvent("plan-ready", issue, {
        observedAt,
        attemptNumber: attempt,
        sessionId,
        details: this.#createLifecycleEventDetails(lifecycle),
      });
    }

    if (
      lifecycle.kind !== "awaiting-system-checks" &&
      lifecycle.kind !== "awaiting-landing" &&
      lifecycle.kind !== "actionable-follow-up"
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
      details: this.#createLifecycleEventDetails(lifecycle),
    });
  }

  #createLifecycleOutcome(
    lifecycle: HandoffLifecycle,
  ): Extract<
    IssueArtifactOutcome,
    | "awaiting-plan-review"
    | "awaiting-review"
    | "awaiting-landing"
    | "needs-follow-up"
  > {
    switch (lifecycle.kind) {
      case "awaiting-human-handoff":
        return "awaiting-plan-review";
      case "awaiting-system-checks":
        return "awaiting-review";
      case "awaiting-landing":
        return "awaiting-landing";
      case "actionable-follow-up":
        return "needs-follow-up";
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
  ): Readonly<Record<string, unknown>> {
    return {
      lifecycleKind: lifecycle.kind,
      branch: lifecycle.branchName,
      summary: lifecycle.summary,
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

  #createSessionObservationArtifacts(
    session: RunSession,
    finishedAt?: string,
  ): {
    readonly session: IssueArtifactSessionSnapshot;
    readonly logPointers: IssueArtifactLogPointerSessionEntry;
  } {
    const description = this.#runner.describeSession(session);
    return {
      session: this.#createSessionArtifact(session, description, finishedAt),
      logPointers: this.#createSessionLogPointers(session, description),
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
      runnerPid: options.runnerPid ?? null,
      pullRequest: this.#createPullRequestArtifactSnapshot(
        options.lifecycle ?? null,
      ),
      review: this.#createReviewArtifactSnapshot(options.lifecycle ?? null),
      checks: this.#createCheckArtifactSnapshot(options.lifecycle ?? null),
    };
  }

  #createSessionArtifact(
    session: RunSession,
    description: RunnerSessionDescription,
    finishedAt?: string,
  ): IssueArtifactSessionSnapshot {
    return {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber: session.issue.number,
      attemptNumber: session.attempt.sequence,
      sessionId: session.id,
      provider: description.provider,
      model: description.model,
      startedAt: session.startedAt,
      finishedAt: finishedAt ?? null,
      workspacePath: session.workspace.path,
      branch: session.workspace.branchName,
      logPointers: description.logPointers.map((pointer) =>
        this.#createLogPointer(pointer),
      ),
    };
  }

  #createSessionLogPointers(
    session: RunSession,
    description: RunnerSessionDescription,
  ): IssueArtifactLogPointerSessionEntry {
    return {
      sessionId: session.id,
      pointers: description.logPointers.map((pointer) =>
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

  #followUpFailureMessage(lifecycle: HandoffLifecycle): string {
    if (!this.#hasHumanReviewFeedback(lifecycle)) {
      return lifecycle.summary;
    }
    return `${lifecycle.summary}; human review feedback remains unresolved`;
  }

  #hasHumanReviewFeedback(lifecycle: HandoffLifecycle): boolean {
    return lifecycle.actionableReviewFeedback.some((feedback) => {
      return this.#tracker.isHumanReviewFeedback(feedback.authorLogin);
    });
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
    session: RunSession,
    lockDir: string,
    event: RunSpawnEvent,
  ): void {
    const issueNumber = session.issue.number;
    this.#leaseManager.recordRunnerSpawn(lockDir, event);
    const entry = this.#state.status.activeIssues.get(issueNumber);
    if (entry) {
      this.#state.status.activeIssues.set(issueNumber, {
        ...entry,
        runnerPid: event.pid,
        updatedAt: event.spawnedAt,
      });
    }
    noteStatusAction(this.#state.status, {
      kind: "runner-spawned",
      summary: `Runner PID ${event.pid.toString()} attached`,
      issueNumber,
      at: event.spawnedAt,
    });
    // The runner onSpawn callback is synchronous; snapshot persistence is optional.
    void this.#persistStatusSnapshot();
    void this.#recordIssueArtifact(
      this.#createRunnerSpawnObservation(session, event),
    );
    this.#logger.info("Runner process attached to active issue", {
      issueNumber,
      runnerPid: event.pid,
      spawnedAt: event.spawnedAt,
    });
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
      this.#state.watchdog.has(issueNumber)
    ) {
      return;
    }
    const now = Date.now();
    this.#state.watchdog.set(
      issueNumber,
      createWatchdogEntry(issueNumber, {
        logSizeBytes: null,
        workspaceDiffHash: null,
        prHeadSha: null,
        hasActionableFeedback: false,
        capturedAt: now,
      }),
    );
  }

  async #runWatchdogLoop(
    issueNumber: number,
    stopSignal: AbortSignal,
  ): Promise<void> {
    if (!this.#watchdogConfig.enabled || this.#livenessProbe === null) {
      return;
    }
    const entry = this.#state.watchdog.get(issueNumber);
    if (!entry) {
      return;
    }
    while (!stopSignal.aborted) {
      await this.#sleep(this.#watchdogConfig.checkIntervalMs, stopSignal);
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
          hasActionableFeedback:
            (activeIssue?.review?.actionableCount ?? 0) > 0,
        });
        const result = checkStall(entry, snapshot, this.#watchdogConfig);
        if (result.stalled && result.reason !== null) {
          if (canRecover(entry, this.#watchdogConfig)) {
            await this.#recoverStalledRunner(issueNumber, result.reason);
            break;
          }
          this.#logger.warn("Stalled runner exceeded recovery limit", {
            issueNumber,
            reason: result.reason,
            recoveryCount: entry.recoveryCount,
          });
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
    reason: StallReason,
  ): Promise<void> {
    const entry = this.#state.watchdog.get(issueNumber);
    if (!entry) {
      return;
    }
    recordRecovery(entry);
    this.#logger.warn("Recovering stalled runner", {
      issueNumber,
      reason,
      recoveryCount: entry.recoveryCount,
    });
    noteStatusAction(this.#state.status, {
      kind: "watchdog-recovery",
      summary: `Stall detected (${reason}) for issue #${issueNumber.toString()}; aborting runner`,
      issueNumber,
    });
    await this.#persistStatusSnapshot();
    const controller = this.#state.runAbortControllers.get(issueNumber);
    if (controller) {
      controller.abort();
    }
  }
}
