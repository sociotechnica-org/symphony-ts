import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryState } from "../domain/retry.js";
import type { RunSession } from "../domain/run.js";
import type { PromptBuilder, ResolvedConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { createOrchestratorState } from "./state.js";
import type { Runner } from "../runner/service.js";
import type { Tracker } from "../tracker/service.js";
import type { WorkspaceManager } from "../workspace/service.js";

export interface Orchestrator {
  runOnce(): Promise<void>;
  runLoop(signal?: AbortSignal): Promise<void>;
}

interface QueueEntry {
  readonly issue: RuntimeIssue;
  readonly attempt: number;
}

export class BootstrapOrchestrator implements Orchestrator {
  readonly #config: ResolvedConfig;
  readonly #promptBuilder: PromptBuilder;
  readonly #tracker: Tracker;
  readonly #workspaceManager: WorkspaceManager;
  readonly #runner: Runner;
  readonly #logger: Logger;
  readonly #state = createOrchestratorState();

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
    const candidates = await this.#tracker.fetchEligibleIssues();
    const dueRetries = this.#collectDueRetries();
    const queue = this.#mergeQueue(candidates, dueRetries);
    const availableSlots =
      this.#config.polling.maxConcurrentRuns -
      this.#state.runningIssueNumbers.size;
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
      if (this.#state.runningIssueNumbers.has(issue.issue.number)) {
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
    candidates: readonly RuntimeIssue[],
    dueRetries: readonly RetryState[],
  ): readonly QueueEntry[] {
    const merged = new Map<number, QueueEntry>();
    for (const retry of dueRetries) {
      merged.set(retry.issue.number, {
        issue: retry.issue,
        attempt: retry.nextAttempt,
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

  async #processIssue(issue: RuntimeIssue, attempt: number): Promise<void> {
    this.#state.runningIssueNumbers.add(issue.number);
    let claimedIssue = issue;

    try {
      const claimed = await this.#tracker.claimIssue(issue.number);
      if (claimed === null) {
        this.#logger.info("Issue was no longer claimable", {
          issueNumber: issue.number,
        });
        return;
      }
      claimedIssue = claimed;

      const workspace = await this.#workspaceManager.prepareWorkspace({
        issue: claimed,
      });
      const prompt = await this.#promptBuilder.build({
        issue: claimed,
        attempt: attempt > 1 ? attempt : null,
      });
      const session = this.#createRunSession(
        claimed,
        workspace,
        prompt,
        attempt,
      );
      this.#state.activeRuns.set(claimed.number, session);
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
        await this.#tracker.completeRun(session, result);
      } catch (error) {
        await this.#handleFailure(
          session,
          attempt,
          this.#normalizeFailure(error as Error),
        );
        return;
      }

      if (this.#config.workspace.cleanupOnSuccess) {
        await this.#workspaceManager.cleanupWorkspace(workspace);
      }
      this.#logger.info("Issue completed", {
        issueNumber: claimed.number,
        branchName: workspace.branchName,
        runSessionId: session.id,
      });
    } catch (error) {
      await this.#handleUnexpectedFailure(
        claimedIssue,
        attempt,
        error as Error,
      );
    } finally {
      this.#state.runningIssueNumbers.delete(issue.number);
      this.#state.activeRuns.delete(issue.number);
    }
  }

  #createRunSession(
    issue: RuntimeIssue,
    workspace: RunSession["workspace"],
    prompt: string,
    attempt: number,
  ): RunSession {
    return {
      id: `${issue.identifier}/attempt-${attempt}`,
      issue,
      workspace,
      prompt,
      attempt: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        sequence: attempt,
      },
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
    if (attempt < this.#config.polling.retry.maxAttempts) {
      await this.#tracker.releaseIssue(session.issue.number, message);
      this.#state.retries.set(session.issue.number, {
        issue: session.issue,
        nextAttempt: attempt + 1,
        dueAt: Date.now() + this.#config.polling.retry.backoffMs,
        lastError: message,
      });
      return;
    }
    await this.#tracker.markIssueFailed(session.issue.number, message);
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
    if (attempt < this.#config.polling.retry.maxAttempts) {
      await this.#tracker.releaseIssue(issue.number, message);
      this.#state.retries.set(issue.number, {
        issue,
        nextAttempt: attempt + 1,
        dueAt: Date.now() + this.#config.polling.retry.backoffMs,
        lastError: message,
      });
      return;
    }
    await this.#tracker.markIssueFailed(issue.number, message);
  }

  #normalizeFailure(error: Error): string {
    return error instanceof OrchestratorError
      ? error.message
      : `${error.name}: ${error.message}`;
  }
}
