import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import { createTempDir } from "../support/git.js";
import {
  deriveWorkspaceRoot,
  seedFailedIssueArtifacts,
  seedSessionAnchoredPartialArtifacts,
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("report CLI", () => {
  it("writes report.json and report.md for a completed issue", async () => {
    const tempDir = await createTempDir("symphony-report-cli-complete-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await runReportCli([
      "node",
      "symphony-report",
      "issue",
      "--issue",
      "44",
      "--workflow",
      workflowPath,
    ]);

    const reportDir = path.join(tempDir, ".var", "reports", "issues", "44");
    await expect(
      fs.readFile(path.join(reportDir, "report.json"), "utf8"),
    ).resolves.toContain('"githubActivity"');
    await expect(
      fs.readFile(path.join(reportDir, "report.md"), "utf8"),
    ).resolves.toContain("## Learnings");
    expect(stdout.join("")).toContain("Generated issue report for #44");
  });

  it("renders a failed issue report with explicit token unavailability", async () => {
    const tempDir = await createTempDir("symphony-report-cli-failed-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedFailedIssueArtifacts(workspaceRoot, 44);

    await runReportCli([
      "node",
      "symphony-report",
      "issue",
      "--issue",
      "44",
      "--workflow",
      workflowPath,
    ]);

    const reportDir = path.join(tempDir, ".var", "reports", "issues", "44");
    const reportJson = await fs.readFile(
      path.join(reportDir, "report.json"),
      "utf8",
    );
    const reportMd = await fs.readFile(
      path.join(reportDir, "report.md"),
      "utf8",
    );
    expect(reportJson).toContain('"status": "unavailable"');
    expect(reportJson).toContain('"outcome": "failed"');
    expect(reportMd).toContain("## Token Usage");
    expect(reportMd).toContain("Status: unavailable");
  });

  it("generates a partial report when session artifacts still anchor the issue", async () => {
    const tempDir = await createTempDir("symphony-report-cli-partial-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);

    await runReportCli([
      "node",
      "symphony-report",
      "issue",
      "--issue",
      "44",
      "--workflow",
      workflowPath,
    ]);

    const reportDir = path.join(tempDir, ".var", "reports", "issues", "44");
    const reportMd = await fs.readFile(
      path.join(reportDir, "report.md"),
      "utf8",
    );
    expect(reportMd).toContain("## Summary");
    expect(reportMd).toContain("## Timeline");
    expect(reportMd).toContain("## GitHub Activity");
    expect(reportMd).toContain("## Token Usage");
    expect(reportMd).toContain("## Learnings");
    expect(reportMd).toContain("Unavailable");
  });

  it("fails clearly when the requested issue has no local artifacts", async () => {
    const tempDir = await createTempDir("symphony-report-cli-missing-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "issue",
        "--issue",
        "44",
        "--workflow",
        workflowPath,
      ]),
    ).rejects.toThrowError(
      `No local issue artifacts found for issue #44 at ${path.join(tempDir, ".var", "factory", "issues", "44")}`,
    );
  });
});
