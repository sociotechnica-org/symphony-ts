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

  it("parses the campaign command for an explicit issue list", () => {
    expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--issues",
        "44,32,43",
      ]),
    ).toEqual({
      command: "campaign",
      workflowPath: expect.stringContaining("WORKFLOW.md"),
      selection: {
        kind: "issues",
        issueNumbers: [32, 43, 44],
      },
    });
  });

  it("parses the campaign command for a date window", () => {
    expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--from",
        "2026-03-01",
        "--to",
        "2026-03-07",
      ]),
    ).toEqual({
      command: "campaign",
      workflowPath: expect.stringContaining("WORKFLOW.md"),
      selection: {
        kind: "date-window",
        from: "2026-03-01",
        to: "2026-03-07",
      },
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
      "Usage: symphony-report <issue|publish|campaign> [--issue <number>] [--issues <a,b,c> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--workflow <path>] [--archive-root <path>]",
    );
  });

  it("requires the archive root for publish", () => {
    expect(() =>
      parseReportArgs(["node", "symphony-report", "publish", "--issue", "44"]),
    ).toThrowError("Missing required --archive-root <path> option");
  });

  it("rejects invalid campaign selection combinations", () => {
    expect(() =>
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--issues",
        "44,45",
        "--from",
        "2026-03-01",
        "--to",
        "2026-03-07",
      ]),
    ).toThrowError(
      "Campaign selection must use either --issues or --from/--to, not both",
    );
    expect(() =>
      parseReportArgs(["node", "symphony-report", "campaign"]),
    ).toThrowError(
      "Campaign generation requires either --issues <a,b,c> or --from <YYYY-MM-DD> --to <YYYY-MM-DD>",
    );
    expect(() =>
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--from",
        "2026-03-07",
      ]),
    ).toThrowError(
      "Campaign date-window selection requires both --from and --to",
    );
  });
});
