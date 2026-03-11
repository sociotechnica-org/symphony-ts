import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { GitHubBootstrapTrackerConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { GitHubClient } from "./github-client.js";
import { evaluatePlanReviewProtocol } from "./plan-review-policy.js";
import {
  evaluatePullRequestLifecycle,
  missingPullRequestLifecycle,
  type NoCheckObservation,
} from "./pull-request-policy.js";
import { createPullRequestSnapshot } from "./pull-request-snapshot.js";
import type { Tracker } from "./service.js";

export class GitHubBootstrapTracker implements Tracker {
  readonly #config: GitHubBootstrapTrackerConfig;
  readonly #logger: Logger;
  readonly #client: GitHubClient;
  #ensureLabelsPromise: Promise<void> | null = null;
  readonly #noCheckObservations = new Map<string, NoCheckObservation>();
  readonly #planReviewObservations = new Map<
    string,
    {
      readonly issueUpdatedAt: string;
      readonly lifecycle: HandoffLifecycle | null;
    }
  >();
  readonly #staleMergedPullRequestObservations = new Map<
    string,
    {
      readonly issueUpdatedAt: string;
      readonly pullRequestNumber: number;
      readonly mergedAt: string;
      readonly isStale: boolean;
    }
  >();

  constructor(config: GitHubBootstrapTrackerConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#client = new GitHubClient(config);
  }

  subject(): string {
    return this.#config.repo;
  }

  isHumanReviewFeedback(authorLogin: string | null): boolean {
    if (authorLogin === null) {
      return false;
    }
    return !this.#config.reviewBotLogins
      .map((login) => login.toLowerCase())
      .includes(authorLogin.toLowerCase());
  }

  async ensureLabels(): Promise<void> {
    if (this.#ensureLabelsPromise === null) {
      this.#ensureLabelsPromise = this.#doEnsureLabels().catch((error) => {
        this.#ensureLabelsPromise = null;
        throw error;
      });
    }
    await this.#ensureLabelsPromise;
  }

  async fetchReadyIssues(): Promise<readonly RuntimeIssue[]> {
    return await this.#client.fetchIssuesByLabel(this.#config.readyLabel);
  }

  async fetchRunningIssues(): Promise<readonly RuntimeIssue[]> {
    return await this.#client.fetchIssuesByLabel(this.#config.runningLabel);
  }

  async fetchFailedIssues(): Promise<readonly RuntimeIssue[]> {
    return await this.#client.fetchIssuesByLabel(this.#config.failedLabel);
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    return await this.#client.getIssue(issueNumber);
  }

  async claimIssue(issueNumber: number): Promise<RuntimeIssue | null> {
    const issue = await this.getIssue(issueNumber);
    if (
      !issue.labels.includes(this.#config.readyLabel) ||
      issue.labels.includes(this.#config.runningLabel)
    ) {
      return null;
    }

    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.readyLabel && label !== this.#config.failedLabel,
    );
    nextLabels.push(this.#config.runningLabel);
    const updated = await this.#client.updateIssue(issueNumber, {
      labels: nextLabels,
    });
    this.#logger.info("Claimed GitHub issue", { issueNumber });
    return updated;
  }

  async inspectIssueHandoff(branchName: string): Promise<HandoffLifecycle> {
    const pullRequest = await this.#client.findPullRequest(branchName);
    if (pullRequest === null) {
      this.#noCheckObservations.delete(branchName);
      this.#staleMergedPullRequestObservations.delete(branchName);
      const planReviewLifecycle =
        await this.#inspectPlanReviewHandoff(branchName);
      return planReviewLifecycle ?? missingPullRequestLifecycle(branchName);
    }
    if (await this.#isStaleMergedPullRequest(branchName, pullRequest)) {
      this.#noCheckObservations.delete(branchName);
      const planReviewLifecycle =
        await this.#inspectPlanReviewHandoff(branchName);
      return planReviewLifecycle ?? missingPullRequestLifecycle(branchName);
    }
    if (pullRequest.landingState === "merged") {
      this.#noCheckObservations.delete(branchName);
      this.#planReviewObservations.delete(branchName);
      return {
        kind: "handoff-ready",
        branchName,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.html_url,
          branchName: pullRequest.head.ref,
          latestCommitAt: null,
        },
        checks: [],
        pendingCheckNames: [],
        failingCheckNames: [],
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        summary: `Pull request ${pullRequest.html_url} has merged`,
      };
    }
    this.#staleMergedPullRequestObservations.delete(branchName);

    const [checks, reviewStateData] = await Promise.all([
      this.#client.getChecks(pullRequest.head.sha),
      this.#client.getPullRequestReviewState(pullRequest.number),
    ]);
    this.#planReviewObservations.delete(branchName);
    const snapshot = createPullRequestSnapshot({
      branchName,
      pullRequest,
      checks,
      reviewState: reviewStateData,
      reviewBotLogins: this.#config.reviewBotLogins,
    });
    const result = evaluatePullRequestLifecycle(
      snapshot,
      this.#noCheckObservations.get(branchName),
    );
    if (result.nextNoCheckObservation === null) {
      this.#noCheckObservations.delete(branchName);
    } else {
      this.#noCheckObservations.set(branchName, result.nextNoCheckObservation);
    }
    return result.lifecycle;
  }

  async reconcileSuccessfulRun(
    branchName: string,
    lifecycle: HandoffLifecycle | null,
  ): Promise<HandoffLifecycle> {
    if (lifecycle !== null && lifecycle.unresolvedThreadIds.length > 0) {
      await this.#client.resolveReviewThreads(lifecycle.unresolvedThreadIds);
    }

    return await this.inspectIssueHandoff(branchName);
  }

  async #inspectPlanReviewHandoff(
    branchName: string,
  ): Promise<HandoffLifecycle | null> {
    const issueNumber = this.#issueNumberFromBranchName(branchName);
    if (issueNumber === null) {
      return null;
    }

    const issue = await this.getIssue(issueNumber);
    const observation = this.#planReviewObservations.get(branchName);
    if (
      observation !== undefined &&
      observation.issueUpdatedAt === issue.updatedAt
    ) {
      return observation.lifecycle;
    }

    const comments = await this.#client.getIssueComments(issueNumber);
    const protocol = evaluatePlanReviewProtocol(
      branchName,
      issue.url,
      comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
        authorLogin: comment.user?.login ?? null,
      })),
    );
    if (protocol.acknowledgement !== null) {
      await this.#client.createComment(
        issueNumber,
        protocol.acknowledgement.body,
      );
      return protocol.lifecycle;
    }
    const lifecycle = protocol.lifecycle;
    this.#planReviewObservations.set(branchName, {
      issueUpdatedAt: issue.updatedAt,
      lifecycle,
    });
    return lifecycle;
  }

  async #isStaleMergedPullRequest(
    branchName: string,
    pullRequest: Awaited<ReturnType<GitHubClient["findPullRequest"]>>,
  ): Promise<boolean> {
    if (
      pullRequest === null ||
      pullRequest.landingState !== "merged" ||
      pullRequest.mergedAt === null
    ) {
      return false;
    }

    const issueNumber = this.#issueNumberFromBranchName(branchName);
    if (issueNumber === null) {
      return false;
    }

    const issue = await this.getIssue(issueNumber);
    const cachedObservation =
      this.#staleMergedPullRequestObservations.get(branchName);
    if (
      cachedObservation !== undefined &&
      cachedObservation.issueUpdatedAt === issue.updatedAt &&
      cachedObservation.pullRequestNumber === pullRequest.number &&
      cachedObservation.mergedAt === pullRequest.mergedAt
    ) {
      return cachedObservation.isStale;
    }

    const successCommentAt = (await this.#client.getIssueComments(issueNumber))
      .filter((comment) => comment.body === this.#config.successComment)
      .map((comment) => Date.parse(comment.created_at))
      .filter((createdAt) => Number.isFinite(createdAt))
      .sort((left, right) => right - left)[0];
    const mergedAtTs = Date.parse(pullRequest.mergedAt);
    const isStale =
      successCommentAt !== undefined &&
      Number.isFinite(mergedAtTs) &&
      successCommentAt >= mergedAtTs;

    this.#staleMergedPullRequestObservations.set(branchName, {
      issueUpdatedAt: issue.updatedAt,
      pullRequestNumber: pullRequest.number,
      mergedAt: pullRequest.mergedAt,
      isStale,
    });

    return isStale;
  }

  #issueNumberFromBranchName(branchName: string): number | null {
    const match = branchName.match(/(\d+)$/u);
    if (!match || !match[1]) {
      this.#logger.warn(
        "Could not extract issue number from branch name; skipping plan-review check",
        { branchName },
      );
      return null;
    }
    return Number(match[1]);
  }

  async recordRetry(issueNumber: number, reason: string): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.readyLabel && label !== this.#config.failedLabel,
    );
    if (!nextLabels.includes(this.#config.runningLabel)) {
      nextLabels.push(this.#config.runningLabel);
    }
    await this.#client.updateIssue(issueNumber, { labels: nextLabels });
    await this.#client.createComment(
      issueNumber,
      `Retry scheduled by Symphony: ${reason}`,
    );
  }

  async completeIssue(issueNumber: number): Promise<void> {
    await this.#completeIssue(await this.getIssue(issueNumber));
  }

  async markIssueFailed(issueNumber: number, reason: string): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.readyLabel,
    );
    if (!nextLabels.includes(this.#config.failedLabel)) {
      nextLabels.push(this.#config.failedLabel);
    }
    await this.#client.updateIssue(issueNumber, { labels: nextLabels });
    await this.#client.createComment(
      issueNumber,
      `Symphony failed this run: ${reason}`,
    );
  }

  async #doEnsureLabels(): Promise<void> {
    await this.#client.ensureLabel(
      this.#config.readyLabel,
      "0e8a16",
      "Issue is ready for Symphony to work on",
    );
    await this.#client.ensureLabel(
      this.#config.runningLabel,
      "1d76db",
      "Issue is currently being worked by Symphony",
    );
    await this.#client.ensureLabel(
      this.#config.failedLabel,
      "d73a4a",
      "Issue failed in Symphony",
    );
  }

  async #completeIssue(issue: RuntimeIssue): Promise<void> {
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.readyLabel &&
        label !== this.#config.failedLabel,
    );
    await this.#client.createComment(issue.number, this.#config.successComment);
    await this.#client.updateIssue(issue.number, {
      state: "closed",
      labels: nextLabels,
    });
  }
}
