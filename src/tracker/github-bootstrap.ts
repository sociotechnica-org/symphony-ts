import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TrackerError } from "../domain/errors.js";
import type { IssueRef, TrackerConfig } from "../domain/types.js";
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
  readonly html_url: string;
  readonly head: {
    readonly ref: string;
  };
}

function toIssueRef(issue: GitHubIssueResponse, repo: string): IssueRef {
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

  constructor(config: TrackerConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#tokenPromise = resolveToken();
  }

  async ensureLabels(): Promise<void> {
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

  async fetchEligibleIssues(): Promise<readonly IssueRef[]> {
    const issues = await this.#request<GitHubIssueResponse[]>(
      "GET",
      this.#issuePath(
        `issues?state=open&labels=${encodeURIComponent(this.#config.readyLabel)}`,
      ),
    );
    return issues.map((issue) => toIssueRef(issue, this.#config.repo));
  }

  async getIssue(issueNumber: number): Promise<IssueRef> {
    const issue = await this.#request<GitHubIssueResponse>(
      "GET",
      this.#issuePath(`issues/${issueNumber}`),
    );
    return toIssueRef(issue, this.#config.repo);
  }

  async claimIssue(issueNumber: number): Promise<IssueRef | null> {
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
    this.#logger.info("Claimed GitHub issue", { issueNumber });
    return updated;
  }

  async hasPullRequest(headBranch: string): Promise<boolean> {
    const [owner] = this.#config.repo.split("/");
    const pulls = await this.#request<GitHubPullRequestResponse[]>(
      "GET",
      this.#issuePath(
        `pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
      ),
    );
    return pulls.some((pull) => pull.head.ref === headBranch);
  }

  async releaseIssue(issueNumber: number, reason: string): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.failedLabel,
    );
    if (!nextLabels.includes(this.#config.readyLabel)) {
      nextLabels.push(this.#config.readyLabel);
    }
    await this.#updateIssue(issueNumber, { labels: nextLabels });
    await this.#createComment(
      issueNumber,
      `Retry scheduled by Symphony: ${reason}`,
    );
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
    await this.#updateIssue(issueNumber, { labels: nextLabels });
    await this.#createComment(
      issueNumber,
      `Symphony failed this run: ${reason}`,
    );
  }

  async completeIssue(
    issueNumber: number,
    successComment: string,
  ): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const nextLabels = issue.labels.filter(
      (label) =>
        label !== this.#config.runningLabel &&
        label !== this.#config.readyLabel &&
        label !== this.#config.failedLabel,
    );
    await this.#createComment(issueNumber, successComment);
    await this.#updateIssue(issueNumber, {
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
      const trackerError = error as TrackerError;
      if (!trackerError.message.includes("404")) {
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
  ): Promise<IssueRef> {
    const issue = await this.#request<GitHubIssueResponse>(
      "PATCH",
      this.#issuePath(`issues/${issueNumber}`),
      body,
    );
    return toIssueRef(issue, this.#config.repo);
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
