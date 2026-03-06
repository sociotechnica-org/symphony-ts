import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { PullRequestLifecycle } from "../domain/pull-request.js";
import type { RetryState } from "../domain/retry.js";
import type { RunSession } from "../domain/run.js";
import type { PromptBuilder, ResolvedConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Runner } from "../runner/service.js";
import type { Tracker } from "../tracker/service.js";
import type { WorkspaceManager } from "../workspace/service.js";
import { createOrchestratorState } from "./state.js";

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
  }

  async runOnce(): Promise<void> {
    await this.#tracker.ensureLabels();
    this.#logger.info("Poll started");
    const [readyCandidates, runningCandidates] = await Promise.all([
      this.#tracker.fetchReadyIssues(),
      this.#tracker.fetchRunningIssues(),
    ]);
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
      candidateCount: queue.length,
      availableSlots,
    });

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
    while (!signal?.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.#logger.error("Poll cycle failed", {
          error: this.#normalizeFailure(error as Error),
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.#config.polling.intervalMs),
      );
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
    return (
      retryAttempts.get(issueNumber) ??
      this.#state.nextAttemptByIssueNumber.get(issueNumber) ??
      1
    );
  }

  async #processReadyIssue(
    issue: RuntimeIssue,
    attempt: number,
  ): Promise<void> {
    const lease = await this.#acquireIssueLease(issue.number);
    if (!lease) {
      return;
    }
    this.#state.runningIssueNumbers.add(issue.number);
    try {
      const claimed = await this.#tracker.claimIssue(issue.number);
      if (claimed === null) {
        this.#logger.info("Issue was no longer claimable", {
          issueNumber: issue.number,
        });
        return;
      }
      await this.#processClaimedIssue(claimed, attempt);
    } catch (error) {
      await this.#handleUnexpectedFailure(issue, attempt, error as Error);
    } finally {
      this.#state.runningIssueNumbers.delete(issue.number);
      await this.#releaseIssueLease(lease);
    }
  }

  async #processRunningIssue(
    issue: RuntimeIssue,
    attempt: number,
  ): Promise<void> {
    const lease = await this.#acquireIssueLease(issue.number);
    if (!lease) {
      return;
    }
    this.#state.runningIssueNumbers.add(issue.number);
    try {
      await this.#processClaimedIssue(issue, attempt);
    } catch (error) {
      await this.#handleUnexpectedFailure(issue, attempt, error as Error);
    } finally {
      this.#state.runningIssueNumbers.delete(issue.number);
      await this.#releaseIssueLease(lease);
    }
  }

  async #processClaimedIssue(
    issue: RuntimeIssue,
    attempt: number,
  ): Promise<void> {
    const branchName = this.#branchName(issue.number);
    const lifecycle = await this.#refreshLifecycle(branchName);

    if (lifecycle.kind === "ready") {
      await this.#completeIssue(issue.number);
      await this.#cleanupIssueWorkspaceIfNeeded(issue);
      return;
    }

    if (lifecycle.kind === "awaiting-review") {
      this.#logger.info("Issue remains in PR review", {
        issueNumber: issue.number,
        summary: lifecycle.summary,
      });
      return;
    }

    await this.#runIssue(
      issue,
      attempt,
      lifecycle.kind === "missing" ? null : lifecycle,
    );
  }

  async #runIssue(
    issue: RuntimeIssue,
    attempt: number,
    pullRequest: PullRequestLifecycle | null,
  ): Promise<void> {
    const workspace = await this.#workspaceManager.prepareWorkspace({ issue });
    const prompt = await this.#promptBuilder.build({
      issue,
      attempt: attempt > 1 ? attempt : null,
      pullRequest,
    });
    const session = this.#createRunSession(issue, workspace, prompt, attempt);
    const result = await this.#runner.run(session);

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

      this.#logger.info("Issue remains in PR lifecycle", {
        issueNumber: issue.number,
        branchName: workspace.branchName,
        runSessionId: session.id,
        lifecycle: nextLifecycle.kind,
        summary: nextLifecycle.summary,
      });
      this.#state.nextAttemptByIssueNumber.set(issue.number, attempt + 1);
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
    this.#state.nextAttemptByIssueNumber.delete(issueNumber);
    this.#logger.info("Issue completed", { issueNumber });
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
    attempt: number,
    message: string,
  ): Promise<void> {
    if (attempt < this.#config.polling.retry.maxAttempts) {
      await this.#tracker.recordRetry(issue.number, message);
      this.#state.nextAttemptByIssueNumber.set(issue.number, attempt + 1);
      this.#state.retries.set(issue.number, {
        issue,
        nextAttempt: attempt + 1,
        dueAt: Date.now() + this.#config.polling.retry.backoffMs,
        lastError: message,
      });
      return;
    }
    this.#state.retries.delete(issue.number);
    this.#state.nextAttemptByIssueNumber.delete(issue.number);
    await this.#tracker.markIssueFailed(issue.number, message);
  }

  async #acquireIssueLease(issueNumber: number): Promise<string | null> {
    const lockDir = path.join(
      this.#config.workspace.root,
      ".symphony-locks",
      issueNumber.toString(),
    );
    try {
      await fs.mkdir(lockDir, { recursive: false });
      return lockDir;
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ENOENT") {
        await fs.mkdir(path.dirname(lockDir), { recursive: true });
        return await this.#acquireIssueLease(issueNumber);
      }
      if (systemError.code === "EEXIST") {
        this.#logger.info("Issue already leased by another local worker", {
          issueNumber,
        });
        return null;
      }
      throw error;
    }
  }

  async #releaseIssueLease(lockDir: string): Promise<void> {
    await fs.rm(lockDir, { recursive: true, force: true });
  }

  #normalizeFailure(error: Error): string {
    return error instanceof OrchestratorError
      ? error.message
      : `${error.name}: ${error.message}`;
  }
}
