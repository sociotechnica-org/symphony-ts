import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TrackerError } from "../domain/errors.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type {
  PullRequestCheck,
  PullRequestLifecycle,
  PullRequestCheckStatus,
  ReviewFeedback,
} from "../domain/pull-request.js";
import type { TrackerConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "./service.js";

const execFileAsync = promisify(execFile);

interface GitHubIssueResponse {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
}

interface GitHubLabelResponse {
  readonly name: string;
}

interface GitHubPullRequestResponse {
  readonly number: number;
  readonly html_url: string;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
  };
}

interface GitHubCheckRunsResponse {
  readonly check_runs: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly details_url: string | null;
  }>;
}

interface GitHubCommitStatusResponse {
  readonly statuses: ReadonlyArray<{
    readonly context: string;
    readonly state: string;
    readonly target_url: string | null;
  }>;
}

interface GraphQlResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

interface PullRequestReviewStateResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly commits: {
        readonly nodes: ReadonlyArray<{
          readonly commit: {
            readonly committedDate: string;
          };
        }>;
      };
      readonly comments: {
        readonly nodes: ReadonlyArray<{
          readonly id: string;
          readonly body: string;
          readonly createdAt: string;
          readonly url: string;
          readonly author: {
            readonly login: string;
          } | null;
        }>;
      };
      readonly reviewThreads: {
        readonly nodes: ReadonlyArray<{
          readonly id: string;
          readonly isResolved: boolean;
          readonly isOutdated: boolean;
          readonly comments: {
            readonly nodes: ReadonlyArray<{
              readonly id: string;
              readonly body: string;
              readonly createdAt: string;
              readonly url: string;
              readonly path: string | null;
              readonly line: number | null;
              readonly author: {
                readonly login: string;
              } | null;
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

const PULL_REQUEST_REVIEW_STATE_QUERY = `
  query PullRequestReviewState($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              committedDate
            }
          }
        }
        comments(last: 50) {
          nodes {
            id
            body
            createdAt
            url
            author {
              login
            }
          }
        }
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(last: 20) {
              nodes {
                id
                body
                createdAt
                url
                path
                line
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

function toRuntimeIssue(
  issue: GitHubIssueResponse,
  repo: string,
): RuntimeIssue {
  return {
    id: String(issue.number),
    identifier: `${repo}#${issue.number}`,
    number: issue.number,
    title: issue.title,
    description: issue.body ?? "",
    labels: issue.labels.map((label) => label.name),
    state: issue.state,
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function isAfter(left: string, right: string | null): boolean {
  if (right === null) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}

function normalizeCheckStatus(
  status: string,
  conclusion: string | null,
): {
  readonly status: PullRequestCheckStatus;
  readonly conclusion: string | null;
} {
  const normalizedStatus = status.toLowerCase();
  const normalizedConclusion = conclusion?.toLowerCase() ?? null;
  if (
    normalizedStatus === "queued" ||
    normalizedStatus === "in_progress" ||
    normalizedStatus === "pending" ||
    normalizedStatus === "expected" ||
    normalizedStatus === "requested" ||
    normalizedStatus === "waiting"
  ) {
    return {
      status: "pending",
      conclusion: normalizedConclusion,
    };
  }
  if (
    normalizedStatus === "success" ||
    normalizedConclusion === "success" ||
    normalizedConclusion === "neutral" ||
    normalizedConclusion === "skipped"
  ) {
    return {
      status: "success",
      conclusion: normalizedConclusion,
    };
  }

  return {
    status: "failure",
    conclusion: normalizedConclusion ?? normalizedStatus,
  };
}

async function resolveToken(): Promise<string> {
  const envToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (envToken && envToken.trim() !== "") {
    return envToken;
  }

  try {
    const result = await execFileAsync("gh", ["auth", "token"]);
    const token = result.stdout.trim();
    if (token !== "") {
      return token;
    }
  } catch (error) {
    throw new TrackerError(
      "Failed to resolve GitHub token from env or gh auth token",
      { cause: error as Error },
    );
  }

  throw new TrackerError("GitHub token is required");
}

export class GitHubBootstrapTracker implements Tracker {
  readonly #config: TrackerConfig;
  readonly #logger: Logger;
  readonly #tokenPromise: Promise<string>;
  readonly #repoOwner: string;
  readonly #repoName: string;
  #ensureLabelsPromise: Promise<void> | null = null;
  readonly #noCheckObservations = new Map<
    string,
    { readonly url: string; readonly latestCommitAt: string | null }
  >();

  constructor(config: TrackerConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#tokenPromise = resolveToken();
    const [repoOwner, repoName] = config.repo.split("/");
    if (!repoOwner || !repoName) {
      throw new TrackerError(`Invalid tracker.repo value: ${config.repo}`);
    }
    this.#repoOwner = repoOwner;
    this.#repoName = repoName;
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
    return await this.#fetchIssuesByLabel(this.#config.readyLabel);
  }

  async fetchRunningIssues(): Promise<readonly RuntimeIssue[]> {
    return await this.#fetchIssuesByLabel(this.#config.runningLabel);
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    const issue = await this.#request<GitHubIssueResponse>(
      "GET",
      this.#issuePath(`issues/${issueNumber}`),
    );
    return toRuntimeIssue(issue, this.#config.repo);
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
    const updated = await this.#updateIssue(issueNumber, {
      labels: nextLabels,
    });
    this.#noCheckObservations.clear();
    this.#logger.info("Claimed GitHub issue", { issueNumber });
    return updated;
  }

  async inspectIssueHandoff(branchName: string): Promise<PullRequestLifecycle> {
    const pullRequest = await this.#findPullRequest(branchName);
    if (pullRequest === null) {
      this.#noCheckObservations.delete(branchName);
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

    const [checks, reviewStateData] = await Promise.all([
      this.#getChecks(pullRequest.head.sha),
      this.#getPullRequestReviewState(pullRequest.number),
    ]);

    const latestCommitAt =
      reviewStateData.commits.nodes[0]?.commit.committedDate ?? null;

    const unresolvedThreads = reviewStateData.reviewThreads.nodes
      .filter((thread) => !thread.isResolved && !thread.isOutdated)
      .map((thread) => {
        const comment = thread.comments.nodes.at(-1);
        if (!comment) {
          throw new TrackerError(
            `Pull request review thread ${thread.id} had no comments`,
          );
        }
        const feedback: ReviewFeedback = {
          id: comment.id,
          kind: "review-thread",
          threadId: thread.id,
          authorLogin: comment.author?.login ?? null,
          body: comment.body,
          createdAt: comment.createdAt,
          url: comment.url,
          path: comment.path,
          line: comment.line,
        };
        return feedback;
      });

    const reviewBotLogins = new Set(
      this.#config.reviewBotLogins.map((login) => login.toLowerCase()),
    );
    const actionableBotComments =
      reviewBotLogins.size === 0
        ? []
        : reviewStateData.comments.nodes
            .filter((comment) => {
              const authorLogin = comment.author?.login;
              if (!authorLogin) {
                return false;
              }
              return reviewBotLogins.has(authorLogin.toLowerCase());
            })
            .filter((comment) => isAfter(comment.createdAt, latestCommitAt))
            .map<ReviewFeedback>((comment) => ({
              id: comment.id,
              kind: "issue-comment",
              threadId: null,
              authorLogin: comment.author?.login ?? null,
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url,
              path: null,
              line: null,
            }));

    const actionableReviewFeedback = [
      ...unresolvedThreads,
      ...actionableBotComments,
    ];
    const pendingCheckNames = checks
      .filter((check) => check.status === "pending")
      .map((check) => check.name);
    const failingCheckNames = checks
      .filter((check) => check.status === "failure")
      .map((check) => check.name);
    const unresolvedThreadIds = unresolvedThreads
      .map((feedback) => feedback.threadId)
      .filter((threadId): threadId is string => threadId !== null);

    if (failingCheckNames.length > 0 || actionableReviewFeedback.length > 0) {
      this.#noCheckObservations.delete(branchName);
      return {
        kind: "needs-follow-up",
        branchName,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.html_url,
          branchName: pullRequest.head.ref,
          latestCommitAt,
        },
        checks,
        pendingCheckNames,
        failingCheckNames,
        actionableReviewFeedback,
        unresolvedThreadIds,
        summary: this.#summarizeLifecycle(
          pullRequest.html_url,
          failingCheckNames,
          pendingCheckNames,
          actionableReviewFeedback,
        ),
      };
    }

    if (pendingCheckNames.length > 0) {
      this.#noCheckObservations.delete(branchName);
      return {
        kind: "awaiting-review",
        branchName,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.html_url,
          branchName: pullRequest.head.ref,
          latestCommitAt,
        },
        checks,
        pendingCheckNames,
        failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        summary: `Waiting for ${pendingCheckNames.join(", ")} on ${pullRequest.html_url}`,
      };
    }

    if (checks.length === 0) {
      const observation = {
        url: pullRequest.html_url,
        latestCommitAt,
      };
      const previousObservation = this.#noCheckObservations.get(branchName);
      const sawSameNoCheckLifecycle =
        previousObservation?.url === observation.url &&
        previousObservation.latestCommitAt === observation.latestCommitAt;
      this.#noCheckObservations.set(branchName, observation);

      if (!sawSameNoCheckLifecycle) {
        return {
          kind: "awaiting-review",
          branchName,
          pullRequest: {
            number: pullRequest.number,
            url: pullRequest.html_url,
            branchName: pullRequest.head.ref,
            latestCommitAt,
          },
          checks,
          pendingCheckNames,
          failingCheckNames,
          actionableReviewFeedback: [],
          unresolvedThreadIds: [],
          summary: `Waiting for PR checks to appear on ${pullRequest.html_url}`,
        };
      }
    }

    this.#noCheckObservations.delete(branchName);

    return {
      kind: "ready",
      branchName,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.html_url,
        branchName: pullRequest.head.ref,
        latestCommitAt,
      },
      checks,
      pendingCheckNames,
      failingCheckNames,
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      summary: `Pull request ${pullRequest.html_url} is merge-ready`,
    };
  }

  async reconcileSuccessfulRun(
    branchName: string,
    lifecycle: PullRequestLifecycle | null,
  ): Promise<PullRequestLifecycle> {
    if (lifecycle !== null && lifecycle.unresolvedThreadIds.length > 0) {
      await this.#resolveReviewThreads(lifecycle.unresolvedThreadIds);
    }

    return await this.inspectIssueHandoff(branchName);
  }

  async #resolveReviewThreads(threadIds: readonly string[]): Promise<void> {
    await Promise.all(
      threadIds.map(
        async (threadId) =>
          await this.#graphqlRequest(RESOLVE_REVIEW_THREAD_MUTATION, {
            threadId,
          }),
      ),
    );
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
    await this.#updateIssue(issueNumber, { labels: nextLabels });
    await this.#createComment(
      issueNumber,
      `Retry scheduled by Symphony: ${reason}`,
    );
  }

  async completeIssue(issueNumber: number): Promise<void> {
    this.#noCheckObservations.clear();
    await this.#completeIssue(await this.getIssue(issueNumber));
  }

  async markIssueFailed(issueNumber: number, reason: string): Promise<void> {
    this.#noCheckObservations.clear();
    const issue = await this.getIssue(issueNumber);
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.readyLabel,
    );
    if (!nextLabels.includes(this.#config.failedLabel)) {
      nextLabels.push(this.#config.failedLabel);
    }
    await this.#updateIssue(issueNumber, { labels: nextLabels });
    await this.#createComment(
      issueNumber,
      `Symphony failed this run: ${reason}`,
    );
  }

  async #fetchIssuesByLabel(label: string): Promise<readonly RuntimeIssue[]> {
    const issues = await this.#request<GitHubIssueResponse[]>(
      "GET",
      this.#issuePath(`issues?state=open&labels=${encodeURIComponent(label)}`),
    );
    return issues.map((issue) => toRuntimeIssue(issue, this.#config.repo));
  }

  async #doEnsureLabels(): Promise<void> {
    await this.#ensureLabel(
      this.#config.readyLabel,
      "0e8a16",
      "Issue is ready for Symphony to work on",
    );
    await this.#ensureLabel(
      this.#config.runningLabel,
      "1d76db",
      "Issue is currently being worked by Symphony",
    );
    await this.#ensureLabel(
      this.#config.failedLabel,
      "d73a4a",
      "Issue failed in Symphony",
    );
  }

  async #findPullRequest(
    headBranch: string,
  ): Promise<GitHubPullRequestResponse | null> {
    const pulls = await this.#request<GitHubPullRequestResponse[]>(
      "GET",
      this.#issuePath(
        `pulls?state=open&head=${encodeURIComponent(`${this.#repoOwner}:${headBranch}`)}`,
      ),
    );
    return pulls.find((pull) => pull.head.ref === headBranch) ?? null;
  }

  async #getChecks(commitRef: string): Promise<readonly PullRequestCheck[]> {
    const [checkRuns, statuses] = await Promise.all([
      this.#request<GitHubCheckRunsResponse>(
        "GET",
        this.#issuePath(`commits/${encodeURIComponent(commitRef)}/check-runs`),
      ),
      this.#request<GitHubCommitStatusResponse>(
        "GET",
        this.#issuePath(`commits/${encodeURIComponent(commitRef)}/status`),
      ),
    ]);

    const checks: PullRequestCheck[] = checkRuns.check_runs.map((checkRun) => {
      const normalized = normalizeCheckStatus(
        checkRun.status,
        checkRun.conclusion,
      );
      return {
        name: checkRun.name,
        status: normalized.status,
        conclusion: normalized.conclusion,
        detailsUrl: checkRun.details_url,
      };
    });

    for (const status of statuses.statuses) {
      const normalized = normalizeCheckStatus(status.state, null);
      checks.push({
        name: status.context,
        status: normalized.status,
        conclusion: normalized.conclusion,
        detailsUrl: status.target_url,
      });
    }

    return checks;
  }

  async #getPullRequestReviewState(
    number: number,
  ): Promise<
    NonNullable<
      NonNullable<PullRequestReviewStateResponse["repository"]>["pullRequest"]
    >
  > {
    const response = await this.#graphqlRequest<PullRequestReviewStateResponse>(
      PULL_REQUEST_REVIEW_STATE_QUERY,
      {
        owner: this.#repoOwner,
        repo: this.#repoName,
        number,
      },
    );

    const pullRequest = response.repository?.pullRequest;
    if (!pullRequest) {
      throw new TrackerError(`Pull request ${number} was not found in GraphQL`);
    }
    return pullRequest;
  }

  #summarizeLifecycle(
    url: string,
    failingCheckNames: readonly string[],
    pendingCheckNames: readonly string[],
    actionableReviewFeedback: readonly ReviewFeedback[],
  ): string {
    const parts: string[] = [`Follow-up required for ${url}`];
    if (failingCheckNames.length > 0) {
      parts.push(`failing checks: ${failingCheckNames.join(", ")}`);
    }
    if (pendingCheckNames.length > 0) {
      parts.push(`pending checks: ${pendingCheckNames.join(", ")}`);
    }
    if (actionableReviewFeedback.length > 0) {
      parts.push(
        `actionable feedback: ${actionableReviewFeedback.length.toString()}`,
      );
    }
    return parts.join("; ");
  }

  async #completeIssue(issue: RuntimeIssue): Promise<void> {
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.readyLabel &&
        label !== this.#config.failedLabel,
    );
    await this.#createComment(issue.number, this.#config.successComment);
    await this.#updateIssue(issue.number, {
      state: "closed",
      labels: nextLabels,
    });
  }

  async #ensureLabel(
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    try {
      await this.#request<GitHubLabelResponse>(
        "GET",
        this.#issuePath(`labels/${encodeURIComponent(name)}`),
      );
    } catch (error) {
      if (
        !(error instanceof TrackerError) ||
        !error.message.includes(" failed with 404:")
      ) {
        throw error;
      }
      await this.#request<GitHubLabelResponse>(
        "POST",
        this.#issuePath("labels"),
        { name, color, description },
      );
    }
  }

  async #createComment(issueNumber: number, body: string): Promise<void> {
    await this.#request(
      "POST",
      this.#issuePath(`issues/${issueNumber}/comments`),
      { body },
    );
  }

  async #updateIssue(
    issueNumber: number,
    body: Record<string, unknown>,
  ): Promise<RuntimeIssue> {
    const issue = await this.#request<GitHubIssueResponse>(
      "PATCH",
      this.#issuePath(`issues/${issueNumber}`),
      body,
    );
    return toRuntimeIssue(issue, this.#config.repo);
  }

  async #graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.#tokenPromise;
    const response = await fetch(`${this.#config.apiUrl}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new TrackerError(
        `GitHub GraphQL request failed with ${response.status}: ${text}`,
      );
    }

    const payload = (await response.json()) as GraphQlResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new TrackerError(
        `GitHub GraphQL request failed: ${payload.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    if (!payload.data) {
      throw new TrackerError("GitHub GraphQL request returned no data");
    }
    return payload.data;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#tokenPromise;
    const requestInit: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.#config.apiUrl}${path}`, requestInit);

    if (!response.ok) {
      const text = await response.text();
      throw new TrackerError(
        `GitHub API ${method} ${path} failed with ${response.status}: ${text}`,
      );
    }

    return (await response.json()) as T;
  }

  #issuePath(suffix: string): string {
    return `/repos/${this.#config.repo}/${suffix}`;
  }
}
