import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import { TrackerError } from "../domain/errors.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "./service.js";
import { LinearClient } from "./linear-client.js";
import {
  classifyLinearIssue,
  createLinearHandoffLifecycle,
  extractIssueNumberFromBranchName,
  linearTrackerSubject,
  missingLinearLifecycle,
  resolveLinearClaimState,
  resolveLinearTerminalState,
} from "./linear-policy.js";
import {
  normalizeLinearIssueMutationResult,
  normalizeLinearProjectIssuesResult,
  normalizeLinearIssueResult,
  normalizeLinearProject,
  type LinearIssueSnapshot,
  type LinearProjectSnapshot,
} from "./linear-normalize.js";
import { writeLinearWorkpad } from "./linear-workpad.js";

const CLAIM_COMMENT = "Symphony claimed this issue for implementation.";
const RETRY_PREFIX = "Symphony scheduled a retry:";
const FAILURE_PREFIX = "Symphony failed this run:";
const HANDOFF_READY_COMMENT =
  "Symphony run finished and marked this issue handoff-ready.";
const COMPLETION_COMMENT = "Symphony completed this issue successfully.";

export class LinearTracker implements Tracker {
  readonly #config: LinearTrackerConfig;
  readonly #logger: Logger;
  readonly #client: LinearClient;
  #projectPromise: Promise<LinearProjectSnapshot> | null = null;

  constructor(config: LinearTrackerConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#client = new LinearClient(config);
  }

  subject(): string {
    return linearTrackerSubject(this.#config);
  }

  isHumanReviewFeedback(authorLogin: string | null): boolean {
    return authorLogin !== null;
  }

  async ensureLabels(): Promise<void> {
    await this.#project();
  }

  async fetchReadyIssues(): Promise<readonly RuntimeIssue[]> {
    const issues = await this.#fetchProjectIssues();
    return issues
      .filter((issue) => classifyLinearIssue(issue, this.#config) === "ready")
      .map((issue) => issue.runtimeIssue);
  }

  async fetchRunningIssues(): Promise<readonly RuntimeIssue[]> {
    const issues = await this.#fetchProjectIssues();
    return issues
      .filter((issue) => classifyLinearIssue(issue, this.#config) === "running")
      .map((issue) => issue.runtimeIssue);
  }

  async fetchFailedIssues(): Promise<readonly RuntimeIssue[]> {
    const issues = await this.#fetchProjectIssues();
    return issues
      .filter((issue) => classifyLinearIssue(issue, this.#config) === "failed")
      .map((issue) => issue.runtimeIssue);
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    return (await this.#getIssueSnapshot(issueNumber)).runtimeIssue;
  }

  async claimIssue(issueNumber: number): Promise<RuntimeIssue | null> {
    const project = await this.#project();
    const issue = await this.#getIssueSnapshot(issueNumber);
    if (classifyLinearIssue(issue, this.#config) !== "ready") {
      return null;
    }

    const nextState = resolveLinearClaimState(project, issue, this.#config);
    const updatedDescription = writeLinearWorkpad(issue.description, {
      status: "running",
      summary: "Claimed by Symphony",
      branchName: null,
      updatedAt: new Date().toISOString(),
    });

    const claimed = normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: issue.id,
        description: updatedDescription,
        ...(nextState === null ? {} : { stateId: nextState.id }),
      }),
      "issueUpdate",
    );
    normalizeLinearIssueMutationResult(
      await this.#client.createComment(issue.id, CLAIM_COMMENT),
      "commentCreate",
    );
    this.#logger.info("Claimed Linear issue", {
      issueNumber,
      identifier: claimed.identifier,
      nextState: nextState?.name ?? claimed.state.name,
    });
    return claimed.runtimeIssue;
  }

  async inspectIssueHandoff(branchName: string): Promise<HandoffLifecycle> {
    const issueNumber = extractIssueNumberFromBranchName(branchName);
    if (issueNumber === null) {
      return missingLinearLifecycle(
        branchName,
        `Could not extract issue number from branch ${branchName}`,
      );
    }
    const issue = await this.#getIssueSnapshotOrNull(issueNumber);
    return createLinearHandoffLifecycle(issue, branchName, this.#config);
  }

  async reconcileSuccessfulRun(
    branchName: string,
    _lifecycle: HandoffLifecycle | null,
  ): Promise<HandoffLifecycle> {
    const issueNumber = extractIssueNumberFromBranchName(branchName);
    if (issueNumber === null) {
      return missingLinearLifecycle(
        branchName,
        `Could not extract issue number from branch ${branchName}`,
      );
    }
    const issue = await this.#getIssueSnapshot(issueNumber);
    const updatedDescription = writeLinearWorkpad(issue.description, {
      status: "handoff-ready",
      summary: `Run finished for ${branchName}`,
      branchName,
      updatedAt: new Date().toISOString(),
    });
    normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: issue.id,
        description: updatedDescription,
      }),
      "issueUpdate",
    );
    normalizeLinearIssueMutationResult(
      await this.#client.createComment(issue.id, HANDOFF_READY_COMMENT),
      "commentCreate",
    );
    return await this.inspectIssueHandoff(branchName);
  }

  async recordRetry(issueNumber: number, reason: string): Promise<void> {
    const issue = await this.#getIssueSnapshot(issueNumber);
    normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: issue.id,
        description: writeLinearWorkpad(issue.description, {
          status: "retry-scheduled",
          summary: reason,
          branchName: null,
          updatedAt: new Date().toISOString(),
        }),
      }),
      "issueUpdate",
    );
    normalizeLinearIssueMutationResult(
      await this.#client.createComment(issue.id, `${RETRY_PREFIX} ${reason}`),
      "commentCreate",
    );
  }

