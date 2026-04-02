import { describe, expect, it } from "vitest";
import {
  buildDefaultPlanReviewReplyGuidance,
  buildDefaultPlanReviewReplyTemplateBlock,
  type PlanReviewProtocol,
} from "../../src/domain/plan-review.js";
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

const customProtocolBase = {
  planReadySignal: "Review status: ready-for-human-plan",
  legacyPlanReadySignals: [],
  approvedSignal: "Review verdict: ship-it",
  changesRequestedSignal: "Review verdict: needs-revision",
  waivedSignal: "Review verdict: waived",
  metadataLabels: {
    planPath: "Plan file",
    branchName: "Issue branch",
    planUrl: "Plan link",
    branchUrl: "Branch link",
    compareUrl: "Diff link",
  },
} as const;

const customProtocol: PlanReviewProtocol = {
  ...customProtocolBase,
  reviewReplyGuidance: buildDefaultPlanReviewReplyGuidance(customProtocolBase),
  replyTemplateBlock:
    buildDefaultPlanReviewReplyTemplateBlock(customProtocolBase),
};

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

    expect(lifecycle?.kind).toBe("awaiting-human-handoff");
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

    expect(lifecycle?.kind).toBe("awaiting-human-handoff");
  });

  it("does not treat the undotted legacy plan-ready marker as valid", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan ready for review\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
      ],
    );

    expect(lifecycle).toBeNull();
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

    expect(lifecycle?.kind).toBe("missing-target");
    expect(lifecycle?.summary).toMatch(/plan review approved/i);
    expect(lifecycle?.summary).toMatch(/resume implementation/i);
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

    expect(lifecycle?.kind).toBe("missing-target");
    expect(lifecycle?.summary).toMatch(/plan review waived/i);
    expect(lifecycle?.summary).toMatch(/resume implementation/i);
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

    expect(lifecycle?.kind).toBe("missing-target");
    expect(lifecycle?.summary).toMatch(/requested changes/i);
    expect(lifecycle?.summary).toMatch(/revise the plan/i);
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

    expect(lifecycle?.kind).toBe("awaiting-human-handoff");
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

    expect(protocol.lifecycle?.kind).toBe("missing-target");
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

    expect(protocol.lifecycle?.kind).toBe("missing-target");
    expect(protocol.acknowledgement).toBeNull();
  });

  it("ignores review decisions that are not anchored to a prior plan-ready handoff", () => {
    const protocol = evaluatePlanReviewProtocol(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Plan review: approved\n\nSummary\n- Proceed.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
    );

    expect(protocol.lifecycle).toBeNull();
    expect(protocol.acknowledgement).toBeNull();
  });

  it("recognizes configured plan-review markers", () => {
    const lifecycle = evaluatePlanReviewLifecycle(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Review status: ready-for-human-plan\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
      ],
      customProtocol,
    );

    expect(lifecycle?.kind).toBe("awaiting-human-handoff");
  });

  it("uses the configured plan-ready marker in acknowledgement guidance", () => {
    const protocol = evaluatePlanReviewProtocol(
      "symphony/32",
      "https://example.test/issues/32",
      [
        comment(
          "Review status: ready-for-human-plan\n\nWaiting for review.",
          "2026-03-07T10:05:00.000Z",
          2,
        ),
        comment(
          "Review verdict: needs-revision\n\nRequired changes\n- Split the issue.",
          "2026-03-07T10:06:00.000Z",
          3,
        ),
      ],
      customProtocol,
    );

    expect(protocol.lifecycle?.kind).toBe("missing-target");
    expect(protocol.acknowledgement?.body).toContain(
      "`Review status: ready-for-human-plan`",
    );
  });
});
