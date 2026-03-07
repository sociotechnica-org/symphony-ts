import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

interface PullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly html_url: string;
  latestCommitAt: string | null;
  latestCommitSha: string;
  readonly comments: MockPullRequestComment[];
  readonly reviewThreads: MockReviewThread[];
  checkRuns: MockCheckRun[];
  statuses: MockCommitStatus[];
}

interface MockPullRequestComment {
  readonly id: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
}

interface MockReviewThread {
  readonly id: string;
  isResolved: boolean;
  isOutdated: boolean;
  readonly comments: MockReviewComment[];
}

interface MockReviewComment {
  readonly id: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly path: string | null;
  readonly line: number | null;
}

interface MockCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
}

interface MockCommitStatus {
  readonly context: string;
  readonly state: string;
  readonly targetUrl: string | null;
}

interface MockIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  comments: MockIssueComment[];
}

interface MockIssueComment {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly html_url: string;
  readonly user: {
    readonly login: string;
  } | null;
}

interface MockLabel {
  name: string;
  color: string;
  description: string;
}

function json(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : JSON.parse(raw);
}

export class MockGitHubServer {
  readonly #issues = new Map<number, MockIssue>();
  readonly #labels = new Map<string, MockLabel>();
  readonly #prs = new Map<number, PullRequestRecord>();
  readonly #requestCounts = new Map<string, number>();
  readonly #branchCommitTimes = new Map<string, string>();
  readonly #server = http.createServer(this.#handle.bind(this));
  #baseUrl = "";
  #nextPrNumber = 1;

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Mock GitHub server failed to bind");
    }
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  seedIssue(input: {
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
    state?: string;
  }): void {
    const now = new Date().toISOString();
    this.#issues.set(input.number, {
      id: randomUUID(),
      number: input.number,
      title: input.title,
      body: input.body,
      state: input.state ?? "open",
      html_url: `${this.#baseUrl}/issues/${input.number}`,
      created_at: now,
      updated_at: now,
      labels: input.labels.map((name) => ({ name })),
      comments: [],
    });
  }

  getIssue(
    number: number,
  ): Omit<MockIssue, "comments"> & { comments: string[] } {
    const issue = this.#issues.get(number);
    if (!issue) {
      throw new Error(`Issue ${number} not found`);
    }
    return {
      ...structuredClone(issue),
      comments: issue.comments.map((comment) => comment.body),
    };
  }

  setIssueLabels(number: number, labels: readonly string[]): void {
    const issue = this.#issues.get(number);
    if (!issue) {
      throw new Error(`Issue ${number} not found`);
    }
    issue.labels = labels.map((name) => ({ name }));
    issue.updated_at = new Date().toISOString();
  }

  addIssueComment(input: {
    issueNumber: number;
    authorLogin?: string;
    body: string;
    createdAt?: string;
  }): number {
    const issue = this.#issues.get(input.issueNumber);
    if (!issue) {
      throw new Error(`Issue ${input.issueNumber} not found`);
    }
    const id = issue.comments.length + 1;
    issue.comments.push({
      id,
      body: input.body,
      created_at: input.createdAt ?? new Date().toISOString(),
      html_url: `${issue.html_url}#issuecomment-${id.toString()}`,
      user: {
        login: input.authorLogin ?? "symphony[bot]",
      },
    });
    issue.updated_at = new Date().toISOString();
    return id;
  }

  getPullRequests(): ReadonlyArray<{
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
  }> {
    return [...this.#prs.values()].map((pullRequest) => ({
      title: pullRequest.title,
      body: pullRequest.body,
      head: pullRequest.head,
      base: pullRequest.base,
    }));
  }

  countRequests(key: string): number {
    return this.#requestCounts.get(key) ?? 0;
  }

  async recordPullRequest(pr: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<void> {
    const existing = [...this.#prs.values()].find(
      (entry) => entry.head === pr.head,
    );
    if (existing) {
      return;
    }

    const number = this.#nextPrNumber++;
    const latestCommitAt =
      this.#branchCommitTimes.get(pr.head) ?? new Date().toISOString();
    this.#prs.set(number, {
      number,
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base: pr.base,
      html_url: `${this.#baseUrl}/pulls/${number}`,
      latestCommitAt,
      latestCommitSha: randomUUID(),
      comments: [],
      reviewThreads: [],
      checkRuns: [],
      statuses: [],
    });
  }

  recordBranchPush(head: string, committedAt = new Date().toISOString()): void {
    this.#branchCommitTimes.set(head, committedAt);
    const pullRequest = [...this.#prs.values()].find(
      (entry) => entry.head === head,
    );
    if (pullRequest) {
      pullRequest.latestCommitAt = committedAt;
      pullRequest.latestCommitSha = randomUUID();
      pullRequest.checkRuns = pullRequest.checkRuns.map((checkRun) => ({
        ...checkRun,
        status: "in_progress",
        conclusion: null,
      }));
      pullRequest.statuses = pullRequest.statuses.map((status) => ({
        ...status,
        state: "pending",
      }));
    }
  }

  setPullRequestCheckRuns(
    head: string,
    checkRuns: ReadonlyArray<{
      name: string;
      status: string;
      conclusion?: string | null;
      detailsUrl?: string | null;
    }>,
  ): void {
    const pullRequest = this.#requirePullRequestByHead(head);
    pullRequest.checkRuns = checkRuns.map((checkRun) => ({
      name: checkRun.name,
      status: checkRun.status,
      conclusion: checkRun.conclusion ?? null,
      detailsUrl: checkRun.detailsUrl ?? null,
    }));
  }

  setPullRequestStatuses(
    head: string,
    statuses: ReadonlyArray<{
      context: string;
      state: string;
      targetUrl?: string | null;
    }>,
  ): void {
    const pullRequest = this.#requirePullRequestByHead(head);
    pullRequest.statuses = statuses.map((status) => ({
      context: status.context,
      state: status.state,
      targetUrl: status.targetUrl ?? null,
    }));
  }

  addPullRequestComment(input: {
    head: string;
    authorLogin: string;
    body: string;
    createdAt?: string;
  }): string {
    const pullRequest = this.#requirePullRequestByHead(input.head);
    const commentId = randomUUID();
    pullRequest.comments.push({
      id: commentId,
      authorLogin: input.authorLogin,
      body: input.body,
      createdAt: input.createdAt ?? new Date().toISOString(),
      url: `${pullRequest.html_url}#issuecomment-${commentId}`,
    });
    return commentId;
  }

  addPullRequestReviewThread(input: {
    head: string;
    authorLogin: string;
    body: string;
    path?: string | null;
    line?: number | null;
    createdAt?: string;
  }): string {
    const pullRequest = this.#requirePullRequestByHead(input.head);
    const threadId = randomUUID();
    const commentId = randomUUID();
    pullRequest.reviewThreads.push({
      id: threadId,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: commentId,
          authorLogin: input.authorLogin,
          body: input.body,
          createdAt: input.createdAt ?? new Date().toISOString(),
          url: `${pullRequest.html_url}#discussion_r${commentId}`,
          path: input.path ?? null,
          line: input.line ?? null,
        },
      ],
    });
    return threadId;
  }

  isReviewThreadResolved(threadId: string): boolean {
    const thread = this.#findReviewThread(threadId);
    return thread.isResolved;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.#baseUrl);
    const method = request.method ?? "GET";

    if (method === "POST" && url.pathname === "/mock/prs") {
      const body = (await readJson(request)) as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      await this.recordPullRequest(body);
      json(response, 201, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/mock/branch-pushes") {
      const body = (await readJson(request)) as {
        head: string;
        committed_at?: string;
      };
      this.recordBranchPush(body.head, body.committed_at);
      json(response, 201, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/graphql") {
      const body = (await readJson(request)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      await this.#handleGraphql(body, response);
      return;
    }

    const pathMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!pathMatch) {
      json(response, 404, { message: "not found" });
      return;
    }

    const suffix = pathMatch[3] ?? "";
    const requestKey = `${method} ${suffix}`;
    this.#requestCounts.set(
      requestKey,
      (this.#requestCounts.get(requestKey) ?? 0) + 1,
    );

    if (method === "GET" && suffix === "labels") {
      json(response, 200, [...this.#labels.values()]);
      return;
    }

    if (method === "POST" && suffix === "labels") {
      const body = (await readJson(request)) as {
        name: string;
        color: string;
        description: string;
      };
      const label = {
        name: body.name,
        color: body.color,
        description: body.description,
      };
      this.#labels.set(label.name, label);
      json(response, 201, label);
      return;
    }

    const labelMatch = suffix.match(/^labels\/(.+)$/);
    if (method === "GET" && labelMatch) {
      const labelName = decodeURIComponent(labelMatch[1] ?? "");
      const label = this.#labels.get(labelName);
      if (!label) {
        json(response, 404, { message: "label not found" });
        return;
      }
      json(response, 200, label);
      return;
    }

    if (method === "GET" && suffix === "issues") {
      const state = url.searchParams.get("state") ?? "open";
      const label = url.searchParams.get("labels");
      const issues = [...this.#issues.values()]
        .filter((issue) => issue.state === state)
        .filter((issue) => {
          if (!label) {
            return true;
          }
          return issue.labels.some((entry) => entry.name === label);
        });
      json(response, 200, issues);
      return;
    }

    if (method === "GET" && suffix === "pulls") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      const pulls = [...this.#prs.values()]
        .filter(() => state === "open" || state === "all")
        .filter((pull) =>
          head ? `${pathMatch[1]}:${pull.head}` === head : true,
        )
        .map((pull) => ({
          number: pull.number,
          html_url: pull.html_url,
          state: "open",
          head: {
            ref: pull.head,
            sha: pull.latestCommitSha,
          },
        }));
      json(response, 200, pulls);
      return;
    }

    const checkRunsMatch = suffix.match(/^commits\/(.+)\/check-runs$/);
    if (method === "GET" && checkRunsMatch) {
      const head = decodeURIComponent(checkRunsMatch[1] ?? "");
      const pullRequest = this.#requirePullRequestByRef(head);
      json(response, 200, {
        total_count: pullRequest.checkRuns.length,
        check_runs: pullRequest.checkRuns.map((checkRun) => ({
          name: checkRun.name,
          status: checkRun.status,
          conclusion: checkRun.conclusion,
          details_url: checkRun.detailsUrl,
        })),
      });
      return;
    }

    const statusMatch = suffix.match(/^commits\/(.+)\/status$/);
    if (method === "GET" && statusMatch) {
      const head = decodeURIComponent(statusMatch[1] ?? "");
      const pullRequest = this.#requirePullRequestByRef(head);
      json(response, 200, {
        state: pullRequest.statuses.some((status) => status.state === "failure")
          ? "failure"
          : pullRequest.statuses.some((status) => status.state === "pending")
            ? "pending"
            : "success",
        statuses: pullRequest.statuses.map((status) => ({
          context: status.context,
          state: status.state,
          target_url: status.targetUrl,
        })),
      });
      return;
    }

    const issueMatch = suffix.match(/^issues\/(\d+)$/);
    if (issueMatch) {
      const issueNumber = Number(issueMatch[1]);
      const issue = this.#issues.get(issueNumber);
      if (!issue) {
        json(response, 404, { message: "issue not found" });
        return;
      }
      if (method === "GET") {
        json(response, 200, issue);
        return;
      }
      if (method === "PATCH") {
        const body = (await readJson(request)) as {
          labels?: string[];
          state?: string;
        };
        if (body.labels) {
          issue.labels = body.labels.map((name) => ({ name }));
        }
        if (body.state) {
          issue.state = body.state;
        }
        issue.updated_at = new Date().toISOString();
        json(response, 200, issue);
        return;
      }
    }

    const commentMatch = suffix.match(/^issues\/(\d+)\/comments$/);
    if (commentMatch && method === "GET") {
      const issueNumber = Number(commentMatch[1]);
      const issue = this.#issues.get(issueNumber);
      if (!issue) {
        json(response, 404, { message: "issue not found" });
        return;
      }
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const offset = Math.max(page - 1, 0) * perPage;
      json(response, 200, issue.comments.slice(offset, offset + perPage));
      return;
    }
    if (commentMatch && method === "POST") {
      const issueNumber = Number(commentMatch[1]);
      const issue = this.#issues.get(issueNumber);
      if (!issue) {
        json(response, 404, { message: "issue not found" });
        return;
      }
      const body = (await readJson(request)) as { body: string };
      const id = issue.comments.length + 1;
      issue.comments.push({
        id,
        body: body.body,
        created_at: new Date().toISOString(),
        html_url: `${issue.html_url}#issuecomment-${id.toString()}`,
        user: {
          login: "symphony[bot]",
        },
      });
      issue.updated_at = new Date().toISOString();
      json(response, 201, {
        id,
        body: body.body,
      });
      return;
    }

    json(response, 404, { message: "not found" });
  }

  async #handleGraphql(
    body: { query: string; variables: Record<string, unknown> },
    response: ServerResponse,
  ): Promise<void> {
    if (body.query.includes("PullRequestReviewState")) {
      const number = Number(body.variables["number"]);
      const pullRequest = this.#prs.get(number);
      if (!pullRequest) {
        json(response, 200, {
          data: {
            repository: {
              pullRequest: null,
            },
          },
        });
        return;
      }

      json(response, 200, {
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes:
                  pullRequest.latestCommitAt === null
                    ? []
                    : [
                        {
                          commit: {
                            committedDate: pullRequest.latestCommitAt,
                          },
                        },
                      ],
              },
              comments: {
                nodes: pullRequest.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  createdAt: comment.createdAt,
                  url: comment.url,
                  author: {
                    login: comment.authorLogin,
                  },
                })),
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
              reviewThreads: {
                nodes: pullRequest.reviewThreads.map((thread) => ({
                  id: thread.id,
                  isResolved: thread.isResolved,
                  isOutdated: thread.isOutdated,
                  originComments: {
                    nodes: thread.comments.slice(0, 1).map((comment) => ({
                      id: comment.id,
                      body: comment.body,
                      createdAt: comment.createdAt,
                      url: comment.url,
                      path: comment.path,
                      line: comment.line,
                      author: {
                        login: comment.authorLogin,
                      },
                    })),
                  },
                  latestComments: {
                    nodes: thread.comments.slice(-1).map((comment) => ({
                      id: comment.id,
                      body: comment.body,
                      createdAt: comment.createdAt,
                      url: comment.url,
                      path: comment.path,
                      line: comment.line,
                      author: {
                        login: comment.authorLogin,
                      },
                    })),
                  },
                })),
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        },
      });
      return;
    }

    if (body.query.includes("ResolveReviewThread")) {
      const threadId = String(body.variables["threadId"]);
      const thread = this.#findReviewThread(threadId);
      thread.isResolved = true;
      json(response, 200, {
        data: {
          resolveReviewThread: {
            thread: {
              id: thread.id,
              isResolved: thread.isResolved,
            },
          },
        },
      });
      return;
    }

    json(response, 400, { errors: [{ message: "unsupported graphql query" }] });
  }

  #requirePullRequestByHead(head: string): PullRequestRecord {
    const pullRequest = [...this.#prs.values()].find(
      (entry) => entry.head === head,
    );
    if (!pullRequest) {
      throw new Error(`Pull request for ${head} not found`);
    }
    return pullRequest;
  }

  #requirePullRequestByRef(ref: string): PullRequestRecord {
    const pullRequest = [...this.#prs.values()].find(
      (entry) => entry.head === ref || entry.latestCommitSha === ref,
    );
    if (!pullRequest) {
      throw new Error(`Pull request for ${ref} not found`);
    }
    return pullRequest;
  }

  #findReviewThread(threadId: string): MockReviewThread {
    for (const pullRequest of this.#prs.values()) {
      const thread = pullRequest.reviewThreads.find(
        (entry) => entry.id === threadId,
      );
      if (thread) {
        return thread;
      }
    }
    throw new Error(`Review thread ${threadId} not found`);
  }
}
