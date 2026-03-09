import { describe, expect, it } from "vitest";
import { parseReportArgs } from "../../src/cli/report.js";

describe("parseReportArgs", () => {
  it("parses the issue report command", () => {
    expect(
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "44"]),
    ).toMatchObject({
      command: "issue",
      issueNumber: 44,
    });
  });

  it("requires a valid issue number", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "abc"]),
    ).toThrowError("Invalid issue number: abc");
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "0"]),
    ).toThrowError("Invalid issue number: 0");
  });

  it("shows usage for unknown commands", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "status"]),
    ).toThrowError(
      "Usage: symphony-report issue --issue <number> [--workflow <path>]",
    );
  });
});
