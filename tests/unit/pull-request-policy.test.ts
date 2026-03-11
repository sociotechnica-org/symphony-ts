import { describe, expect, it } from "vitest";
import { evaluatePullRequestLifecycle } from "../../src/tracker/pull-request-policy.js";
import type { PullRequestSnapshot } from "../../src/tracker/pull-request-snapshot.js";

function createSnapshot(
  overrides?: Partial<PullRequestSnapshot>,
): PullRequestSnapshot {
  return {
    branchName: "symphony/16",
    pullRequest: {
      number: 16,
      url: "https://example.test/pulls/16",
      branchName: "symphony/16",
      latestCommitAt: "2026-03-06T00:00:00.000Z",
    },
    landingState: "open",
    checks: [],
    pendingCheckNames: [],
    failingCheckNames: [],
    actionableReviewFeedback: [],
    botActionableReviewFeedback: [],
    unresolvedThreadIds: [],
    ...overrides,
  };
}

describe("pull-request-policy", () => {
  it("stabilizes no-check PRs before reporting them as awaiting landing", () => {
    const snapshot = createSnapshot();

    const first = evaluatePullRequestLifecycle(snapshot, undefined);
    const second = evaluatePullRequestLifecycle(
      snapshot,
      first.nextNoCheckObservation ?? undefined,
    );

    expect(first.lifecycle.kind).toBe("awaiting-system-checks");
    expect(second.lifecycle.kind).toBe("awaiting-landing");
  });

  it("reports handoff-ready only after merge is observed", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        landingState: "merged",
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("handoff-ready");
    expect(lifecycle.summary).toMatch(/has merged/i);
  });

  it("waits on human-only review feedback without scheduling follow-up", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        actionableReviewFeedback: [
          {
            id: "human-1",
            kind: "review-thread",
            threadId: "thread-1",
            authorLogin: "jess",
            body: "please clarify",
            createdAt: "2026-03-06T00:00:00.000Z",
            url: "https://example.test/thread/1",
            path: "src/file.ts",
            line: 10,
          },
        ],
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("awaiting-system-checks");
    expect(lifecycle.actionableReviewFeedback).toHaveLength(1);
  });

  it("requires follow-up for failing checks or bot feedback", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        failingCheckNames: ["CI"],
        actionableReviewFeedback: [
          {
            id: "bot-1",
            kind: "review-thread",
            threadId: "thread-2",
            authorLogin: "greptile[bot]",
            body: "fix this",
            createdAt: "2026-03-06T00:00:00.000Z",
            url: "https://example.test/thread/2",
            path: "src/file.ts",
            line: 12,
          },
        ],
        botActionableReviewFeedback: [
          {
            id: "bot-1",
            kind: "review-thread",
            threadId: "thread-2",
            authorLogin: "greptile[bot]",
            body: "fix this",
            createdAt: "2026-03-06T00:00:00.000Z",
            url: "https://example.test/thread/2",
            path: "src/file.ts",
            line: 12,
          },
        ],
        unresolvedThreadIds: ["thread-2"],
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("actionable-follow-up");
    expect(lifecycle.failingCheckNames).toEqual(["CI"]);
    expect(lifecycle.unresolvedThreadIds).toEqual(["thread-2"]);
  });

  it("waits while failing checks coexist with pending checks", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        pendingCheckNames: ["integration"],
        failingCheckNames: ["lint"],
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("awaiting-system-checks");
    expect(lifecycle.pendingCheckNames).toEqual(["integration"]);
    expect(lifecycle.failingCheckNames).toEqual(["lint"]);
  });

  it("preserves human review feedback while checks are pending", () => {
    const feedback = [
      {
        id: "human-1",
        kind: "review-thread" as const,
        threadId: "thread-1",
        authorLogin: "jess",
        body: "please clarify",
        createdAt: "2026-03-06T00:00:00.000Z",
        url: "https://example.test/thread/1",
        path: "src/file.ts",
        line: 10,
      },
    ];
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        pendingCheckNames: ["integration"],
        actionableReviewFeedback: feedback,
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("awaiting-system-checks");
    expect(lifecycle.pendingCheckNames).toEqual(["integration"]);
    expect(lifecycle.actionableReviewFeedback).toEqual(feedback);
  });
});
