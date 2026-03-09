import { describe, expect, it } from "vitest";
import {
  evaluatePlanReviewProtocol,
  evaluatePlanReviewLifecycle,
  type IssueCommentSnapshot,
} from "../../src/tracker/plan-review-policy.js";

function comment(
  body: string,
  createdAt: string,
  id: number,
): IssueCommentSnapshot {
  return {
    id,
    body,
    createdAt,
    url: `https://example.test/issues/32#issuecomment-${id.toString()}`,
    authorLogin: "user",
  };
}

describe("plan-review-policy", () => {
  it("waits when the latest relevant signal is plan-ready", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment("some other comment", "2026-03-07T10:00:00.000Z", 1),
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
      ],
    );

    expect(lifecycle?.kind).toBe("awaiting-plan-review");
  });

  it("waits when the latest relevant signal uses the legacy plan-ready marker", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment("some other comment", "2026-03-07T10:00:00.000Z", 1),
        comment(
          "Plan ready for review.\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
      ],
    );

    expect(lifecycle?.kind).toBe("awaiting-plan-review");
  });

  it("does not wait when a later approval exists", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Plan review: approved\n\nSummary\n- Proceed.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
    );

    expect(lifecycle).toBeNull();
  });

  it("does not wait when the latest signal is waived", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Plan review: waived\n\nSummary\n- Proceed without waiting.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
    );

    expect(lifecycle).toBeNull();
  });

  it("does not wait when the latest signal is changes-requested", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Plan review: changes-requested\n\nRequired changes\n- Split the issue.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
    );

    expect(lifecycle).toBeNull();
  });

  it("returns to waiting when a revised plan-ready comment is newer than prior feedback", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Plan review: changes-requested\n\nRequired changes\n- Split the issue.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
        comment(
          "Plan status: plan-ready\n\nRevised for another pass.",
          "2026-03-07T10:07:00.000Z",
          4,
        ),
      ],
    );

    expect(lifecycle?.kind).toBe("awaiting-plan-review");
  });

  it("requests an acknowledgement comment for approved reviews", () => {
    const protocol = evaluatePlanReviewProtocol(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan status: plan-ready\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Plan review: approved\n\nSummary\n- Proceed.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
    );

    expect(protocol.lifecycle).toBeNull();
    expect(protocol.acknowledgement?.signal).toBe("approved");
    expect(protocol.acknowledgement?.reviewCommentId).toBe(3);
    expect(protocol.acknowledgement?.body).toContain(
      "Plan review acknowledged: approved",
    );
    expect(protocol.acknowledgement?.body).toContain("Review comment id: 3");
  });

  it("does not request a duplicate acknowledgement when one already exists", () => {
    const protocol = evaluatePlanReviewProtocol(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan review: changes-requested\n\nRequired changes\n- Split the issue.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
        comment(
          [
            "Plan review acknowledged: changes-requested",
            "",
            "Review comment id: 3",
            "Review comment URL: https://example.test/issues/32#issuecomment-3",
            "",
            "Next action",
            "- Revise the plan, post a fresh `Plan status: plan-ready` comment, and wait for review again.",
          ].join("\n"),
          "2026-03-07T10:07:00.000Z",
          4,
        ),
      ],
    );

    expect(protocol.lifecycle).toBeNull();
    expect(protocol.acknowledgement).toBeNull();
  });
});
