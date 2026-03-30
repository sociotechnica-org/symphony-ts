import { describe, expect, it } from "vitest";
import { evaluateReadyPromotion } from "../../src/tracker/ready-promotion-policy.js";

describe("ready promotion policy", () => {
  const configuration = {
    releaseId: "context-library-bun-migration",
    dependencies: [
      {
        prerequisite: {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
        },
        downstream: [
          {
            issueNumber: 112,
            issueIdentifier: "sociotechnica-org/symphony-ts#112",
            title: "Downstream",
          },
        ],
      },
    ],
  } as const;

  it("adds ready only for downstream issues whose prerequisites succeeded", () => {
    const decision = evaluateReadyPromotion({
      configuration,
      issueFacts: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "succeeded",
        },
      ],
      trackerIssues: [
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          state: "open",
          hasReadyLabel: false,
        },
      ],
    });

    expect(decision.state).toBe("eligible-set-computed");
    expect(decision.eligibleIssues.map((issue) => issue.issueNumber)).toEqual([
      112,
    ]);
    expect(decision.addReadyLabelTo.map((issue) => issue.issueNumber)).toEqual([
      112,
    ]);
    expect(decision.removeReadyLabelFrom).toEqual([]);
  });

  it("removes ready when a prerequisite has failed", () => {
    const decision = evaluateReadyPromotion({
      configuration,
      issueFacts: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "failed",
        },
      ],
      trackerIssues: [
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          state: "open",
          hasReadyLabel: true,
        },
      ],
    });

    expect(decision.state).toBe("eligible-set-computed");
    expect(decision.eligibleIssues).toEqual([]);
    expect(decision.addReadyLabelTo).toEqual([]);
    expect(
      decision.removeReadyLabelFrom.map((issue) => issue.issueNumber),
    ).toEqual([112]);
  });

  it("fails closed when a prerequisite issue fact is missing", () => {
    const decision = evaluateReadyPromotion({
      configuration,
      issueFacts: [],
      trackerIssues: [
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          state: "open",
          hasReadyLabel: false,
        },
      ],
    });

    expect(decision.state).toBe("blocked-review-needed");
    expect(
      decision.unresolvedReferences.map((issue) => issue.issueNumber),
    ).toEqual([111]);
  });

  it("excludes already-observed downstream issues from new ready promotion", () => {
    const decision = evaluateReadyPromotion({
      configuration,
      issueFacts: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "succeeded",
        },
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          currentOutcome: "awaiting-human-review",
        },
      ],
      trackerIssues: [
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          state: "open",
          hasReadyLabel: true,
        },
      ],
    });

    expect(decision.state).toBe("eligible-set-computed");
    expect(decision.eligibleIssues).toEqual([]);
    expect(
      decision.removeReadyLabelFrom.map((issue) => issue.issueNumber),
    ).toEqual([112]);
  });
});
