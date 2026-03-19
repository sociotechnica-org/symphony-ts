import { describe, expect, it } from "vitest";
import {
  evaluateGuardedLanding,
  type GuardedLandingSnapshot,
} from "../../src/tracker/guarded-landing.js";

function createSnapshot(
  overrides: Partial<GuardedLandingSnapshot> = {},
): GuardedLandingSnapshot {
  return {
    approvedHeadSha: "approved-head",
    pullRequest: {
      number: 23,
      url: "https://example.test/pulls/23",
      branchName: "symphony/23",
      headSha: "approved-head",
      latestCommitAt: "2026-03-13T00:00:00.000Z",
    },
    landingState: "open",
    mergeable: true,
    mergeStateStatus: "clean",
    draft: false,
    pendingCheckNames: [],
    failingCheckNames: [],
    botActionableReviewFeedback: [],
    unresolvedReviewThreadCount: 0,
    requiredApprovedReviewSatisfied: true,
    ...overrides,
  };
}

describe("evaluateGuardedLanding", () => {
  it("rejects unresolved review threads", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        unresolvedReviewThreadCount: 1,
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "review-threads-unresolved",
      lifecycleKind: "awaiting-human-review",
    });
  });

  it("rejects non-terminal checks", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        pendingCheckNames: ["CI"],
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: "awaiting-system-checks",
    });
  });

  it("prefers checks-not-green over an unstable merge state", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        mergeStateStatus: "unstable",
        failingCheckNames: ["CI"],
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: "rework-required",
    });
  });

  it("treats failed terminal checks as rework-required", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        failingCheckNames: ["CI"],
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: "rework-required",
    });
  });

  it("rejects stale approved head shas", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        pullRequest: {
          number: 23,
          url: "https://example.test/pulls/23",
          branchName: "symphony/23",
          headSha: "new-head",
          latestCommitAt: "2026-03-13T00:01:00.000Z",
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "stale-approved-head",
      lifecycleKind: "awaiting-landing-command",
    });
  });

  it("rejects unknown mergeability", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        mergeable: null,
        mergeStateStatus: "unknown",
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "mergeability-unknown",
      lifecycleKind: "awaiting-landing",
    });
  });

  it("rejects draft pull requests", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        draft: true,
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
      summary: expect.stringContaining("still a draft"),
    });
  });

  it("rejects non-passing merge state statuses", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        mergeStateStatus: "blocked",
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
      summary: expect.stringContaining("merge state 'blocked'"),
    });
  });

  it("rejects open bot review feedback", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        botActionableReviewFeedback: [
          {
            kind: "issue-comment",
            id: "bot-feedback-1",
            threadId: null,
            authorLogin: "greptile-apps",
            body: "Please fix this",
            createdAt: "2026-03-13T00:02:00.000Z",
            url: "https://example.test/comments/1",
            path: null,
            line: null,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "actionable-review-feedback",
      lifecycleKind: "rework-required",
    });
  });

  it("rejects landing when required approved bot review is missing", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        requiredApprovedReviewSatisfied: false,
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "required-bot-review-missing",
      lifecycleKind: "awaiting-human-review",
    });
  });

  it("rejects already merged pull requests explicitly", () => {
    const result = evaluateGuardedLanding(
      createSnapshot({
        landingState: "merged",
        mergeable: null,
        mergeStateStatus: "unknown",
      }),
    );

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "merged",
      summary: expect.stringContaining("already merged"),
    });
  });

  it("accepts a clean guarded landing snapshot", () => {
    expect(evaluateGuardedLanding(createSnapshot())).toEqual({
      kind: "requested",
      summary:
        "Landing requested for pull request https://example.test/pulls/23.",
    });
  });
});
