import { describe, expect, it } from "vitest";
import { applyIssueReportProviderPricing } from "../../src/observability/issue-report-pricing.js";
import type {
  IssueReportDocument,
  IssueReportTokenUsageSession,
} from "../../src/observability/issue-report.js";
import { ISSUE_REPORT_SCHEMA_VERSION } from "../../src/observability/issue-report.js";

describe("issue report provider pricing", () => {
  it("estimates supported OpenAI-backed Codex session cost from stored token facts", () => {
    const report = buildIssueReport([
      buildSession({
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4",
        modelProvider: "openai",
        status: "partial",
        inputTokens: 2_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 250_000,
        totalTokens: 2_250_000,
      }),
    ]);

    const priced = applyIssueReportProviderPricing(report);

    expect(priced.tokenUsage.status).toBe("estimated");
    expect(priced.tokenUsage.costUsd).toBeCloseTo(7.625, 6);
    expect(priced.tokenUsage.observedCostSubtotal).toBeNull();
    expect(priced.tokenUsage.explanation).toContain(
      "1 session(s) used checked-in provider pricing estimates",
    );
    expect(priced.tokenUsage.sessions[0]).toEqual(
      expect.objectContaining({
        status: "estimated",
        costUsd: 7.625,
      }),
    );
    expect(priced.tokenUsage.sessions[0]?.notes).toContain(
      "Cost estimated from checked-in openai pricing for gpt-5.4.",
    );
  });

  it("preserves explicit backend cost subtotals when a report mixes observed and estimated sessions", () => {
    const report = buildIssueReport([
      buildSession({
        sessionId: "observed",
        status: "complete",
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        costUsd: 1.5,
      }),
      buildSession({
        sessionId: "estimated",
        provider: "codex",
        model: "gpt-5.4",
        modelProvider: "openai",
        status: "partial",
        inputTokens: 2_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 250_000,
        totalTokens: 2_250_000,
      }),
    ]);

    const priced = applyIssueReportProviderPricing(report);

    expect(priced.tokenUsage.status).toBe("estimated");
    expect(priced.tokenUsage.costUsd).toBeCloseTo(9.125, 6);
    expect(priced.tokenUsage.observedCostSubtotal).toBe(1.5);
    expect(priced.tokenUsage.notes).toContain(
      "1 session(s) still supplied explicit backend cost facts; observed cost subtotal preserves only those explicit facts.",
    );
    expect(priced.tokenUsage.attempts[0]).toEqual(
      expect.objectContaining({
        costUsd: 9.125,
      }),
    );
  });

  it("keeps unsupported provider/model pricing explicit instead of guessing", () => {
    const report = buildIssueReport([
      buildSession({
        sessionId: "unsupported",
        provider: "codex",
        model: "gpt-5.99",
        modelProvider: "openai",
        status: "partial",
        inputTokens: 2_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 250_000,
        totalTokens: 2_250_000,
      }),
    ]);

    const priced = applyIssueReportProviderPricing(report);

    expect(priced.tokenUsage.status).toBe("partial");
    expect(priced.tokenUsage.costUsd).toBeNull();
    expect(priced.tokenUsage.notes).toContain(
      "Provider pricing still could not price 1 of 1 recorded session(s). See session notes for the remaining gaps.",
    );
    expect(priced.tokenUsage.sessions[0]?.notes).toContain(
      "Checked-in provider pricing does not yet support codex (gpt-5.99).",
    );
  });
});

