import { describe, expect, it } from "vitest";
import type {
  GitHubPullRequestResponse,
  PullRequestReviewState,
} from "../../src/tracker/github-client.js";
import { createPullRequestSnapshot } from "../../src/tracker/pull-request-snapshot.js";

function createReviewState(
  comments: ReadonlyArray<{
    id: string;
    authorLogin: string | null;
    body: string;
    createdAt: string;
    url: string;
    path?: string | null;
    line?: number | null;
  }>,
): PullRequestReviewState {
  return {
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-03-06T00:00:00.000Z",
          },
        },
      ],
    },
    comments: {
      nodes: [],
    },
    reviewThreads: {
      nodes: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          originComments: {
            nodes: comments.slice(0, 1).map((comment) => ({
              id: comment.id,
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url,
              path: comment.path ?? "src/index.ts",
              line: comment.line ?? 10,
              author:
                comment.authorLogin === null
                  ? null
                  : { login: comment.authorLogin },
            })),
          },
          latestComments: {
            nodes: comments.slice(-1).map((comment) => ({
              id: comment.id,
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url,
              path: comment.path ?? "src/index.ts",
              line: comment.line ?? 10,
              author:
                comment.authorLogin === null
                  ? null
                  : { login: comment.authorLogin },
            })),
          },
        },
      ],
    },
  };
}

const pullRequest: GitHubPullRequestResponse = {
  number: 24,
  html_url: "https://example.test/pulls/24",
  state: "open",
  landingState: "open",
  mergedAt: null,
  head: {
    ref: "symphony/19",
    sha: "sha-1",
  },
};

describe("createPullRequestSnapshot", () => {
  it("keeps a bot-owned thread actionable when a human replies", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: createReviewState([
        {
          id: "comment-1",
          authorLogin: "greptile-apps",
          body: "Bot feedback",
          createdAt: "2026-03-06T01:00:00.000Z",
          url: "https://example.test/thread/1#comment-1",
        },
        {
          id: "comment-2",
          authorLogin: "jessmartin",
          body: "I am looking into this",
          createdAt: "2026-03-06T01:01:00.000Z",
          url: "https://example.test/thread/1#comment-2",
        },
      ]),
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]?.authorLogin).toBe(
      "greptile-apps",
    );
    expect(snapshot.unresolvedThreadIds).toEqual(["thread-1"]);
  });

  it("keeps a human-owned thread non-bot even if a bot replies", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: createReviewState([
        {
          id: "comment-1",
          authorLogin: "jessmartin",
          body: "Please adjust this logic",
          createdAt: "2026-03-06T01:00:00.000Z",
          url: "https://example.test/thread/1#comment-1",
        },
        {
          id: "comment-2",
          authorLogin: "greptile-apps",
          body: "Automated note",
          createdAt: "2026-03-06T01:01:00.000Z",
          url: "https://example.test/thread/1#comment-2",
        },
      ]),
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
    expect(snapshot.actionableReviewFeedback).toHaveLength(1);
    expect(snapshot.actionableReviewFeedback[0]?.authorLogin).toBe(
      "jessmartin",
    );
    expect(snapshot.unresolvedThreadIds).toEqual([]);
  });

  it("detects a human /land command on the current PR head", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: {
        commits: {
          nodes: [
            {
              commit: {
                committedDate: "2026-03-06T00:00:00.000Z",
              },
            },
          ],
        },
        comments: {
          nodes: [
            {
              id: "comment-1",
              authorAssociation: "MEMBER",
              author: { login: "jessmartin" },
              body: "/land\n\nShip it.",
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.hasLandingCommand).toBe(true);
  });

  it("ignores stale or bot-authored /land comments", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: {
        commits: {
          nodes: [
            {
              commit: {
                committedDate: "2026-03-06T02:00:00.000Z",
              },
            },
          ],
        },
        comments: {
          nodes: [
            {
              id: "comment-1",
              authorAssociation: "NONE",
              author: { login: "greptile-apps" },
              body: "/land",
              createdAt: "2026-03-06T02:01:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
            {
              id: "comment-2",
              authorAssociation: "MEMBER",
              author: { login: "jessmartin" },
              body: "/land",
              createdAt: "2026-03-06T01:59:00.000Z",
              url: "https://example.test/pr/24#comment-2",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.hasLandingCommand).toBe(false);
  });

  it("ignores /land comments from non-member humans", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: {
        commits: {
          nodes: [
            {
              commit: {
                committedDate: "2026-03-06T00:00:00.000Z",
              },
            },
          ],
        },
        comments: {
          nodes: [
            {
              id: "comment-1",
              authorAssociation: "CONTRIBUTOR",
              author: { login: "outside-user" },
              body: "/land",
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.hasLandingCommand).toBe(false);
  });

  it("fails closed when the review snapshot has no latest commit timestamp", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: {
        commits: {
          nodes: [],
        },
        comments: {
          nodes: [
            {
              id: "comment-1",
              authorAssociation: "MEMBER",
              author: { login: "jessmartin" },
              body: "/land",
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.hasLandingCommand).toBe(false);
    expect(snapshot.pullRequest.latestCommitAt).toBeNull();
  });
});
