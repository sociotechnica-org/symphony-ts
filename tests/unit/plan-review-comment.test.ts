import { describe, expect, it } from "vitest";
import {
  buildPlanReadyCommentMetadata,
  formatPlanReadyComment,
  parsePlanReadyCommentMetadata,
} from "../../src/tracker/plan-review-comment.js";

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
});
