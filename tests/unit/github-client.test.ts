import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/observability/logger.js";
import { GitHubClient } from "../../src/tracker/github-client.js";

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

    const client = new GitHubClient({
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.invalid",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

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

    const client = new GitHubClient({
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.invalid",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

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

    const client = new GitHubClient({
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.invalid",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    await expect(client.getIssue(23)).rejects.toThrow(
      /returned no json payload/i,
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

    const client = new GitHubClient({
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.invalid",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

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

    const client = new GitHubClient(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: "https://example.invalid",
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        successComment: "done",
        reviewBotLogins: ["greptile-apps", "cursor"],
      },
      logger,
    );

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
});
