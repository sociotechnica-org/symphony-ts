import { describe, expect, it } from "vitest";
import {
  buildDefaultPlanReviewReplyGuidance,
  buildDefaultPlanReviewReplyTemplateBlock,
  type PlanReviewProtocol,
} from "../../src/domain/plan-review.js";
import {
  buildPlanReadyCommentMetadata,
  formatPlanReadyComment,
  parsePlanReadyCommentMetadata,
} from "../../src/tracker/plan-review-comment.js";

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

describe("plan-review-comment", () => {
  it("formats a recoverable plan-ready comment with branch and GitHub links", () => {
    const body = formatPlanReadyComment({
      repo: "sociotechnica-org/symphony-ts",
      planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchName: "symphony/53",
      summaryLines: [
        "Tighten the plan-review handoff so the reviewed plan is pushed before review is requested.",
      ],
    });

    expect(body).toContain("Plan status: plan-ready");
    expect(body).toContain(
      "Plan path: `docs/plans/053-plan-review-branch-recoverability/plan.md`",
    );
    expect(body).toContain("Branch: `symphony/53`");
    expect(body).toContain(
      "Plan URL: https://github.com/sociotechnica-org/symphony-ts/blob/symphony/53/docs/plans/053-plan-review-branch-recoverability/plan.md",
    );
    expect(body).toContain(
      "Branch URL: https://github.com/sociotechnica-org/symphony-ts/tree/symphony/53",
    );
    expect(body).toContain(
      "Compare URL: https://github.com/sociotechnica-org/symphony-ts/compare/main...symphony/53",
    );
    expect(body).toContain("Plan review: approved");
    expect(body).toContain("Plan review: changes-requested");
    expect(body).toContain("Plan review: waived");
  });

  it("parses recoverability metadata from an enriched plan-ready comment", () => {
    const body = formatPlanReadyComment({
      repo: "sociotechnica-org/symphony-ts",
      planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchName: "symphony/53",
      summaryLines: ["Ready for review."],
    });

    expect(parsePlanReadyCommentMetadata(body)).toEqual({
      planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchName: "symphony/53",
      planUrl:
        "https://github.com/sociotechnica-org/symphony-ts/blob/symphony/53/docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchUrl:
        "https://github.com/sociotechnica-org/symphony-ts/tree/symphony/53",
      compareUrl:
        "https://github.com/sociotechnica-org/symphony-ts/compare/main...symphony/53",
    });
  });

  it("returns null when a plan-ready comment omits recoverability metadata", () => {
    expect(
      parsePlanReadyCommentMetadata(
        "Plan status: plan-ready\n\nSummary\n\n- Missing links.",
      ),
    ).toBeNull();
  });

  it("returns null when backtick-wrapped metadata collapses to an empty value", () => {
    expect(
      parsePlanReadyCommentMetadata(`Plan status: plan-ready

Plan path: \`
Branch: \`symphony/53\`
Plan URL: https://github.com/sociotechnica-org/symphony-ts/blob/symphony/53/docs/plans/053-plan-review-branch-recoverability/plan.md
Branch URL: https://github.com/sociotechnica-org/symphony-ts/tree/symphony/53
Compare URL: https://github.com/sociotechnica-org/symphony-ts/compare/main...symphony/53`),
    ).toBeNull();
  });

  it("derives GitHub review links from repo, branch, and plan path", () => {
    expect(
      buildPlanReadyCommentMetadata({
        repo: "sociotechnica-org/symphony-ts",
        planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
        branchName: "symphony/53",
      }),
    ).toEqual({
      planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchName: "symphony/53",
      planUrl:
        "https://github.com/sociotechnica-org/symphony-ts/blob/symphony/53/docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchUrl:
        "https://github.com/sociotechnica-org/symphony-ts/tree/symphony/53",
      compareUrl:
        "https://github.com/sociotechnica-org/symphony-ts/compare/main...symphony/53",
    });
  });

  it("URL-encodes branch and plan path segments in GitHub links", () => {
    expect(
      buildPlanReadyCommentMetadata({
        repo: "sociotechnica-org/symphony-ts",
        planPath: "docs/plans/053 weird?/plan#.md",
        branchName: "feature/review#53?draft",
        baseBranch: "release/1.0%",
      }),
    ).toEqual({
      planPath: "docs/plans/053 weird?/plan#.md",
      branchName: "feature/review#53?draft",
      planUrl:
        "https://github.com/sociotechnica-org/symphony-ts/blob/feature/review%2353%3Fdraft/docs/plans/053%20weird%3F/plan%23.md",
      branchUrl:
        "https://github.com/sociotechnica-org/symphony-ts/tree/feature/review%2353%3Fdraft",
      compareUrl:
        "https://github.com/sociotechnica-org/symphony-ts/compare/release/1.0%25...feature/review%2353%3Fdraft",
    });
  });

  it("parses metadata labels literally even when they contain regex metacharacters", () => {
    const body = [
      "Plan status: plan-ready",
      "",
      "Plan path: `docs/plans/053-plan-review-branch-recoverability/plan.md`",
      "Branch: `symphony/53`",
      "Plan URL: https://example.test/plan",
      "Branch URL: https://example.test/branch",
      "Compare URL: https://example.test/compare",
      "",
      "Plan URL?: https://example.test/not-the-plan-url",
    ].join("\n");

    expect(parsePlanReadyCommentMetadata(body)).toEqual({
      planPath: "docs/plans/053-plan-review-branch-recoverability/plan.md",
      branchName: "symphony/53",
      planUrl: "https://example.test/plan",
      branchUrl: "https://example.test/branch",
      compareUrl: "https://example.test/compare",
    });
  });

  it("formats configured markers, labels, and reply guidance", () => {
    const body = formatPlanReadyComment({
      repo: "sociotechnica-org/symphony-ts",
      planPath: "docs/plans/316-configurable-plan-review-protocol/plan.md",
      branchName: "symphony/316",
      summaryLines: ["Ready for configured review."],
      protocol: customProtocol,
    });

    expect(body).toContain(customProtocol.planReadySignal);
    expect(body).toContain(
      "Plan file: `docs/plans/316-configurable-plan-review-protocol/plan.md`",
    );
    expect(body).toContain("Issue branch: `symphony/316`");
    expect(body).toContain(customProtocol.approvedSignal);
    expect(body).toContain(customProtocol.changesRequestedSignal);
    expect(body).toContain(customProtocol.waivedSignal);
    expect(body).toContain(customProtocol.reviewReplyGuidance);
  });

  it("parses configured metadata labels when the matching protocol is provided", () => {
    const body = formatPlanReadyComment({
      repo: "sociotechnica-org/symphony-ts",
      planPath: "docs/plans/316-configurable-plan-review-protocol/plan.md",
      branchName: "symphony/316",
      summaryLines: ["Ready for configured review."],
      protocol: customProtocol,
    });

    expect(parsePlanReadyCommentMetadata(body)).toBeNull();
    expect(parsePlanReadyCommentMetadata(body, customProtocol)).toEqual({
      planPath: "docs/plans/316-configurable-plan-review-protocol/plan.md",
      branchName: "symphony/316",
      planUrl:
        "https://github.com/sociotechnica-org/symphony-ts/blob/symphony/316/docs/plans/316-configurable-plan-review-protocol/plan.md",
      branchUrl:
        "https://github.com/sociotechnica-org/symphony-ts/tree/symphony/316",
      compareUrl:
        "https://github.com/sociotechnica-org/symphony-ts/compare/main...symphony/316",
    });
  });
});
