import { describe, expect, it } from "vitest";
import type {
  GitHubPullRequestResponse,
  PullRequestReviewState,
} from "../../src/tracker/github-client.js";
import { createPullRequestSnapshot } from "../../src/tracker/pull-request-snapshot.js";
import type { PullRequestCheck } from "../../src/domain/pull-request.js";
import type { GitHubReviewerAppConfig } from "../../src/domain/workflow.js";

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

const successfulDevinCheck: PullRequestCheck = {
  name: "Devin Review",
  status: "success",
  conclusion: "success",
  detailsUrl: "https://example.test/checks/devin",
};

const devinReviewerApps: readonly GitHubReviewerAppConfig[] = [
  {
    key: "devin",
    accepted: true,
    required: true,
  },
];

describe("createPullRequestSnapshot", () => {
  it("preserves draft status from GitHub pull request details", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest: {
        ...pullRequest,
        mergeable: true,
        mergeable_state: "clean",
        draft: true,
      },
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
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: [],
    });

    expect(snapshot.draft).toBe(true);
  });

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
              body: "## Devin Review: Found 1 potential issues",
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
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    expect(snapshot.actionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]?.authorLogin).toBe(
      "devin-ai-integration",
    );
    expect(snapshot.reviewerApps[0]).toMatchObject({
      reviewerKey: "devin",
      verdict: "issues-found",
    });
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

    expect(snapshot.requiredReviewerState).toBe("satisfied");
    expect(snapshot.observedReviewerKeys).toEqual(["legacy-bot-review"]);
  });

  it("keeps devin-owned review threads actionable after migrating to reviewer_apps", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [],
      reviewState: createReviewState([
        {
          id: "comment-1",
          authorLogin: "devin-ai-integration",
          body: "Please update this condition.",
          createdAt: "2026-03-06T01:00:00.000Z",
          url: "https://example.test/thread/1#comment-1",
        },
      ]),
      reviewerApps: devinReviewerApps,
      reviewBotLogins: ["devin-ai-integration"],
    });

    expect(snapshot.reviewerApps).toContainEqual(
      expect.objectContaining({
        reviewerKey: "devin",
        verdict: "issues-found",
      }),
    );
    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]).toMatchObject({
      kind: "review-thread",
      threadId: "thread-1",
      authorLogin: "devin-ai-integration",
    });
    expect(snapshot.unresolvedThreadIds).toEqual(["thread-1"]);
    expect(snapshot.observedReviewerKeys).toEqual(["devin"]);
  });

  it("does not surface a passing devin review as actionable feedback when unresolved threads already require rework", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [successfulDevinCheck],
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
              id: "review-1",
              author: { login: "devin-ai-integration" },
              body: "## ✅ Devin Review: No Issues Found",
              submittedAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#review-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              id: "thread-1",
              isResolved: false,
              isOutdated: false,
              originComments: {
                nodes: [
                  {
                    id: "comment-1",
                    body: "Please update this condition.",
                    createdAt: "2026-03-06T01:02:00.000Z",
                    url: "https://example.test/thread/1#comment-1",
                    path: "src/index.ts",
                    line: 10,
                    author: { login: "devin-ai-integration" },
                  },
                ],
              },
              latestComments: {
                nodes: [
                  {
                    id: "comment-1",
                    body: "Please update this condition.",
                    createdAt: "2026-03-06T01:02:00.000Z",
                    url: "https://example.test/thread/1#comment-1",
                    path: "src/index.ts",
                    line: 10,
                    author: { login: "devin-ai-integration" },
                  },
                ],
              },
            },
          ],
        },
      },
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    const devinSnapshot = snapshot.reviewerApps.find(
      (reviewer) => reviewer.reviewerKey === "devin",
    );

    expect(devinSnapshot).toMatchObject({
      reviewerKey: "devin",
      verdict: "issues-found",
    });
    expect(devinSnapshot?.actionableFeedback).toHaveLength(1);
    expect(devinSnapshot?.actionableFeedback[0]).toMatchObject({
      id: "comment-1",
      kind: "review-thread",
      threadId: "thread-1",
    });
    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]).toMatchObject({
      id: "comment-1",
      kind: "review-thread",
      threadId: "thread-1",
    });
  });

  it("preserves legacy devin check coverage for approved review bot configs", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [successfulDevinCheck],
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
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewBotLogins: ["devin-ai-integration"],
      approvedReviewBotLogins: ["devin-ai-integration"],
    });

    expect(snapshot.requiredReviewerState).toBe("satisfied");
    expect(snapshot.observedReviewerKeys).toEqual(["legacy-bot-review"]);
  });

  it("ignores informational Devin review threads for legacy approved bot review", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [successfulDevinCheck],
      reviewState: createReviewState([
        {
          id: "comment-1",
          authorLogin: "devin-ai-integration",
          body: `<!-- devin-review-comment {"id":"thread-1"} -->

📝 **Info: Draft check placement is after reviewer-state checks but still prevents awaiting-landing-command**`,
          createdAt: "2026-03-06T01:00:00.000Z",
          url: "https://example.test/thread/1#comment-1",
        },
      ]),
      reviewBotLogins: [],
      approvedReviewBotLogins: ["devin-ai-integration"],
    });

    expect(snapshot.requiredReviewerState).toBe("satisfied");
    expect(snapshot.reviewerVerdict).toBe("no-blocking-verdict");
    expect(snapshot.botActionableReviewFeedback).toHaveLength(0);
    expect(snapshot.actionableReviewFeedback).toHaveLength(0);
    expect(snapshot.unresolvedThreadIds).toEqual([]);
    expect(snapshot.observedReviewerKeys).toEqual(["legacy-bot-review"]);
  });

  it("treats legacy approved review bot findings as accepted actionable feedback", () => {
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
              author: { login: "greptile[bot]" },
              body: "Please fix this before merging.",
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
      reviewBotLogins: [],
      approvedReviewBotLogins: ["greptile[bot]"],
    });

    const legacySnapshot = snapshot.reviewerApps.find(
      (reviewer) => reviewer.reviewerKey === "legacy-bot-review",
    );

    expect(legacySnapshot).toMatchObject({
      reviewerKey: "legacy-bot-review",
      accepted: true,
      required: true,
      verdict: "issues-found",
    });
    expect(snapshot.botActionableReviewFeedback).toHaveLength(1);
    expect(snapshot.botActionableReviewFeedback[0]).toMatchObject({
      id: "comment-1",
      kind: "issue-comment",
      authorLogin: "greptile[bot]",
    });
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

    expect(snapshot.requiredReviewerState).toBe("missing");
    expect(snapshot.observedReviewerKeys).toEqual([]);
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

    expect(snapshot.requiredReviewerState).toBe("missing");
    expect(snapshot.observedReviewerKeys).toEqual([]);
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
              id: "review-1",
              author: { login: "devin-ai-integration" },
              body: "## ✅ Devin Review: No Issues Found",
              submittedAt: "2026-03-06T01:00:00.000Z",
              url: "https://example.test/pr/24#review-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    expect(snapshot.requiredReviewerState).toBe("satisfied");
    expect(snapshot.observedReviewerKeys).toEqual(["devin"]);
  });

  it("records required approved bot review presence from a successful reviewer-app status context on the current head", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [successfulDevinCheck],
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
          nodes: [],
        },
        reviews: {
          nodes: [
            {
              id: "review-1",
              author: { login: "devin-ai-integration" },
              body: "## ✅ Devin Review: No Issues Found",
              submittedAt: "2026-03-06T03:00:00.000Z",
              url: "https://example.test/pr/24#review-1",
            },
          ],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    expect(snapshot.requiredReviewerState).toBe("satisfied");
    expect(snapshot.observedReviewerKeys).toEqual(["devin"]);
  });

  it("treats reviewer-app check success without a current-head verdict as unknown", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [successfulDevinCheck],
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
          nodes: [],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    expect(snapshot.requiredReviewerState).toBe("unknown");
    expect(snapshot.observedReviewerKeys).toEqual(["devin"]);
  });

  it("does not treat unrelated successful status contexts as approved reviewer coverage", () => {
    const snapshot = createPullRequestSnapshot({
      branchName: "symphony/19",
      pullRequest,
      checks: [
        {
          name: "check",
          status: "success",
          conclusion: "success",
          detailsUrl: "https://example.test/checks/ci",
        },
      ],
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
          nodes: [],
        },
        reviews: {
          nodes: [],
        },
        reviewThreads: {
          nodes: [],
        },
      },
      reviewerApps: devinReviewerApps,
      reviewBotLogins: [],
    });

    expect(snapshot.requiredReviewerState).toBe("missing");
    expect(snapshot.observedReviewerKeys).toEqual([]);
  });

  it("detects a member-authored /land command on the current PR head", () => {
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
    expect(snapshot.landingCommand).toEqual({
      commentId: "comment-1",
      authorLogin: "jessmartin",
      observedAt: "2026-03-06T01:00:00.000Z",
      url: "https://example.test/pr/24#comment-1",
    });
  });

  it("detects a non-reviewer bot /land command on the current PR head", () => {
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
              author: { login: "symphony-operator[bot]" },
              body: "/land",
              createdAt: "2026-03-06T02:01:00.000Z",
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
    expect(snapshot.landingCommand).toEqual({
      commentId: "comment-1",
      authorLogin: "symphony-operator[bot]",
      observedAt: "2026-03-06T02:01:00.000Z",
      url: "https://example.test/pr/24#comment-1",
    });
  });

  it("ignores stale or reviewer-bot /land comments", () => {
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
    expect(snapshot.landingCommand).toBeNull();
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
    expect(snapshot.landingCommand).toBeNull();
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
    expect(snapshot.landingCommand).toBeNull();
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

  it("does not treat a Cursor PR summary comment as approved review coverage", () => {
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
      reviewBotLogins: ["cursor"],
      approvedReviewBotLogins: ["cursor"],
    });

    expect(snapshot.requiredReviewerState).toBe("missing");
    expect(snapshot.observedReviewerKeys).toEqual([]);
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
