import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  deriveIssueArtifactPaths,
} from "../../src/observability/issue-artifacts.js";
import type { IssueArtifactSessionSnapshot } from "../../src/observability/issue-artifacts.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import type {
  IssueReportDocument,
  LoadedIssueArtifacts,
} from "../../src/observability/issue-report.js";
import { generateIssueReport } from "../../src/observability/issue-report.js";
import { mergeIssueReportEnrichment } from "../../src/observability/issue-report-enrichment.js";
import { asFiniteNumber } from "../../src/domain/number-coerce.js";
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
      finalSummary: [
        "- Added optional runner-log enrichment.",
        "- Preserved provider-neutral report output.",
      ].join("\n"),
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:00:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.explanation).toContain(
      "used checked-in provider pricing estimates",
    );
    expect(generated.report.tokenUsage.costUsd).toBeCloseTo(0.007625, 6);
    expect(generated.report.tokenUsage.sessions).toEqual([
      expect.objectContaining({
        sessionId: "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
        status: "estimated",
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 2750,
        costUsd: 0.007625,
        originator: "codex_cli_rs",
        sessionSource: "cli",
        cliVersion: "0.71.0",
        modelProvider: "openai",
        gitBranch: "symphony/44",
        gitCommit: "abc123def456",
        finalSummary: [
          "- Added optional runner-log enrichment.",
          "- Preserved provider-neutral report output.",
        ].join("\n"),
      }),
    ]);
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "Cost estimated from checked-in openai pricing for gpt-5.4.",
    );
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      logPath,
    );
    expect(generated.markdown).toContain("Final summary:");
    expect(generated.markdown).toContain(
      "    - Added optional runner-log enrichment.",
    );
    expect(generated.markdown).toContain(
      "    - Preserved provider-neutral report output.",
    );
    expect(generated.markdown).toContain("Token detail:");
  });

  it("uses the latest cumulative Codex token_count snapshot when a log records multiple events", async () => {
    const tempDir = await createTempDir("symphony-issue-report-multi-token-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-multi-token.jsonl",
      tokenEvents: [
        {
          inputTokens: 1200,
          cachedInputTokens: 200,
          outputTokens: 150,
          reasoningOutputTokens: 50,
          totalTokens: 1600,
        },
        {
          inputTokens: 2000,
          cachedInputTokens: 500,
          outputTokens: 250,
          reasoningOutputTokens: 100,
          totalTokens: 2750,
        },
      ],
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:00:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.costUsd).toBeCloseTo(0.007625, 6);
    expect(generated.report.tokenUsage.sessions[0]).toEqual(
      expect.objectContaining({
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 2750,
      }),
    );
  });

  it("recomputes observed token subtotals and uses pricing-safe wording when enrichment cannot price a provider", () => {
    const sessionId = "sociotechnica-org/symphony-ts#44/attempt-1/session-1";
    const report: IssueReportDocument = {
      version: 4,
      generatedAt: "2026-03-09T13:00:00.000Z",
      summary: {
        status: "complete",
        issueNumber: 44,
        issueIdentifier: "sociotechnica-org/symphony-ts#44",
        repo: "sociotechnica-org/symphony-ts",
        title: "Generate per-issue reports from local artifacts",
        issueUrl: "https://github.com/sociotechnica-org/symphony-ts/issues/44",
        branch: "symphony/44",
        outcome: "succeeded",
        startedAt: "2026-03-09T10:00:00.000Z",
        endedAt: "2026-03-09T10:20:00.000Z",
        attemptCount: 1,
        pullRequestCount: 1,
        overallConclusion: "Completed successfully.",
        notes: [],
      },
      timeline: [],
      githubActivity: {
        status: "partial",
        issueStateTransitionsStatus: "unavailable",
        issueStateTransitionsNote: "Unavailable.",
        pullRequests: [],
        reviewFeedbackRounds: 0,
        reviewLoopSummary: "Unavailable.",
        mergedAt: null,
        mergeNote: "Unavailable.",
        closedAt: null,
        closeNote: "Unavailable.",
        notes: [],
      },
      tokenUsage: {
        status: "unavailable",
        explanation:
          "Canonical runner-event accounting was unavailable for all recorded sessions.",
        totalTokens: null,
        costUsd: null,
        observedTokenSubtotal: null,
        observedCostSubtotal: null,
        sessions: [
          {
            sessionId,
            attemptNumber: 1,
            provider: "claude-code",
            model: "claude-sonnet-4-5",
            status: "unavailable",
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
            costUsd: null,
            originator: null,
            sessionSource: null,
            cliVersion: null,
            modelProvider: null,
            gitBranch: null,
            gitCommit: null,
            finalSummary: null,
            notes: [],
            sourceArtifacts: ["/tmp/session.json"],
          },
        ],
        attempts: [
          {
            attemptNumber: 1,
            sessionIds: [sessionId],
            totalTokens: null,
            costUsd: null,
          },
        ],
        agents: [
          {
            agent: "claude-code (claude-sonnet-4-5)",
            sessionCount: 1,
            totalTokens: null,
            costUsd: null,
          },
        ],
        rawArtifacts: ["/tmp/session.json"],
        notes: [],
      },
      learnings: {
        status: "complete",
        observations: [],
        gaps: [],
      },
      artifacts: {
        rawIssueRoot: "/tmp/issues/44",
        issueFile: "/tmp/issues/44/issue.json",
        eventsFile: "/tmp/issues/44/events.jsonl",
        attemptFiles: [],
        sessionFiles: [],
        logPointersFile: null,
        missingArtifacts: [],
        generatedReportJson: "/tmp/report.json",
        generatedReportMarkdown: "/tmp/report.md",
      },
      operatorInterventions: {
        status: "complete",
        summary: "None.",
        entries: [],
        note: "None.",
      },
    };

    const enriched = mergeIssueReportEnrichment(report, {
      sessions: [
        {
          sessionId,
          tokenUsage: {
            inputTokens: 1200,
            outputTokens: 300,
            totalTokens: 1500,
          },
        },
      ],
    });

    expect(enriched.tokenUsage.observedTokenSubtotal).toBe(1500);
    expect(enriched.tokenUsage.observedCostSubtotal).toBeNull();
    expect(enriched.tokenUsage.explanation).toContain(
      "Final report generation estimates cost only for supported providers/models",
    );
    expect(enriched.tokenUsage.explanation).not.toContain(
      "does not apply provider pricing",
    );
  });

  it("treats NaN as unavailable in Codex numeric coercion", () => {
    expect(asFiniteNumber(Number.NaN)).toBeNull();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber(2750)).toBe(2750);
    expect(asFiniteNumber(null)).toBeNull();
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

  it("preserves canonical cost availability when enrichment fills missing token totals", async () => {
    const tempDir = await createTempDir("symphony-issue-report-cost-kept-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      accounting: {
        status: "partial",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: 1.25,
      },
    });

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-cost-kept.jsonl",
      inputTokens: 2000,
      cachedInputTokens: 500,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 2750,
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:06:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("complete");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.costUsd).toBe(1.25);
    expect(generated.report.tokenUsage.explanation).toContain(
      "already supplied cost totals for all 1 session(s)",
    );
    expect(generated.report.tokenUsage.explanation).not.toContain(
      "Estimated cost remains unavailable",
    );
  });

  it("disambiguates multiple matching Codex logs by canonical backend session identity", async () => {
    const tempDir = await createTempDir("symphony-issue-report-backend-id-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      backendSessionId: "thread-44-turn-1",
      backendThreadId: "thread-44",
    });

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-other.jsonl",
      sessionMetaId: "thread-other",
      totalTokens: 900,
    });
    const matchedLogPath = await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:06:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-06-00-thread-44.jsonl",
      sessionMetaId: "thread-44",
      totalTokens: 2750,
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:06:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      matchedLogPath,
    );
    expect(
      generated.report.tokenUsage.sessions[0]?.sourceArtifacts,
    ).not.toContain(expect.stringContaining("other.jsonl"));
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "Runner log enrichment disambiguated multiple Codex logs by matching the canonical backend session identity.",
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

  it("keeps a parse-failure note when one readable Codex log still matches", async () => {
    const tempDir = await createTempDir("symphony-issue-report-partial-parse-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-readable.jsonl",
      totalTokens: 2750,
    });
    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:06:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-06-00-malformed.jsonl",
      malformed: true,
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:10:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "At least one runner log file in the matching time window could not be parsed; enrichment used the only readable match.",
    );
  });

  it("keeps earlier session enrichments when a later session hits a filesystem error", async () => {
    const tempDir = await createTempDir("symphony-issue-report-fs-error-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    const issueNumber = 44;
    const issueRoot = path.join(
      workspaceRoot,
      `issue-${issueNumber.toString()}`,
    );

    const readableSession: IssueArtifactSessionSnapshot = {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 1,
      sessionId: "issue-44-session-1",
      provider: "codex",
      model: "gpt-5.4",
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: "codex-session-44-1",
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: 1,
      startedAt: "2026-03-09T10:05:00.000Z",
      finishedAt: "2026-03-09T10:10:00.000Z",
      workspacePath: issueRoot,
      branch: "symphony/44",
      logPointers: [],
    };
    const failingSession: IssueArtifactSessionSnapshot = {
      ...readableSession,
      sessionId: "issue-44-session-2",
      startedAt: "2026-03-12T11:05:00.000Z",
      finishedAt: "2026-03-12T11:10:00.000Z",
    };
    const loaded: LoadedIssueArtifacts = {
      issueNumber,
      paths: deriveIssueArtifactPaths(workspaceRoot, issueNumber),
      issue: null,
      events: [],
      hasEventsFile: false,
      attempts: [],
      sessions: [readableSession, failingSession],
      logPointers: null,
    };

    const logPath = await writeCodexSessionLog({
      sessionsRoot,
      startedAt: readableSession.startedAt ?? "2026-03-09T10:05:00.000Z",
      workspacePath: issueRoot,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-readable.jsonl",
      totalTokens: 2750,
    });

    const blockedDayRoot = path.join(sessionsRoot, "2026", "03", "12");
    const blockedDayRootResolved = path.resolve(blockedDayRoot);
    const originalReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (filePath, options) => {
        if (path.resolve(String(filePath)) === blockedDayRootResolved) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalReaddir(filePath, options);
      });

    try {
      const enrichment = await new CodexIssueReportEnricher({
        sessionsRoot,
      }).enrich({
        workspaceRoot,
        loaded,
        report: {} as IssueReportDocument,
      });

      expect(enrichment.sessions).toHaveLength(2);
      expect(enrichment.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: readableSession.sessionId,
            tokenUsage: expect.objectContaining({
              totalTokens: 2750,
            }),
            sourceArtifacts: [logPath],
          }),
          expect.objectContaining({
            sessionId: failingSession.sessionId,
            notes: [
              "Runner log enrichment failed for this session and was skipped: permission denied",
            ],
          }),
        ]),
      );
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("does not match a Codex log with no parseable session timestamp", async () => {
    const tempDir = await createTempDir("symphony-issue-report-no-timestamp-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-09T10:05:00.000Z",
      metaTimestamp: null,
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-09T10-05-00-no-timestamp.jsonl",
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:10:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("unavailable");
    expect(generated.report.tokenUsage.sessions[0]?.totalTokens).toBeNull();
    expect(generated.report.tokenUsage.sessions[0]?.notes).toContain(
      "No matching runner log file was found for this session.",
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

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(1440);
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      logPath,
    );
    expect(generated.report.tokenUsage.sessions[0]?.finalSummary).toBe(
      "- Continued the late-night Codex session into the next UTC day.",
    );
  });

  it("finds a next-day Codex log when only the unfinished-session post-window crosses UTC midnight", async () => {
    const tempDir = await createTempDir(
      "symphony-issue-report-next-day-post-window-",
    );
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const sessionsRoot = deriveCodexSessionsRoot(tempDir);
    await seedLateUnfinishedSessionArtifacts(workspaceRoot, 44, {
      startedAt: "2026-03-09T19:45:00.000Z",
    });

    const logPath = await writeCodexSessionLog({
      sessionsRoot,
      startedAt: "2026-03-10T00:05:00.000Z",
      workspacePath: `${workspaceRoot}/issue-44`,
      branch: "symphony/44",
      fileName: "rollout-2026-03-10T00-05-00-post-window.jsonl",
      totalTokens: 900,
      finalSummary:
        "- Crossed midnight during the unfinished-session match margin.",
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-10T00:10:00.000Z",
      enrichers: [new CodexIssueReportEnricher({ sessionsRoot })],
    });

    expect(generated.report.tokenUsage.status).toBe("estimated");
    expect(generated.report.tokenUsage.totalTokens).toBe(900);
    expect(generated.report.tokenUsage.sessions[0]?.sourceArtifacts).toContain(
      logPath,
    );
    expect(generated.report.tokenUsage.sessions[0]?.finalSummary).toBe(
      "- Crossed midnight during the unfinished-session match margin.",
    );
  });
});
