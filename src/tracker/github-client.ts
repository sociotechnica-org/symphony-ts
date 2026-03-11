import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TrackerError } from "../domain/errors.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type {
  PullRequestCheck,
  PullRequestCheckStatus,
} from "../domain/pull-request.js";
import type { GitHubBootstrapTrackerConfig } from "../domain/workflow.js";

const execFileAsync = promisify(execFile);

export interface GitHubIssueResponse {
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

export interface GitHubIssueCommentResponse {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly html_url: string;
  readonly user: {
    readonly login: string;
  } | null;
}

interface GitHubPullRequestListResponse {
  readonly number: number;
  readonly html_url: string;
  readonly state: string;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
  };
}

export interface GitHubPullRequestResponse extends GitHubPullRequestListResponse {
  readonly landingState: "open" | "merged";
  readonly mergedAt: string | null;
}

interface GitHubPullRequestDetailsResponse {
  readonly merged_at: string | null;
}

interface MergedGitHubPullRequestResponse extends GitHubPullRequestListResponse {
  readonly landingState: "merged";
  readonly mergedAt: string;
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

interface PullRequestReviewCommentsConnection {
  readonly nodes: Array<{
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
    readonly url: string;
    readonly author: {
      readonly login: string;
    } | null;
  }>;
  readonly pageInfo?: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

interface PullRequestReviewThreadsConnection {
  readonly nodes: Array<{
    readonly id: string;
    readonly isResolved: boolean;
    readonly isOutdated: boolean;
    readonly originComments: {
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
    readonly latestComments: {
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
  readonly pageInfo?: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface PullRequestReviewPageResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly commits: {
        readonly nodes: ReadonlyArray<{
          readonly commit: {
            readonly committedDate: string;
          };
        }>;
      };
      readonly comments?: PullRequestReviewCommentsConnection;
      readonly reviewThreads?: PullRequestReviewThreadsConnection;
    } | null;
  } | null;
}

export interface PullRequestReviewState {
  readonly commits: {
    readonly nodes: ReadonlyArray<{
      readonly commit: {
        readonly committedDate: string;
      };
    }>;
  };
  readonly comments: PullRequestReviewCommentsConnection;
  readonly reviewThreads: PullRequestReviewThreadsConnection;
}

const PULL_REQUEST_REVIEW_STATE_QUERY = `
  query PullRequestReviewState(
    $owner: String!,
    $repo: String!,
    $number: Int!,
    $includeComments: Boolean!,
    $includeReviewThreads: Boolean!,
    $commentsAfter: String,
    $reviewThreadsAfter: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              committedDate
            }
          }
        }
        comments(first: 100, after: $commentsAfter) @include(if: $includeComments) {
          nodes {
            id
            body
            createdAt
            url
            author {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        reviewThreads(first: 100, after: $reviewThreadsAfter) @include(if: $includeReviewThreads) {
          nodes {
            id
            isResolved
            isOutdated
            originComments: comments(first: 1) {
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
            latestComments: comments(last: 1) {
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
          pageInfo {
            hasNextPage
            endCursor
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

function paginationInfo(
  pageInfo:
    | {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      }
    | undefined,
): {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  return {
    hasNextPage: pageInfo?.hasNextPage ?? false,
    endCursor: pageInfo?.endCursor ?? null,
  };
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
    normalizedConclusion === "skipped" ||
    normalizedConclusion === "stale" ||
    normalizedConclusion === "action_required" ||
    normalizedConclusion === "cancelled"
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

export function toRuntimeIssue(
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

export class GitHubClient {
  readonly #config: GitHubBootstrapTrackerConfig;
  readonly #tokenPromise: Promise<string>;
  readonly #repoOwner: string;
  readonly #repoName: string;

  constructor(config: GitHubBootstrapTrackerConfig) {
    this.#config = config;
    this.#tokenPromise = resolveToken();
    const [repoOwner, repoName] = config.repo.split("/");
    if (!repoOwner || !repoName) {
      throw new TrackerError(`Invalid tracker.repo value: ${config.repo}`);
    }
    this.#repoOwner = repoOwner;
    this.#repoName = repoName;
  }

  get repoOwner(): string {
    return this.#repoOwner;
  }

  get repoName(): string {
    return this.#repoName;
  }

  async ensureLabel(
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

  async fetchIssuesByLabel(label: string): Promise<readonly RuntimeIssue[]> {
    const issues = await this.#request<GitHubIssueResponse[]>(
      "GET",
      this.#issuePath(`issues?state=open&labels=${encodeURIComponent(label)}`),
    );
    return issues.map((issue) => toRuntimeIssue(issue, this.#config.repo));
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    const issue = await this.#request<GitHubIssueResponse>(
      "GET",
      this.#issuePath(`issues/${issueNumber}`),
    );
    return toRuntimeIssue(issue, this.#config.repo);
  }

  async updateIssue(
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

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.#request(
      "POST",
      this.#issuePath(`issues/${issueNumber}/comments`),
      { body },
    );
  }

  async getIssueComments(
    issueNumber: number,
  ): Promise<readonly GitHubIssueCommentResponse[]> {
    const comments: GitHubIssueCommentResponse[] = [];
    let page = 1;

    for (;;) {
      const currentPage = await this.#request<GitHubIssueCommentResponse[]>(
        "GET",
        this.#issuePath(
          `issues/${issueNumber}/comments?per_page=100&page=${page.toString()}`,
        ),
      );
      comments.push(...currentPage);
      if (currentPage.length < 100) {
        return comments;
      }
      page += 1;
    }
  }

  async findPullRequest(
    headBranch: string,
  ): Promise<GitHubPullRequestResponse | null> {
    const pulls = await this.#request<GitHubPullRequestListResponse[]>(
      "GET",
      this.#issuePath(
        `pulls?state=all&head=${encodeURIComponent(`${this.#repoOwner}:${headBranch}`)}`,
      ),
    );
    const matchingPulls = pulls.filter((pull) => pull.head.ref === headBranch);
    const openPull = matchingPulls.find((pull) => pull.state === "open");
    if (openPull) {
      return {
        ...openPull,
        landingState: "open",
        mergedAt: null,
      };
    }

    const mergedPulls = (
      await Promise.all(
        matchingPulls
          .filter((pull) => pull.state === "closed")
          .map(
            async (pull): Promise<MergedGitHubPullRequestResponse | null> => {
              const mergedAt = await this.#getPullRequestMergedAt(pull.number);
              if (mergedAt === null) {
                return null;
              }
              return {
                ...pull,
                landingState: "merged",
                mergedAt,
              };
            },
          ),
      )
    ).filter(
      (pullRequest): pullRequest is MergedGitHubPullRequestResponse =>
        pullRequest !== null,
    );
    mergedPulls.sort(
      (left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt),
    );
    if (mergedPulls[0]) {
      return mergedPulls[0];
    }

    return null;
  }

  async getChecks(commitRef: string): Promise<readonly PullRequestCheck[]> {
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

  async getPullRequestReviewState(
    number: number,
  ): Promise<PullRequestReviewState> {
    let commentsAfter: string | null = null;
    let reviewThreadsAfter: string | null = null;
    let commentsExhausted = false;
    let reviewThreadsExhausted = false;
    let pullRequest: PullRequestReviewState | null = null;

    for (;;) {
      const response: PullRequestReviewPageResponse =
        await this.#graphqlRequest<PullRequestReviewPageResponse>(
          PULL_REQUEST_REVIEW_STATE_QUERY,
          {
            owner: this.#repoOwner,
            repo: this.#repoName,
            number,
            includeComments: !commentsExhausted,
            includeReviewThreads: !reviewThreadsExhausted,
            commentsAfter,
            reviewThreadsAfter,
          },
        );

      const page: NonNullable<
        NonNullable<PullRequestReviewPageResponse["repository"]>["pullRequest"]
      > | null = response.repository?.pullRequest ?? null;
      if (!page) {
        throw new TrackerError(
          `Pull request ${number} was not found in GraphQL`,
        );
      }

      const comments = page.comments ?? {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      const reviewThreads = page.reviewThreads ?? {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };

      if (pullRequest === null) {
        pullRequest = {
          commits: page.commits,
          comments: {
            nodes: [...comments.nodes],
            pageInfo: paginationInfo(comments.pageInfo),
          },
          reviewThreads: {
            nodes: [...reviewThreads.nodes],
            pageInfo: paginationInfo(reviewThreads.pageInfo),
          },
        };
      } else {
        if (!commentsExhausted) {
          pullRequest.comments.nodes.push(...comments.nodes);
        }
        if (!reviewThreadsExhausted) {
          pullRequest.reviewThreads.nodes.push(...reviewThreads.nodes);
        }
      }

      const commentsPageInfo = paginationInfo(comments.pageInfo);
      const reviewThreadsPageInfo = paginationInfo(reviewThreads.pageInfo);
      const hasMoreComments: boolean = commentsPageInfo.hasNextPage;
      const hasMoreThreads: boolean = reviewThreadsPageInfo.hasNextPage;
      commentsExhausted = !hasMoreComments;
      reviewThreadsExhausted = !hasMoreThreads;
      if (!hasMoreComments && !hasMoreThreads) {
        break;
      }
      commentsAfter = hasMoreComments
        ? commentsPageInfo.endCursor
        : commentsAfter;
      reviewThreadsAfter = hasMoreThreads
        ? reviewThreadsPageInfo.endCursor
        : reviewThreadsAfter;
    }

    if (!pullRequest) {
      throw new TrackerError(`Pull request ${number} was not found in GraphQL`);
    }
    return pullRequest;
  }

  async resolveReviewThreads(threadIds: readonly string[]): Promise<void> {
    await Promise.all(
      threadIds.map(
        async (threadId) =>
          await this.#graphqlRequest(RESOLVE_REVIEW_THREAD_MUTATION, {
            threadId,
          }),
      ),
    );
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

  async #getPullRequestMergedAt(number: number): Promise<string | null> {
    const pullRequest = await this.#request<GitHubPullRequestDetailsResponse>(
      "GET",
      this.#issuePath(`pulls/${number.toString()}`),
    );
    return pullRequest.merged_at;
  }

  #issuePath(suffix: string): string {
    return `/repos/${this.#config.repo}/${suffix}`;
  }
}
