import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import { CodexIssueReportEnricher } from "../../src/runner/codex-report-enricher.js";
import { createTempDir } from "../support/git.js";
import {
  deriveCodexSessionsRoot,
  deriveWorkspaceRoot,
  seedFailedIssueArtifacts,
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

  it("writes optional Codex-enriched token usage when a matching JSONL log is available", async () => {
    const tempDir = await createTempDir("symphony-report-cli-codex-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: path.join(workspaceRoot, "issue-44"),
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-issue-44.jsonl",
      totalTokens: 3210,
      finalSummary: "- Enriched the report from a matched Codex JSONL session.",
    });

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
      {
        issueEnrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
      },
    );

    const reportDir = path.join(tempDir, ".var", "reports", "issues", "44");
    const reportJson = await fs.readFile(
      path.join(reportDir, "report.json"),
      "utf8",
    );
    const reportMd = await fs.readFile(
      path.join(reportDir, "report.md"),
      "utf8",
    );
    expect(reportJson).toContain('"status": "complete"');
    expect(reportJson).toContain('"totalTokens": 3210');
    expect(reportJson).toContain("matched Codex JSONL session");
    expect(reportMd).toContain("Status: complete");
    expect(reportMd).toContain("Final summary:");
  });

  it("generates a partial report when session artifacts still anchor the issue", async () => {
    const tempDir = await createTempDir("symphony-report-cli-partial-");
    tempRoots.push(tempDir);
    const workflowPath = await writeReportWorkflow(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);

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

  it("derives the workspace root for report generation without requiring a linear API key", async () => {
    const tempDir = await createTempDir("symphony-report-cli-linear-");
    tempRoots.push(tempDir);
    const workflowPath = path.join(tempDir, "WORKFLOW.md");
    const previousApiKey = process.env.LINEAR_API_KEY;
    const workspaceRoot = deriveWorkspaceRoot(tempDir);

    try {
      delete process.env.LINEAR_API_KEY;
      await fs.writeFile(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: symphony-linear
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 2
    backoff_ms: 0
workspace:
  root: ./.tmp/workspaces
  repo_url: /tmp/repo.git
  branch_prefix: symphony/
  cleanup_on_success: false
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}
---
Prompt body
`,
        "utf8",
      );
      await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

      await expect(
        runReportCli(
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
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = previousApiKey;
      }
    }

    await expect(
      fs.readFile(
        path.join(tempDir, ".var", "reports", "issues", "44", "report.json"),
        "utf8",
      ),
    ).resolves.toContain('"githubActivity"');
  });
});
