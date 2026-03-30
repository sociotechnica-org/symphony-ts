import { describe, expect, it } from "vitest";
import { parseReportArgs } from "../../src/cli/report.js";

describe("parseReportArgs", () => {
  it("parses the issue report command", async () => {
    await expect(
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "44"]),
    ).resolves.toMatchObject({
      command: "issue",
      issueNumber: 44,
    });
  });

  it("parses the publish command", async () => {
    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "publish",
        "--issue",
        "44",
        "--archive-root",
        "../factory-runs",
      ]),
    ).resolves.toMatchObject({
      command: "publish",
      issueNumber: 44,
    });
  });

  it("parses the campaign command for an explicit issue list", async () => {
    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--issues",
        "44,32,43",
      ]),
    ).resolves.toEqual({
      command: "campaign",
      workflowPath: expect.stringContaining("WORKFLOW.md"),
      selection: {
        kind: "issues",
        issueNumbers: [32, 43, 44],
      },
    });
  });

  it("parses the campaign command for a date window", async () => {
    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--from",
        "2026-03-01",
        "--to",
        "2026-03-07",
      ]),
    ).resolves.toEqual({
      command: "campaign",
      workflowPath: expect.stringContaining("WORKFLOW.md"),
      selection: {
        kind: "date-window",
        from: "2026-03-01",
        to: "2026-03-07",
      },
    });
  });

  it("parses report-review commands", async () => {
    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "review-pending",
        "--operator-repo-root",
        "../operator",
        "--json",
      ]),
    ).resolves.toMatchObject({
      command: "review-pending",
      output: "json",
    });

    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "review-record",
        "--issue",
        "44",
        "--status",
        "reviewed-no-follow-up",
        "--summary",
        "No action needed.",
      ]),
    ).resolves.toMatchObject({
      command: "review-record",
      issueNumber: 44,
      status: "reviewed-no-follow-up",
    });
  });

  it("requires a valid issue number", async () => {
    await expect(
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "abc"]),
    ).rejects.toThrowError("Invalid issue number: abc");
    await expect(
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "44x"]),
    ).rejects.toThrowError("Invalid issue number: 44x");
    await expect(
      parseReportArgs(["node", "symphony-report", "issue", "--issue", "0"]),
    ).rejects.toThrowError("Invalid issue number: 0");
  });

  it("requires the issue flag", async () => {
    await expect(
      parseReportArgs(["node", "symphony-report", "issue"]),
    ).rejects.toThrowError("Missing required --issue <number> option");
  });

  it("shows usage for unknown commands", async () => {
    await expect(
      parseReportArgs(["node", "symphony-report", "status"]),
    ).rejects.toThrowError(
      "Usage: symphony-report <issue|publish|campaign|review-pending|review-record|review-follow-up> [--issue <number>] [--issues <a,b,c> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--workflow <path>] [--archive-root <path>] [--operator-repo-root <path>] [--json]",
    );
  });

  it("requires the archive root for publish", async () => {
    await expect(
      parseReportArgs(["node", "symphony-report", "publish", "--issue", "44"]),
    ).rejects.toThrowError("Missing required --archive-root option");
  });

  it("rejects invalid campaign selection combinations", async () => {
    await expect(
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
    ).rejects.toThrowError(
      "Campaign selection must use either --issues or --from/--to, not both",
    );
    await expect(
      parseReportArgs(["node", "symphony-report", "campaign"]),
    ).rejects.toThrowError(
      "Campaign generation requires either --issues <a,b,c> or --from <YYYY-MM-DD> --to <YYYY-MM-DD>",
    );
    await expect(
      parseReportArgs([
        "node",
        "symphony-report",
        "campaign",
        "--from",
        "2026-03-07",
      ]),
    ).rejects.toThrowError(
      "Campaign date-window selection requires both --from and --to",
    );
  });
});
