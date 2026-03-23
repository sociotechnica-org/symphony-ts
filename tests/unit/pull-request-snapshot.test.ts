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
    reviews: {
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

  it("keeps a deleted-author thread actionable and non-bot", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: createReviewState([
        {
          id: "comment-1",
          authorLogin: null,
          body: "Please adjust this logic",
          createdAt: "2026-03-06T01:00:00.000Z",
          url: "https://example.test/thread/1#comment-1",
        },
      ]),
      reviewBotLogins: ["greptile-apps", "cursor"],
    });

    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
    expect(snapshot.actionableReviewFeedback).toHaveLength(1);
    expect(snapshot.actionableReviewFeedback[0]?.authorLogin).toBeNull();
    expect(snapshot.unresolvedThreadIds).toEqual([]);
  });

  it("treats configured top-level bot review comments as bot feedback", () => {
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
              authorAssociation: "NONE",
              author: { login: "devin-ai-integration" },
              body: "Automated review found a shutdown edge case.",
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor", "devin-ai-integration"],
    });

    expect(snapshot.actionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]?.authorLogin).toBe(
      "devin-ai-integration",
    );
  });

  it("records required approved bot review presence from a clean summary comment", () => {
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
              authorAssociation: "NONE",
              author: { login: "greptile-apps" },
              body: '<h3 class="summary">Greptile Summary</h3>\n\nThis PR is safe to merge.',
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
      approvedReviewBotLogins: ["greptile-apps"],
    });

    expect(snapshot.requiredApprovedReviewCoverage).toBe("satisfied");
    expect(snapshot.observedApprovedReviewBotLogins).toEqual(["greptile-apps"]);
  });

  it("ignores stale required approved bot review from before the current head commit", () => {
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
              body: "This PR is safe to merge.",
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor"],
      approvedReviewBotLogins: ["greptile-apps"],
    });

    expect(snapshot.requiredApprovedReviewCoverage).toBe("missing");
    expect(snapshot.observedApprovedReviewBotLogins).toEqual([]);
  });

  it("ignores cursor acknowledgement noise for required approved bot review presence", () => {
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
              authorAssociation: "NONE",
              author: { login: "cursor[bot]" },
              body: `Taking a look!

<div><a href="https://cursor.com/agents/example">Open in Web</a>&nbsp;<a href="https://cursor.com/background-agent?bcId=example">Open in Cursor</a></div>`,
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor", "cursor[bot]"],
      approvedReviewBotLogins: ["cursor[bot]"],
    });

    expect(snapshot.requiredApprovedReviewCoverage).toBe("missing");
    expect(snapshot.observedApprovedReviewBotLogins).toEqual([]);
  });

  it("records required approved bot review presence from a top-level PR review", () => {
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
          nodes: [],
        },
        reviews: {
          nodes: [
            {
              author: { login: "devin-ai-integration" },
              body: "## ✅ Devin Review: No Issues Found",
              submittedAt: "2026-03-06T01:00:00.000Z",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor", "devin-ai-integration"],
      approvedReviewBotLogins: ["devin-ai-integration"],
    });

    expect(snapshot.requiredApprovedReviewCoverage).toBe("satisfied");
    expect(snapshot.observedApprovedReviewBotLogins).toEqual([
      "devin-ai-integration",
    ]);
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

  it("ignores Cursor PR summary comments as actionable bot feedback", () => {
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
              authorAssociation: "NONE",
              author: { login: "cursor" },
              body: "## PR Summary\n\n<!-- CURSOR_SUMMARY -->\nAutomated summary only.",
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

    expect(snapshot.actionableReviewFeedback).toHaveLength(0);
    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
  });

  it("ignores Cursor taking-a-look acknowledgement comments", () => {
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
              authorAssociation: "NONE",
              author: { login: "cursor[bot]" },
              body: `Taking a look!

<div><a href="https://cursor.com/agents/example">Open in Web</a>&nbsp;<a href="https://cursor.com/background-agent?bcId=example">Open in Cursor</a></div>`,
              createdAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#comment-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["greptile-apps", "cursor", "cursor[bot]"],
    });

    expect(snapshot.actionableReviewFeedback).toHaveLength(0);
    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
  });

  it("ignores Greptile summary comments as actionable bot feedback", () => {
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
              authorAssociation: "NONE",
              author: { login: "greptile-apps" },
              body: '<h3 class="summary">Greptile Summary</h3>\n\nThis PR is safe to merge.',
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

    expect(snapshot.actionableReviewFeedback).toHaveLength(0);
    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
  });
});
