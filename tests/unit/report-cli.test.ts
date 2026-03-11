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

  it("parses the publish command", () => {
    expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "publish",
        "--issue",
        "44",
        "--archive-root",
        "../factory-runs",
      ]),
    ).toMatchObject({
      command: "publish",
      issueNumber: 44,
    });
  });

  it("requires a valid issue number", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "abc"]),
    ).toThrowError("Invalid issue number: abc");
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "44x"]),
    ).toThrowError("Invalid issue number: 44x");
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "0"]),
    ).toThrowError("Invalid issue number: 0");
  });

  it("requires the issue flag", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "issue"]),
    ).toThrowError("Missing required --issue <number> option");
  });

  it("shows usage for unknown commands", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "status"]),
    ).toThrowError(
      "Usage: symphony-report <issue|publish> --issue <number> [--workflow <path>] [--archive-root <path>]",
    );
  });

  it("requires the archive root for publish", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "publish", "--issue", "44"]),
    ).toThrowError("Missing required --archive-root <path> option");
  });
});
