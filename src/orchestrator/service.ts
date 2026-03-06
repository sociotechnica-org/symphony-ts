import { OrchestratorError } from "../domain/errors.js";
import type {
  IssueRef,
  RetryEntry,
  WorkflowDefinition,
} from "../domain/types.js";
import { renderPrompt } from "../config/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Runner } from "../runner/service.js";
import type { Tracker } from "../tracker/service.js";
import type { WorkspaceManager } from "../workspace/service.js";

export interface Orchestrator {
  runOnce(): Promise<void>;
  runLoop(signal?: AbortSignal): Promise<void>;
}

interface QueueEntry {
  readonly issue: IssueRef;
  readonly attempt: number;
}

export class BootstrapOrchestrator implements Orchestrator {
  readonly #definition: WorkflowDefinition;
  readonly #tracker: Tracker;
  readonly #workspaceManager: WorkspaceManager;
  readonly #runner: Runner;
  readonly #logger: Logger;
  readonly #running = new Set<number>();
  readonly #retries = new Map<number, RetryEntry>();

  constructor(
    definition: WorkflowDefinition,
    tracker: Tracker,
    workspaceManager: WorkspaceManager,
    runner: Runner,
    logger: Logger,
  ) {
    this.#definition = definition;
    this.#tracker = tracker;
    this.#workspaceManager = workspaceManager;
    this.#runner = runner;
    this.#logger = logger;
  }

  async runOnce(): Promise<void> {
    await this.#tracker.ensureLabels();
    this.#logger.info("Poll started");
    const candidates = await this.#tracker.fetchEligibleIssues();
    const dueRetries = this.#collectDueRetries();
    const queue = this.#mergeQueue(candidates, dueRetries);
    const availableSlots =
      this.#definition.config.polling.maxConcurrentRuns - this.#running.size;
    this.#logger.info("Poll candidates fetched", {
      candidateCount: queue.length,
      availableSlots,
    });

    if (availableSlots <= 0) {
      return;
    }

    const runs: Promise<void>[] = [];
    for (const issue of queue) {
      if (runs.length >= availableSlots) {
        break;
      }
      if (this.#running.has(issue.issue.number)) {
        continue;
      }
      runs.push(this.#processIssue(issue.issue, issue.attempt));
    }

    await Promise.all(runs);
  }

  async runLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.runOnce();
      await new Promise((resolve) =>
        setTimeout(resolve, this.#definition.config.polling.intervalMs),
      );
    }
  }

  #collectDueRetries(): readonly RetryEntry[] {
    const now = Date.now();
    const due: RetryEntry[] = [];
    for (const [issueNumber, entry] of this.#retries.entries()) {
      if (entry.dueAt <= now) {
        due.push(entry);
        this.#retries.delete(issueNumber);
      }
    }
    return due;
  }

  #mergeQueue(
    candidates: readonly IssueRef[],
    dueRetries: readonly RetryEntry[],
  ): readonly QueueEntry[] {
    const merged = new Map<number, QueueEntry>();
    for (const retry of dueRetries) {
      merged.set(retry.issue.number, {
        issue: retry.issue,
        attempt: retry.attempt,
      });
    }
    for (const issue of candidates) {
      const existing = merged.get(issue.number);
      merged.set(issue.number, {
        issue,
        attempt: existing?.attempt ?? 1,
      });
    }
    return [...merged.values()].sort((a, b) => a.issue.number - b.issue.number);
  }

  async #processIssue(issue: IssueRef, attempt: number): Promise<void> {
    this.#running.add(issue.number);

    try {
      const claimed = await this.#tracker.claimIssue(issue.number);
      if (claimed === null) {
        this.#logger.info("Issue was no longer claimable", {
          issueNumber: issue.number,
        });
        return;
      }

      const workspace = await this.#workspaceManager.ensureWorkspace(
        claimed,
        this.#definition.config.workspace,
        this.#definition.config.hooks.afterCreate,
      );
      const prompt = await renderPrompt(
        this.#definition,
        claimed,
        attempt > 1 ? attempt : null,
      );
      const result = await this.#runner.run(
        { issue: claimed, workspace, prompt, attempt },
        this.#definition.config.agent,
      );

      if (result.exitCode !== 0) {
        await this.#handleFailure(
          claimed,
          workspace,
          attempt,
          `Runner exited with ${result.exitCode}\n${result.stderr}`,
        );
        return;
      }

      const hasPullRequest = await this.#tracker.hasPullRequest(
        workspace.branchName,
      );
      if (!hasPullRequest) {
        await this.#handleFailure(
          claimed,
          workspace,
          attempt,
          `Runner exited successfully but no pull request was found for ${workspace.branchName}`,
        );
        return;
      }

      await this.#tracker.completeIssue(
        claimed.number,
        this.#definition.config.tracker.successComment,
      );
      if (this.#definition.config.workspace.cleanupOnSuccess) {
        await this.#workspaceManager.cleanupWorkspace(workspace);
      }
      this.#logger.info("Issue completed", {
        issueNumber: claimed.number,
        branchName: workspace.branchName,
      });
    } catch (error) {
      await this.#handleUnexpectedFailure(issue, attempt, error as Error);
    } finally {
      this.#running.delete(issue.number);
    }
  }

  async #handleFailure(
    issue: IssueRef,
    workspace: { readonly path: string },
    attempt: number,
    message: string,
  ): Promise<void> {
    this.#logger.error("Issue run failed", {
      issueNumber: issue.number,
      attempt,
      error: message,
      workspacePath: workspace.path,
    });
    if (attempt < this.#definition.config.polling.retry.maxAttempts) {
      await this.#tracker.releaseIssue(issue.number, message);
      this.#retries.set(issue.number, {
        issue,
        attempt: attempt + 1,
        dueAt: Date.now() + this.#definition.config.polling.retry.backoffMs,
        lastError: message,
      });
      return;
    }
    await this.#tracker.markIssueFailed(issue.number, message);
  }

  async #handleUnexpectedFailure(
    issue: IssueRef,
    attempt: number,
    error: Error,
  ): Promise<void> {
    const message =
      error instanceof OrchestratorError
        ? error.message
        : `${error.name}: ${error.message}`;
    this.#logger.error("Unexpected issue failure", {
      issueNumber: issue.number,
      attempt,
      error: message,
    });
    if (attempt < this.#definition.config.polling.retry.maxAttempts) {
      await this.#tracker.releaseIssue(issue.number, message);
      this.#retries.set(issue.number, {
        issue,
        attempt: attempt + 1,
        dueAt: Date.now() + this.#definition.config.polling.retry.backoffMs,
        lastError: message,
      });
      return;
    }
    await this.#tracker.markIssueFailed(issue.number, message);
  }
}