function buildIssueReport(
  sessions: readonly IssueReportTokenUsageSession[],
): IssueReportDocument {
  return {
    version: ISSUE_REPORT_SCHEMA_VERSION,
    generatedAt: "2026-03-31T12:00:00.000Z",
    summary: {
      status: "complete",
      issueNumber: 289,
      issueIdentifier: "sociotechnica-org/symphony-ts#289",
      repo: "sociotechnica-org/symphony-ts",
      title: "Apply provider pricing",
      issueUrl: "https://example.test/issues/289",
      branch: "symphony/289",
      outcome: "succeeded",
      startedAt: "2026-03-31T10:00:00.000Z",
      endedAt: "2026-03-31T11:00:00.000Z",
      attemptCount: 1,
      pullRequestCount: 1,
      overallConclusion: "Completed successfully.",
      notes: [],
    },
    timeline: [],
    githubActivity: {
      status: "complete",
      issueStateTransitionsStatus: "unavailable",
      issueStateTransitionsNote: "Unavailable.",
      issueTransitions: [],
      pullRequests: [],
      reviewFeedbackRounds: 0,
      reviewLoopSummary: "Unavailable.",
      mergeTimingRelevant: false,
      mergedAt: null,
      mergeNote: "Unavailable.",
      closeTimingRelevant: false,
      closedAt: null,
      closeNote: "Unavailable.",
      notes: [],
    },
    tokenUsage: {
      status: sessions.every((session) => session.status === "complete")
        ? "complete"
        : "partial",
      explanation: "Synthetic token usage for pricing tests.",
      totalTokens: sessions.reduce(
        (sum, session) => sum + (session.totalTokens ?? 0),
        0,
      ),
      costUsd: sessions.every((session) => session.costUsd !== null)
        ? sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0)
        : null,
      observedTokenSubtotal: sessions.reduce(
        (sum, session) => sum + (session.totalTokens ?? 0),
        0,
      ),
      observedCostSubtotal: sessions.some((session) => session.costUsd !== null)
        ? sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0)
        : null,
      sessions,
      attempts: [
        {
          attemptNumber: 1,
          sessionIds: sessions.map((session) => session.sessionId),
          totalTokens: sessions.every((session) => session.totalTokens !== null)
            ? sessions.reduce(
                (sum, session) => sum + (session.totalTokens ?? 0),
                0,
              )
            : null,
          costUsd: sessions.every((session) => session.costUsd !== null)
            ? sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0)
            : null,
        },
      ],
      agents: [],
      rawArtifacts: [],
      notes: [],
    },
    learnings: {
      status: "complete",
      observations: [],
      gaps: [],
    },
    artifacts: {
      rawIssueRoot: "/tmp/issues/289",
      issueFile: "/tmp/issues/289/issue.json",
      eventsFile: "/tmp/issues/289/events.jsonl",
      attemptFiles: [],
      sessionFiles: [],
      logPointersFile: null,
      missingArtifacts: [],
      generatedReportJson: "/tmp/reports/issues/289/report.json",
      generatedReportMarkdown: "/tmp/reports/issues/289/report.md",
    },
    operatorInterventions: {
      status: "complete",
      summary: "None.",
      entries: [],
      note: "None.",
    },
  };
}

function buildSession(
  options: Partial<IssueReportTokenUsageSession> & {
    readonly sessionId: string;
  },
): IssueReportTokenUsageSession {
  return {
    sessionId: options.sessionId,
    attemptNumber: options.attemptNumber ?? 1,
    provider: options.provider ?? "codex",
    model: options.model ?? "gpt-5.4",
    status: options.status ?? "partial",
    inputTokens: options.inputTokens ?? null,
    cachedInputTokens: options.cachedInputTokens ?? null,
    outputTokens: options.outputTokens ?? null,
    reasoningOutputTokens: options.reasoningOutputTokens ?? null,
    totalTokens: options.totalTokens ?? null,
    costUsd: options.costUsd ?? null,
    originator: options.originator ?? null,
    sessionSource: options.sessionSource ?? null,
    cliVersion: options.cliVersion ?? null,
    modelProvider: options.modelProvider ?? null,
    gitBranch: options.gitBranch ?? null,
    gitCommit: options.gitCommit ?? null,
    finalSummary: options.finalSummary ?? null,
    notes: options.notes ?? [],
    sourceArtifacts: options.sourceArtifacts ?? [],
  };
}
