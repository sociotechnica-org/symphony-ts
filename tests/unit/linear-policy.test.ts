import { describe, expect, it } from "vitest";
import { extractIssueNumberFromBranchName } from "../../src/tracker/linear-policy.js";

describe("extractIssueNumberFromBranchName", () => {
  it("reads issue numbers from the standard symphony branch format", () => {
    expect(extractIssueNumberFromBranchName("symphony/70")).toBe(70);
  });

  it("reads issue numbers when the branch leaf carries a slug suffix", () => {
    expect(
      extractIssueNumberFromBranchName("symphony/70-linear-mocked-integration"),
    ).toBe(70);
  });

  it("returns null when the branch leaf does not start with an issue number", () => {
    expect(extractIssueNumberFromBranchName("symphony/linear-70")).toBeNull();
  });
});
