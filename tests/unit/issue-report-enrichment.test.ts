import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { generateIssueReport } from "../../src/observability/issue-report.js";
import { CodexIssueReportEnricher } from "../../src/runner/codex-report-enricher.js";
import { createTempDir } from "../support/git.js";
import {
  deriveCodexSessionsRoot,
  deriveWorkspaceRoot,
  seedLateUnfinishedSessionArtifacts,
  seedSuccessfulIssueArtifacts,
  writeCodexSessionLog,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("issue report enrichment", () => {
  it("merges matched Codex JSONL token usage and final summary into the report", async () => {
    const tempDir = await createTempDir("symphony-issue-report-enriched-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const logPath = await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-issue-44.jsonl",
      inputTokens: 2000,
      cachedInputTokens: 500,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 2750,
      finalSummary:
        "- Added optional runner-log enrichment and preserved provider-neutral report output.",
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:00:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("complete");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.explanation).toContain(
      "token totals for all 1 session(s)",
    );
    expect(generated.report.tokenUsage.sessions).toEqual([
      expect.objectContaining({
        sessionId: "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
        status: "complete",
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 2750,
        originator: "codex_cli_rs",
        sessionSource: "cli",
        cliVersion: "0.71.0",
        modelProvider: "openai",
        gitBranch: "symphony/44",
        gitCommit: "abc123def456",
        finalSummary:
          "- Added optional runner-log enrichment and preserved provider-neutral report output.",
      }),
    ]);
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      logPath,
    );
    expect(generated.markdown).toContain("Final summary:");
    expect(generated.markdown).toContain("Token detail:");
  });

  it("keeps report generation successful when multiple Codex logs match the same session", async () => {
    const tempDir = await createTempDir("symphony-issue-report-ambiguous-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-a.jsonl",
    });
    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:06:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-06-00-b.jsonl",
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:05:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("unavailable");
    expect(generated.report.tokenUsage.sessions[0]?.totalTokens).toBeNull();
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "Multiple runner log files matched this session, so enrichment was skipped to avoid guessing.",
    );
  });

  it("keeps report generation successful when a matching-window Codex log is malformed", async () => {
    const tempDir = await createTempDir("symphony-issue-report-malformed-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-malformed.jsonl",
      malformed: true,
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:10:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("unavailable");
    expect(generated.report.tokenUsage.sessions[0]?.totalTokens).toBeNull();
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "A runner log file in the matching time window could not be parsed, so enrichment was skipped.",
    );
  });

  it("finds a matching Codex log in the next UTC day when the canonical session has no finish time", async () => {
    const tempDir = await createTempDir("symphony-issue-report-next-day-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedLateUnfinishedSessionArtifacts(workspaceRoot, 44);

    const logPath = await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-10T01:30:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-10T01-30-00-next-day.jsonl",
      totalTokens: 1440,
      finalSummary:
        "- Continued the late-night Codex session into the next UTC day.",
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-10T02:00:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("complete");
    expect(generated.report.tokenUsage.totalTokens).toBe(1440);
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      logPath,
    );
    expect(generated.report.tokenUsage.sessions[0]?.finalSummary).toBe(
      "- Continued the late-night Codex session into the next UTC day.",
    );
  });
});
