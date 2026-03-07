import { describe, expect, it } from "vitest";
import {
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
});
