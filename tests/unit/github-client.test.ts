import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("does not duplicate exhausted review data while another stream paginates", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: {
            reviewThreadsAfter: string | null;
          };
        };
        const secondPage =
          request.variables.reviewThreadsAfter === "thread-cursor-1";
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
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread-2",
                          isResolved: false,
                          isOutdated: false,
                          comments: {
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
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread-1",
                          isResolved: false,
                          isOutdated: false,
                          comments: {
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
    expect(result.comments.nodes.map((comment) => comment.id)).toEqual([
      "comment-1",
    ]);
    expect(result.reviewThreads.nodes.map((thread) => thread.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });
});