  async completeIssue(issueNumber: number): Promise<void> {
    const project = await this.#project();
    const issue = await this.#getIssueSnapshot(issueNumber);
    const terminalState = resolveLinearTerminalState(project, this.#config);
    normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: issue.id,
        description: writeLinearWorkpad(issue.description, {
          status: "completed",
          summary: "Completed by Symphony",
          branchName: null,
          updatedAt: new Date().toISOString(),
        }),
        stateId: terminalState.id,
      }),
      "issueUpdate",
    );
    normalizeLinearIssueMutationResult(
      await this.#client.createComment(issue.id, COMPLETION_COMMENT),
      "commentCreate",
    );
  }

  async markIssueFailed(issueNumber: number, reason: string): Promise<void> {
    const issue = await this.#getIssueSnapshot(issueNumber);
    normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: issue.id,
        description: writeLinearWorkpad(issue.description, {
          status: "failed",
          summary: reason,
          branchName: null,
          updatedAt: new Date().toISOString(),
        }),
      }),
      "issueUpdate",
    );
    normalizeLinearIssueMutationResult(
      await this.#client.createComment(issue.id, `${FAILURE_PREFIX} ${reason}`),
      "commentCreate",
    );
  }

  async #project(): Promise<LinearProjectSnapshot> {
    if (this.#projectPromise === null) {
      this.#projectPromise = this.#loadProject().catch((error) => {
        this.#projectPromise = null;
        throw error;
      });
    }
    return await this.#projectPromise;
  }

  async #loadProject(): Promise<LinearProjectSnapshot> {
    const data = await this.#client.fetchProject();
    if (data.project == null) {
      throw new TrackerError(
        `Linear project not found: ${this.#config.projectSlug}`,
      );
    }
    return normalizeLinearProject(data.project);
  }

  async #fetchProjectIssues(): Promise<readonly LinearIssueSnapshot[]> {
    const result = normalizeLinearProjectIssuesResult(
      await this.#client.fetchProjectIssues(),
    );
    if (this.#projectPromise === null) {
      this.#projectPromise = Promise.resolve(result.project);
    }
    return result.issues;
  }

  async #getIssueSnapshot(issueNumber: number): Promise<LinearIssueSnapshot> {
    const issue = await this.#getIssueSnapshotOrNull(issueNumber);
    if (issue === null) {
      throw new TrackerError(`Linear issue ${issueNumber} not found`);
    }
    return issue;
  }

  async #getIssueSnapshotOrNull(
    issueNumber: number,
  ): Promise<LinearIssueSnapshot | null> {
    const result = normalizeLinearIssueResult(
      await this.#client.fetchProjectIssue(issueNumber),
    );
    if (this.#projectPromise === null) {
      this.#projectPromise = Promise.resolve(result.project);
    }
    return result.issue;
  }
}
