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
          comments: {
            nodes: comments.map((comment) => ({
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
});
