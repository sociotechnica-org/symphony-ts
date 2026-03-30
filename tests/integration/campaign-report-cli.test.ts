import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import { ISSUE_REPORT_SCHEMA_VERSION } from "../../src/observability/issue-report.js";
import { CodexIssueReportEnricher } from "../../src/runner/codex-report-enricher.js";
import { createTempDir } from "../support/git.js";
import {
  deriveCodexSessionsRoot,
  deriveWorkspaceRoot,
  downgradeIssueReportSchemaVersion,
  seedFailedIssueArtifacts,
  seedLateUnfinishedSessionArtifacts,
  seedSessionAnchoredPartialArtifacts,
  seedSuccessfulIssueArtifacts,
  writeCodexSessionLog,
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

describe("campaign report CLI", () => {
  it("generates the campaign digest files for an explicit issue list", async () => {
    const tempDir = await createTempDir("symphony-campaign-cli-issues-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);

    await seedSuccessfulIssueArtifacts(workspaceRoot, 32, {
      claimedAt: "2026-03-02T09:00:00.000Z",
      planReadyAt: "2026-03-02T09:05:00.000Z",
      attemptStartedAt: "2026-03-02T09:10:00.000Z",
      prOpenedAt: "2026-03-02T09:25:00.000Z",
      latestCommitAt: "2026-03-02T09:24:00.000Z",
      succeededAt: "2026-03-02T10:00:00.000Z",
      finalCommitAt: "2026-03-02T09:58:00.000Z",
    });
    await seedFailedIssueArtifacts(workspaceRoot, 43, {
      attemptStartedAt: "2026-03-05T12:00:00.000Z",
      retryScheduledAt: "2026-03-05T12:06:00.000Z",
      failedAt: "2026-03-05T12:20:00.000Z",
    });
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);
    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-02T09:10:00.000Z",
      workspacePath: path.join(workspaceRoot, "issue-32"),
      branch: "symphony/32",
      fileName: "campaign-issue-32.jsonl",
      totalTokens: 3210,
      finalSummary: "- Added campaign digest coverage.",
    });

    const enrichers = [new CodexIssueReportEnricher({ sessionsRoot })];
    for (const issueNumber of [32, 43, 44]) {
      await runReportCli(
        [
          "node",
          "symphony-report",
          "issue",
          "--issue",
          issueNumber.toString(),
          "--workflow",
          workflowPath,
        ],
        { issueEnrichers: enrichers },
      );
    }

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
      "campaign",
      "--issues",
      "32,43,44",
      "--workflow",
      workflowPath,
    ]);

    const campaignDir = path.join(
      tempDir,
      ".var",
      "reports",
      "campaigns",
      "issues-32-43-44",
    );
    await expect(
      fs.readFile(path.join(campaignDir, "summary.md"), "utf8"),
    ).resolves.toContain("Issue count: 3");
    await expect(
      fs.readFile(path.join(campaignDir, "timeline.md"), "utf8"),
    ).resolves.toContain("#43 Generate per-issue reports from local artifacts");
    await expect(
      fs.readFile(path.join(campaignDir, "github-activity.md"), "utf8"),
    ).resolves.toContain("Pull requests observed");
    await expect(
      fs.readFile(path.join(campaignDir, "token-usage.md"), "utf8"),
    ).resolves.toContain("Aggregate status: partial");
    await expect(
      fs.readFile(path.join(campaignDir, "learnings.md"), "utf8"),
    ).resolves.toContain("## Cross-Issue Conclusions");
    expect(stdout.join("")).toContain(
      "Generated campaign digest issues-32-43-44",
    );
  });

  it("selects generated issue reports by date window", async () => {
    const tempDir = await createTempDir("symphony-campaign-cli-window-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);

    await seedSuccessfulIssueArtifacts(workspaceRoot, 32, {
      claimedAt: "2026-03-02T09:00:00.000Z",
      planReadyAt: "2026-03-02T09:05:00.000Z",
      attemptStartedAt: "2026-03-02T09:10:00.000Z",
      prOpenedAt: "2026-03-02T09:25:00.000Z",
      latestCommitAt: "2026-03-02T09:24:00.000Z",
      succeededAt: "2026-03-02T10:00:00.000Z",
      finalCommitAt: "2026-03-02T09:58:00.000Z",
    });
    await seedFailedIssueArtifacts(workspaceRoot, 43, {
      attemptStartedAt: "2026-03-06T12:00:00.000Z",
      retryScheduledAt: "2026-03-06T12:06:00.000Z",
      failedAt: "2026-03-06T12:20:00.000Z",
    });
    await seedLateUnfinishedSessionArtifacts(workspaceRoot, 44, {
      startedAt: "2026-03-09T22:00:00.000Z",
    });

    for (const issueNumber of [32, 43, 44]) {
      await runReportCli(
        [
          "node",
          "symphony-report",
          "issue",
          "--issue",
          issueNumber.toString(),
          "--workflow",
          workflowPath,
        ],
        { issueEnrichers: [] },
      );
    }

    await runReportCli([
      "node",
      "symphony-report",
      "campaign",
      "--from",
      "2026-03-01",
      "--to",
      "2026-03-07",
      "--workflow",
      workflowPath,
    ]);

    const summary = await fs.readFile(
      path.join(
        tempDir,
        ".var",
        "reports",
        "campaigns",
        "window-2026-03-01-to-2026-03-07",
        "summary.md",
      ),
      "utf8",
    );
    expect(summary).toContain("Issue count: 2");
    expect(summary).toContain(
      "#32 Generate per-issue reports from local artifacts",
    );
    expect(summary).toContain(
      "#43 Generate per-issue reports from local artifacts",
    );
    expect(summary).not.toContain(
      "#44 Generate per-issue reports from local artifacts",
    );
  });

  it("fails clearly when a requested issue report is missing", async () => {
    const tempDir = await createTempDir("symphony-campaign-cli-missing-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);

    await seedSuccessfulIssueArtifacts(workspaceRoot, 32);
    await runReportCli(
      [
        "node",
        "symphony-report",
        "issue",
        "--issue",
        "32",
        "--workflow",
        workflowPath,
      ],
      { issueEnrichers: [] },
    );

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "campaign",
        "--issues",
        "32,43",
        "--workflow",
        workflowPath,
      ]),
    ).rejects.toThrowError(
      /No generated issue report JSON found for issue #43/,
    );
  });

  it("fails clearly when a selected issue report uses a stale schema", async () => {
    const tempDir = await createTempDir("symphony-campaign-cli-stale-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);

    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    await runReportCli(
      [
        "node",
        "symphony-report",
        "issue",
        "--issue",
        "44",
        "--workflow",
        workflowPath,
      ],
      { issueEnrichers: [] },
    );
    await downgradeIssueReportSchemaVersion(
      path.join(tempDir, ".var", "reports", "issues", "44", "report.json"),
      ISSUE_REPORT_SCHEMA_VERSION - 1,
    );

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "campaign",
        "--issues",
        "44",
        "--workflow",
        workflowPath,
      ]),
    ).rejects.toThrowError(
      new RegExp(
        `uses schema version ${(ISSUE_REPORT_SCHEMA_VERSION - 1).toString()}`,
      ),
    );
  });

  it("keeps explicit partial-data notes in the generated campaign digest", async () => {
    const tempDir = await createTempDir("symphony-campaign-cli-partial-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);

    await seedSuccessfulIssueArtifacts(workspaceRoot, 32);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);

    for (const issueNumber of [32, 44]) {
      await runReportCli(
        [
          "node",
          "symphony-report",
          "issue",
          "--issue",
          issueNumber.toString(),
          "--workflow",
          workflowPath,
        ],
        { issueEnrichers: [] },
      );
    }

    await runReportCli([
      "node",
      "symphony-report",
      "campaign",
      "--issues",
      "32,44",
      "--workflow",
      workflowPath,
    ]);

    await expect(
      fs.readFile(
        path.join(
          tempDir,
          ".var",
          "reports",
          "campaigns",
          "issues-32-44",
          "timeline.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Partial issue timelines: #44");
    await expect(
      fs.readFile(
        path.join(
          tempDir,
          ".var",
          "reports",
          "campaigns",
          "issues-32-44",
          "learnings.md",
        ),
        "utf8",
      ),
    ).resolves.toContain(
      "Some selected reports were partial, so the campaign digest may undercount lifecycle events.",
    );
  });
});
