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
      headSha: "head-sha-16",
      latestCommitAt: "2026-03-06T00:00:00.000Z",
    },
    landingState: "open",
    hasLandingCommand: false,
    checks: [],
    pendingCheckNames: [],
    failingCheckNames: [],
    actionableReviewFeedback: [],
    botActionableReviewFeedback: [],
    unresolvedThreadIds: [],
    requiredApprovedReviewSatisfied: true,
    observedApprovedReviewBotLogins: [],
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
    expect(second.lifecycle.kind).toBe("awaiting-landing-command");
    expect(second.lifecycle.pendingCheckNames).toEqual([]);
    expect(second.lifecycle.failingCheckNames).toEqual([]);
  });

  it("requires an explicit landing command before landing starts", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        hasLandingCommand: true,
        checks: [
          {
            name: "CI",
            status: "success",
            conclusion: "success",
            detailsUrl: null,
          },
        ],
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("awaiting-landing");
    expect(lifecycle.summary).toMatch(/awaiting landing/i);
  });

  it("reports handoff-ready only after merge is observed", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        landingState: "merged",
        pendingCheckNames: ["ci"],
        failingCheckNames: ["lint"],
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("handoff-ready");
    expect(lifecycle.summary).toMatch(/has merged/i);
    expect(lifecycle.pendingCheckNames).toEqual([]);
    expect(lifecycle.failingCheckNames).toEqual([]);
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

    expect(lifecycle.kind).toBe("awaiting-human-review");
    expect(lifecycle.actionableReviewFeedback).toHaveLength(1);
  });

  it("waits on required approved bot review before allowing landing", () => {
    const lifecycle = evaluatePullRequestLifecycle(
      createSnapshot({
        checks: [
          {
            name: "CI",
            status: "success",
            conclusion: "success",
            detailsUrl: null,
          },
        ],
        requiredApprovedReviewSatisfied: false,
      }),
      undefined,
    ).lifecycle;

    expect(lifecycle.kind).toBe("awaiting-human-review");
    expect(lifecycle.summary).toMatch(/required approved bot review/i);
  });

  it("preserves no-check stabilization while required approved bot review is missing", () => {
    const snapshot = createSnapshot({
      requiredApprovedReviewSatisfied: false,
    });

    const first = evaluatePullRequestLifecycle(snapshot, undefined);
    const second = evaluatePullRequestLifecycle(
      snapshot,
      first.nextNoCheckObservation ?? undefined,
    );
    const third = evaluatePullRequestLifecycle(
      snapshot,
      second.nextNoCheckObservation ?? undefined,
    );

    expect(first.lifecycle.kind).toBe("awaiting-system-checks");
    expect(second.lifecycle.kind).toBe("awaiting-human-review");
    expect(second.nextNoCheckObservation).toEqual(first.nextNoCheckObservation);
    expect(third.lifecycle.kind).toBe("awaiting-human-review");
    expect(third.nextNoCheckObservation).toEqual(first.nextNoCheckObservation);
  });

  it("requires rework for failing checks or bot feedback", () => {
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

    expect(lifecycle.kind).toBe("rework-required");
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
