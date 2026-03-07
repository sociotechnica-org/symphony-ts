import { randomUUID } from "node:crypto";
import { OrchestratorError, RunnerAbortedError } from "../domain/errors.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { PullRequestLifecycle } from "../domain/pull-request.js";
import type { RetryState } from "../domain/retry.js";
import type { RunResult, RunSpawnEvent, RunSession } from "../domain/run.js";
import type { PromptBuilder, ResolvedConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import {
  deriveStatusFilePath,
  writeFactoryStatusSnapshot,
} from "../observability/status.js";
import type { Runner } from "../runner/service.js";
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
  readonly #statusFilePath: string;
  #shutdownSignal: AbortSignal | undefined;

  constructor(
    config: ResolvedConfig,
    promptBuilder: PromptBuilder,
    tracker: Tracker,
    workspaceManager: WorkspaceManager,
    runner: Runner,
    logger: Logger,
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
    this.#statusFilePath = deriveStatusFilePath(config.workspace.root);
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
    initialLifecycle?: PullRequestLifecycle,
  ): Promise<void> {
    const branchName = this.#branchName(issue.number);
    const lifecycle =
      initialLifecycle ?? (await this.#refreshLifecycle(branchName));

    if (lifecycle.kind === "ready") {
      await this.#completeIssue(issue.number);
      await this.#cleanupIssueWorkspaceIfNeeded(issue);
      return;
    }

    if (lifecycle.kind === "awaiting-review") {
      noteLifecycleForIssue(
        this.#state.status,
        issue,
        initialLifecycle === undefined ? "running" : "ready",
        attempt,
        branchName,
        lifecycle,
      );
      this.#logger.info("Issue remains in PR review", {
        issueNumber: issue.number,
        summary: lifecycle.summary,
      });
      noteStatusAction(this.#state.status, {
        kind: "awaiting-review",
        summary: lifecycle.summary,
        issueNumber: issue.number,
      });
      await this.#persistStatusSnapshot();
      return;
    }

    await this.#runIssue(
      issue,
      attempt,
      lockDir,
      lifecycle.kind === "missing" ? null : lifecycle,
    );
  }

  async #runIssue(
    issue: RuntimeIssue,
    attempt: number,
    lockDir: string,
    pullRequest: PullRequestLifecycle | null,
  ): Promise<void> {
    upsertActiveIssue(this.#state.status, issue, {
      source: pullRequest === null ? "ready" : "running",
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
      source: pullRequest === null ? "ready" : "running",
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

    let result: RunResult;
    try {
      result = await this.#runner.run(session, {
        signal: abortController.signal,
        onSpawn: (event) => {
          this.#recordRunnerSpawn(issue.number, lockDir, event);
        },
      });
    } finally {
      shutdownSignal?.removeEventListener("abort", handleShutdown);
      this.#state.runAbortControllers.delete(issue.number);
    }

    if (result.exitCode !== 0) {
      await this.#handleFailure(
        session,
        attempt,
        `Runner exited with ${result.exitCode}\n${result.stderr}`,
      );
      return;
    }

    try {
      const nextLifecycle = await this.#tracker.reconcileSuccessfulRun(
        workspace.branchName,
        pullRequest,
      );

      if (nextLifecycle.kind === "ready") {
        await this.#completeIssue(issue.number);
        await this.#cleanupWorkspaceIfNeeded(workspace, issue.number);
        return;
      }

      if (nextLifecycle.kind === "missing") {
        await this.#handleFailure(session, attempt, nextLifecycle.summary);
        return;
      }

      noteLifecycleForIssue(
        this.#state.status,
        issue,
        pullRequest === null ? "ready" : "running",
        attempt,
        workspace.branchName,
        nextLifecycle,
      );
      this.#logger.info("Issue remains in PR lifecycle", {
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

      const decision = noteLifecycleObservation(
        this.#state.followUp,
        issue.number,
        attempt,
        nextLifecycle,
        this.#config.polling.retry.maxFollowUpAttempts,
      );
      if (decision.kind === "exhausted") {
        await this.#failIssue(
          issue.number,
          this.#followUpFailureMessage(nextLifecycle),
        );
      }
    } catch (error) {
      await this.#handleFailure(
        session,
        attempt,
        this.#normalizeFailure(error as Error),
      );
    }
  }

  async #completeIssue(issueNumber: number): Promise<void> {
    await this.#tracker.completeIssue(issueNumber);
    this.#state.retries.delete(issueNumber);
    clearFollowUpRuntimeState(this.#state.followUp, issueNumber);
    clearActiveIssue(this.#state.status, issueNumber);
    adjustTrackerIssueCounts(this.#state.status, {
      running: -1,
    });
    this.#logger.info("Issue completed", { issueNumber });
    noteStatusAction(this.#state.status, {
      kind: "issue-completed",
      summary: `Completed issue #${issueNumber.toString()}`,
      issueNumber,
    });
    await this.#persistStatusSnapshot();
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

  async #refreshLifecycle(branchName: string): Promise<PullRequestLifecycle> {
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
      attempt: {
        sequence: attempt,
      },
    };
  }

  #branchName(issueNumber: number): string {
    return `${this.#config.workspace.branchPrefix}${issueNumber.toString()}`;
  }

  #missingLifecycle(issueNumber: number): PullRequestLifecycle {
    const branchName = this.#branchName(issueNumber);
    return {
      kind: "missing",
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
    await this.#scheduleRetryOrFailSafely(session.issue, attempt, message);
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
  ): Promise<void> {
    try {
      await this.#scheduleRetryOrFail(issue, attempt, message);
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
      return;
    }
    await this.#failIssue(issue.number, message);
  }

  async #failIssue(issueNumber: number, message: string): Promise<void> {
    await this.#tracker.markIssueFailed(issueNumber, message);
    this.#state.retries.delete(issueNumber);
    clearFollowUpRuntimeState(this.#state.followUp, issueNumber);
    clearActiveIssue(this.#state.status, issueNumber);
    adjustTrackerIssueCounts(this.#state.status, {
      running: -1,
      failed: 1,
    });
    noteStatusAction(this.#state.status, {
      kind: "issue-failed",
      summary: message,
      issueNumber,
    });
    await this.#persistStatusSnapshot();
  }

  #followUpFailureMessage(lifecycle: PullRequestLifecycle): string {
    if (!this.#hasHumanReviewFeedback(lifecycle)) {
      return lifecycle.summary;
    }
    return `${lifecycle.summary}; human review feedback remains unresolved`;
  }

  #hasHumanReviewFeedback(lifecycle: PullRequestLifecycle): boolean {
    const reviewBotLogins = new Set(
      this.#config.tracker.reviewBotLogins.map((login) => login.toLowerCase()),
    );
    return lifecycle.actionableReviewFeedback.some((feedback) => {
      const authorLogin = feedback.authorLogin;
      return (
        authorLogin !== null && !reviewBotLogins.has(authorLogin.toLowerCase())
      );
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
    issueNumber: number,
    lockDir: string,
    event: RunSpawnEvent,
  ): void {
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
}
