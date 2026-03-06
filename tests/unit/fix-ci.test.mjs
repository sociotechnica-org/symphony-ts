import { describe, expect, it } from "vitest";
import { summarizeChecks } from "../../skills/fix-ci/scripts/fix-ci-lib.mjs";

describe("fix-ci skill", () => {
  it("treats incomplete checks as pending", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "IN_PROGRESS",
        conclusion: "",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("pending");
    expect(summary.pending).toHaveLength(1);
  });

  it("treats failing completed checks as failure", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("failure");
    expect(summary.failed).toHaveLength(1);
  });

  it("treats successful completed checks as success", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
      {
        name: "Greptile Review",
        status: "COMPLETED",
        conclusion: "NEUTRAL",
        detailsUrl: "https://example.test/review",
        workflowName: "",
      },
    ]);

    expect(summary.overall).toBe("success");
    expect(summary.failed).toHaveLength(0);
  });
});
