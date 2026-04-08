import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/observability/logger.js";
import { GitHubClient } from "../../src/tracker/github-client.js";
import { MockGitHubServer } from "../support/mock-github-server.js";

describe("GitHubClient", () => {
  const previousToken = process.env.GH_TOKEN;

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = previousToken;
    }
  });

  function createLoggerSpy(): Logger {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  function createClient(logger?: Logger): GitHubClient {
    return new GitHubClient(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: "https://example.invalid",
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        respectBlockedRelationships: false,
        successComment: "done",
        reviewBotLogins: ["greptile-apps", "cursor"],
      },
      logger,
    );
  }

  it("does not duplicate exhausted review data while another stream paginates", async () => {
    const requests: Array<{
      includeComments: boolean;
      includeReviewThreads: boolean;
      reviewThreadsAfter: string | null;
    }> = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: {
            includeComments: boolean;
            includeReviewThreads: boolean;
            reviewThreadsAfter: string | null;
          };
        };
        requests.push(request.variables);
        const secondPage =
          request.variables.reviewThreadsAfter === "thread-cursor-1";
        const comments = request.variables.includeComments
          ? {
              comments: {
                nodes: [
                  {
                    id: "comment-1",
                    body: "comment one",
                    createdAt: "2026-03-06T00:00:00Z",
                    url: "https://example.com/comment-1",
                    author: { login: "greptile-apps" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          : {};
        const payload = secondPage
          ? {
              data: {
                repository: {
                  pullRequest: {
                    commits: {
                      nodes: [
                        { commit: { committedDate: "2026-03-06T00:00:00Z" } },
                      ],
                    },
                    ...comments,
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread-2",
                          isResolved: false,
                          isOutdated: false,
                          originComments: {
                            nodes: [
                              {
                                id: "thread-comment-2",
                                body: "thread two",
                                createdAt: "2026-03-06T00:01:00Z",
                                url: "https://example.com/thread-2",
                                path: "src/index.ts",
                                line: 2,
                                author: { login: "greptile-apps" },
                              },
                            ],
                          },
                          latestComments: {
                            nodes: [
                              {
                                id: "thread-comment-2",
                                body: "thread two",
                                createdAt: "2026-03-06T00:01:00Z",
                                url: "https://example.com/thread-2",
                                path: "src/index.ts",
                                line: 2,
                                author: { login: "greptile-apps" },
                              },
                            ],
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }
          : {
              data: {
                repository: {
                  pullRequest: {
                    commits: {
                      nodes: [
                        { commit: { committedDate: "2026-03-06T00:00:00Z" } },
                      ],
                    },
                    ...comments,
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread-1",
                          isResolved: false,
                          isOutdated: false,
                          originComments: {
                            nodes: [
                              {
                                id: "thread-comment-1",
                                body: "thread one",
                                createdAt: "2026-03-06T00:00:30Z",
                                url: "https://example.com/thread-1",
                                path: "src/index.ts",
                                line: 1,
                                author: { login: "greptile-apps" },
                              },
                            ],
                          },
                          latestComments: {
                            nodes: [
                              {
                                id: "thread-comment-1",
                                body: "thread one",
                                createdAt: "2026-03-06T00:00:30Z",
                                url: "https://example.com/thread-1",
                                path: "src/index.ts",
                                line: 1,
                                author: { login: "greptile-apps" },
                              },
                            ],
                          },
                        },
                      ],
                      pageInfo: {
                        hasNextPage: true,
                        endCursor: "thread-cursor-1",
                      },
                    },
                  },
                },
              },
            };

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();

    const result = await client.getPullRequestReviewState(23);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      requests.map((request) => ({
        includeComments: request.includeComments,
        includeReviewThreads: request.includeReviewThreads,
        reviewThreadsAfter: request.reviewThreadsAfter,
      })),
    ).toEqual([
      {
        includeComments: true,
        includeReviewThreads: true,
        reviewThreadsAfter: null,
      },
      {
        includeComments: false,
        includeReviewThreads: true,
        reviewThreadsAfter: "thread-cursor-1",
      },
    ]);
    expect(result.comments.nodes.map((comment) => comment.id)).toEqual([
      "comment-1",
    ]);
    expect(result.reviewThreads.nodes.map((thread) => thread.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("sends the current head SHA when merging a pull request", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/repos/sociotechnica-org/symphony-ts")) {
        return new Response(
          JSON.stringify({
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();

    await expect(client.mergePullRequest(23, "head-sha-23")).resolves.toEqual({
      kind: "accepted",
      merged: false,
      message: "landing request accepted",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toBeDefined();
    const init = (
      fetchMock.mock.calls[1] as unknown as [unknown, RequestInit]
    )[1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      sha: "head-sha-23",
      merge_method: "squash",
    });
  });

  it("throws when a REST request succeeds without a JSON payload", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();

    await expect(client.getIssue(23)).rejects.toThrow(
      /returned no json payload/i,
    );
  });

  it("includes the raw response body when a 2xx REST response is non-JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();

    await expect(client.getIssue(23)).rejects.toThrow(
      'GitHub API GET /repos/sociotechnica-org/symphony-ts/issues/23 returned no JSON payload (body: "<html>proxy error</html>")',
    );
  });

  it("retries merge-method discovery after a transient repository lookup failure", async () => {
    let repositoryRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/repos/sociotechnica-org/symphony-ts")) {
        repositoryRequests += 1;
        if (repositoryRequests === 1) {
          return new Response("temporary failure", { status: 500 });
        }
        return new Response(
          JSON.stringify({
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();

    await expect(client.mergePullRequest(23, "head-sha-23")).rejects.toThrow(
      /failed with 500/i,
    );
    await expect(client.mergePullRequest(23, "head-sha-23")).resolves.toEqual({
      kind: "accepted",
      merged: false,
      message: "landing request accepted",
    });
    expect(repositoryRequests).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("logs the auto-detected merge method when multiple GitHub methods are allowed", async () => {
    const logger = createLoggerSpy();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/repos/sociotechnica-org/symphony-ts")) {
        return new Response(
          JSON.stringify({
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient(logger);

    await expect(client.mergePullRequest(23, "head-sha-23")).resolves.toEqual({
      kind: "accepted",
      merged: false,
      message: "landing request accepted",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Auto-detected GitHub merge method",
      {
        repo: "sociotechnica-org/symphony-ts",
        mergeMethod: "merge",
        allowedMergeMethods: ["merge", "squash", "rebase"],
      },
    );
  });

  it("reads configured project queue priority values from GitHub GraphQL", async () => {
    const server = new MockGitHubServer();
    await server.start();
    try {
      server.seedIssue({
        number: 7,
        title: "Queue priority",
        body: "",
        labels: ["symphony:ready"],
      });
      server.setProjectFieldValue({
        projectNumber: 12,
        issueNumber: 7,
        fieldName: "Priority",
        value: {
          kind: "single_select",
          value: "P1",
        },
      });

      const client = new GitHubClient(
        {
          kind: "github",
          repo: "sociotechnica-org/symphony-ts",
          apiUrl: server.baseUrl,
          readyLabel: "symphony:ready",
          runningLabel: "symphony:running",
          failedLabel: "symphony:failed",
          respectBlockedRelationships: false,
          successComment: "done",
          reviewBotLogins: [],
          queuePriority: {
            enabled: true,
            projectNumber: 12,
            fieldName: "Priority",
            optionRankMap: {
              P1: 1,
            },
          },
        },
        createLoggerSpy(),
      );

      const issue = await client.getIssue(7);

      expect(issue.queuePriority).toEqual({
        rank: 1,
        label: "P1",
      });
    } finally {
      await server.stop();
    }
  });

  it("normalizes GitHub blocked-status facts from issue dependency summaries", async () => {
    const server = new MockGitHubServer();
    await server.start();
    try {
      server.seedIssue({
        number: 7,
        title: "Blocked issue",
        body: "",
        labels: ["symphony:ready"],
      });
      server.seedIssue({
        number: 8,
        title: "Unblocked issue",
        body: "",
        labels: ["symphony:ready"],
      });
      server.setIssueBlockedByCount(7, 2);
      server.setIssueBlockedByCount(8, 0);

      const client = new GitHubClient(
        {
          kind: "github",
          repo: "sociotechnica-org/symphony-ts",
          apiUrl: server.baseUrl,
          readyLabel: "symphony:ready",
          runningLabel: "symphony:running",
          failedLabel: "symphony:failed",
          respectBlockedRelationships: true,
          successComment: "done",
          reviewBotLogins: [],
        },
        createLoggerSpy(),
      );

      const statuses = await client.getIssueBlockedStatusByIssueNumber([8, 7]);

      expect(statuses.get(7)).toEqual({
        issueNumber: 7,
        isBlocked: true,
        openBlockerCount: 2,
      });
      expect(statuses.get(8)).toEqual({
        issueNumber: 8,
        isBlocked: false,
        openBlockerCount: 0,
      });
    } finally {
      await server.stop();
    }
  });

  it("throws when GitHub blocked-status data is unavailable", async () => {
    const server = new MockGitHubServer();
    await server.start();
    try {
      server.seedIssue({
        number: 7,
        title: "Blocked issue",
        body: "",
        labels: ["symphony:ready"],
      });
      server.setIssueDependencyQueryFailure(
        "Issue dependency summary unavailable",
      );

      const client = new GitHubClient(
        {
          kind: "github",
          repo: "sociotechnica-org/symphony-ts",
          apiUrl: server.baseUrl,
          readyLabel: "symphony:ready",
          runningLabel: "symphony:running",
          failedLabel: "symphony:failed",
          respectBlockedRelationships: true,
          successComment: "done",
          reviewBotLogins: [],
        },
        createLoggerSpy(),
      );

      await expect(
        client.getIssueBlockedStatusByIssueNumber([7]),
      ).rejects.toThrow(/Issue dependency summary unavailable/);
    } finally {
      await server.stop();
    }
  });

  it("explains when blocked-relationship enforcement is unavailable on the GitHub instance", async () => {
    const server = new MockGitHubServer();
    await server.start();
    try {
      server.seedIssue({
        number: 7,
        title: "Blocked issue",
        body: "",
        labels: ["symphony:ready"],
      });
      server.setIssueDependencyQueryFailure(
        "Cannot query field 'issueDependenciesSummary' on type 'Issue'.",
      );

      const client = new GitHubClient(
        {
          kind: "github",
          repo: "sociotechnica-org/symphony-ts",
          apiUrl: server.baseUrl,
          readyLabel: "symphony:ready",
          runningLabel: "symphony:running",
          failedLabel: "symphony:failed",
          respectBlockedRelationships: true,
          successComment: "done",
          reviewBotLogins: [],
        },
        createLoggerSpy(),
      );

      await expect(
        client.getIssueBlockedStatusByIssueNumber([7]),
      ).rejects.toThrow(
        /disable tracker\.respect_blocked_relationships or use a GitHub instance that exposes issueDependenciesSummary/i,
      );
    } finally {
      await server.stop();
    }
  });
});
