import { describe, expect, it } from "vitest";
import {
  buildCampaignDigest,
  deriveCampaignId,
  matchesCampaignDateWindow,
} from "../../src/observability/campaign-report.js";
import {
  renderCampaignGitHubActivityMarkdown,
  renderCampaignLearningsMarkdown,
  renderCampaignSummaryMarkdown,
  renderCampaignTimelineMarkdown,
  renderCampaignTokenUsageMarkdown,
} from "../../src/observability/campaign-report-markdown.js";
import {
  ISSUE_REPORT_SCHEMA_VERSION,
  type IssueReportDocument,
  type StoredIssueReportDocument,
} from "../../src/observability/issue-report.js";

describe("campaign report", () => {
  it("derives stable campaign ids", () => {
    expect(
      deriveCampaignId({
        kind: "issues",
        issueNumbers: [44, 32, 43, 44],
      }),
    ).toBe("issues-32-43-44");
    expect(
      deriveCampaignId({
        kind: "date-window",
        from: "2026-03-01",
        to: "2026-03-07",
      }),
    ).toBe("window-2026-03-01-to-2026-03-07");
  });

  it("matches date windows using report bounds and generatedAt fallback", () => {
    const bounded = buildStoredIssueReport({
      issueNumber: 32,
      summary: {
        startedAt: "2026-03-03T10:00:00.000Z",
        endedAt: "2026-03-05T18:00:00.000Z",
      },
      generatedAt: "2026-03-06T10:00:00.000Z",
    });
    const generatedOnly = buildStoredIssueReport({
      issueNumber: 43,
      generatedAt: "2026-03-09T12:00:00.000Z",
      summary: {
        startedAt: null,
        endedAt: null,
      },
    });

    expect(
      matchesCampaignDateWindow(bounded.report, {
        kind: "date-window",
        from: "2026-03-01",
        to: "2026-03-04",
      }),
    ).toBe(true);
    expect(
      matchesCampaignDateWindow(generatedOnly.report, {
        kind: "date-window",
        from: "2026-03-01",
        to: "2026-03-07",
      }),
    ).toBe(false);
    expect(
      matchesCampaignDateWindow(generatedOnly.report, {
        kind: "date-window",
        from: "2026-03-09",
        to: "2026-03-09",
      }),
    ).toBe(true);
  });

  it("aggregates mixed issue outcomes, github activity, and token availability", () => {
    const digest = buildCampaignDigest(
      {
        kind: "issues",
        issueNumbers: [44, 32, 43],
      },
      [
        buildStoredIssueReport({
          issueNumber: 32,
          title: "Issue 32",
          summary: {
            outcome: "succeeded",
            attemptCount: 1,
            pullRequestCount: 1,
            overallConclusion: "Completed cleanly.",
          },
          githubActivity: {
            pullRequests: [
              {
                number: 132,
                url: "https://example.test/pr/132",
                attemptNumbers: [1],
                firstObservedAt: "2026-03-03T10:10:00.000Z",
                latestCommitAt: "2026-03-03T11:00:00.000Z",
                reviewFeedbackRounds: 1,
                actionableReviewCount: 1,
                unresolvedThreadCount: 0,
                pendingChecks: ["CI"],
                failingChecks: [],
              },
            ],
            reviewFeedbackRounds: 1,
          },
          tokenUsage: {
            status: "complete",
            totalTokens: 3200,
          },
          learnings: {
            observations: [
              {
                title: "Review loop stayed small",
                summary: "One feedback round was enough.",
                evidence: ["PR #132 cleared after one review round."],
              },
            ],
          },
        }),
        buildStoredIssueReport({
          issueNumber: 43,
          title: "Issue 43",
          summary: {
            outcome: "failed",
            overallConclusion: "Failed after retries were exhausted.",
          },
          githubActivity: {
            reviewFeedbackRounds: 0,
          },
          tokenUsage: {
            status: "unavailable",
          },
        }),
        buildStoredIssueReport({
          issueNumber: 44,
          title: "Issue 44",
          summary: {
            status: "partial",
            outcome: "awaiting-review",
            overallConclusion: "PR opened but local facts remained partial.",
          },
          githubActivity: {
            pullRequests: [
              {
                number: 144,
                url: "https://example.test/pr/144",
                attemptNumbers: [1],
                firstObservedAt: "2026-03-04T14:10:00.000Z",
                latestCommitAt: "2026-03-04T15:00:00.000Z",
                reviewFeedbackRounds: 0,
                actionableReviewCount: 0,
                unresolvedThreadCount: 0,
                pendingChecks: [],
                failingChecks: ["lint"],
              },
            ],
          },
          tokenUsage: {
            status: "estimated",
            totalTokens: 1200,
          },
        }),
      ],
      "2026-03-11T12:00:00.000Z",
    );

    expect(digest.summary.outcomeCounts).toEqual({
      succeeded: 1,
      failed: 1,
      partial: 1,
      unknown: 0,
    });
    expect(digest.summary.overallOutcome).toBe(
      "Completed 1 of 3 selected issues. 1 failed, 1 remained partial.",
    );
    expect(digest.githubActivity.pullRequests).toHaveLength(2);
    expect(digest.githubActivity.pendingChecks).toEqual([
      { name: "CI", count: 1 },
    ]);
    expect(digest.githubActivity.failingChecks).toEqual([
      { name: "lint", count: 1 },
    ]);
    expect(digest.tokenUsage.status).toBe("partial");
    expect(digest.tokenUsage.totalTokens).toBeNull();
    expect(digest.tokenUsage.observedTokenSubtotal).toBe(4400);
    expect(digest.learnings.changesToMake).toContain(
      "Expand token-usage capture or enrichment; campaign token coverage was partial across 3 issue reports.",
    );
  });

  it("treats aggregate review counts as unavailable when no pull requests were observed", () => {
    const digest = buildCampaignDigest(
      {
        kind: "issues",
        issueNumbers: [43],
      },
      [
        buildStoredIssueReport({
          issueNumber: 43,
          title: "Issue 43",
          summary: {
            outcome: "failed",
            overallConclusion: "Failed before opening a PR.",
          },
          githubActivity: {
            reviewFeedbackRounds: 0,
          },
        }),
      ],
      "2026-03-11T12:00:00.000Z",
    );

    expect(digest.githubActivity.pullRequests).toHaveLength(0);
    expect(digest.githubActivity.actionableReviewCount).toBeNull();
    expect(digest.githubActivity.unresolvedThreadCount).toBeNull();
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- Actionable review count: Unavailable",
    );
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- Unresolved thread count: Unavailable",
    );
  });

  it("renders all five markdown outputs with stable headings", () => {
    const digest = buildCampaignDigest(
      {
        kind: "issues",
        issueNumbers: [32, 44],
      },
      [
        buildStoredIssueReport({
          issueNumber: 32,
          title: "Issue 32",
          summary: {
            outcome: "succeeded",
          },
          tokenUsage: {
            status: "complete",
            totalTokens: 2200,
          },
        }),
        buildStoredIssueReport({
          issueNumber: 44,
          title: "Issue 44",
          summary: {
            status: "partial",
            outcome: "awaiting-review",
            overallConclusion: "Awaiting review with partial timeline facts.",
          },
          tokenUsage: {
            status: "unavailable",
          },
        }),
      ],
      "2026-03-11T12:00:00.000Z",
    );

    expect(renderCampaignSummaryMarkdown(digest)).toContain(
      "# Campaign Summary: issues-32-44",
    );
    expect(renderCampaignTimelineMarkdown(digest)).toContain(
      "# Campaign Timeline: issues-32-44",
    );
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "# Campaign GitHub Activity: issues-32-44",
    );
    expect(renderCampaignTokenUsageMarkdown(digest)).toContain(
      "Aggregate status: partial",
    );
    expect(renderCampaignLearningsMarkdown(digest)).toContain(
      "## Changes To Make",
    );
  });
});

function buildStoredIssueReport(options: {
  readonly issueNumber: number;
  readonly title?: string | undefined;
  readonly generatedAt?: string | undefined;
  readonly summary?: {
    readonly status?: "complete" | "partial" | "unavailable" | undefined;
    readonly outcome?:
      | "claimed"
      | "running"
      | "attempt-failed"
      | "awaiting-plan-review"
      | "awaiting-review"
      | "needs-follow-up"
      | "retry-scheduled"
      | "succeeded"
      | "failed"
      | "unknown"
      | undefined;
    readonly startedAt?: string | null | undefined;
    readonly endedAt?: string | null | undefined;
    readonly attemptCount?: number | undefined;
    readonly pullRequestCount?: number | undefined;
    readonly overallConclusion?: string | undefined;
  };
  readonly timeline?: IssueReportDocument["timeline"] | undefined;
  readonly githubActivity?: {
    readonly pullRequests?:
      | IssueReportDocument["githubActivity"]["pullRequests"]
      | undefined;
    readonly reviewFeedbackRounds?: number | undefined;
  };
  readonly tokenUsage?: {
    readonly status?:
      | "unavailable"
      | "partial"
      | "estimated"
      | "complete"
      | undefined;
    readonly totalTokens?: number | null | undefined;
    readonly costUsd?: number | null | undefined;
  };
  readonly learnings?: {
    readonly observations?:
      | IssueReportDocument["learnings"]["observations"]
      | undefined;
  };
}): StoredIssueReportDocument {
  const issueNumber = options.issueNumber;
  const title = options.title ?? `Issue ${issueNumber.toString()}`;
  const timeline = options.timeline ?? [
    {
      kind: "claimed",
      at: options.summary?.startedAt ?? "2026-03-03T10:00:00.000Z",
      title: "Issue claimed",
      summary: "Claimed for work",
      attemptNumber: 1,
      sessionId: null,
      details: [],
    },
  ];
  const report: IssueReportDocument = {
    version: ISSUE_REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? "2026-03-05T12:00:00.000Z",
    summary: {
      status: options.summary?.status ?? "complete",
      issueNumber,
      issueIdentifier: `sociotechnica-org/symphony-ts#${issueNumber.toString()}`,
      repo: "sociotechnica-org/symphony-ts",
      title,
      issueUrl: `https://example.test/issues/${issueNumber.toString()}`,
      branch: `symphony/${issueNumber.toString()}`,
      outcome: options.summary?.outcome ?? "succeeded",
      startedAt:
        options.summary?.startedAt === undefined
          ? "2026-03-03T10:00:00.000Z"
          : options.summary.startedAt,
      endedAt:
        options.summary?.endedAt === undefined
          ? "2026-03-03T12:00:00.000Z"
          : options.summary.endedAt,
      attemptCount: options.summary?.attemptCount ?? 1,
      pullRequestCount: options.summary?.pullRequestCount ?? 0,
      overallConclusion:
        options.summary?.overallConclusion ?? "Completed successfully.",
      notes: [],
    },
    timeline,
    githubActivity: {
      status: "partial",
      issueStateTransitionsStatus: "unavailable",
      issueStateTransitionsNote:
        "Canonical local artifacts do not record issue state transitions.",
      pullRequests: options.githubActivity?.pullRequests ?? [],
      reviewFeedbackRounds: options.githubActivity?.reviewFeedbackRounds ?? 0,
      reviewLoopSummary: "No review activity recorded.",
      mergedAt: null,
      mergeNote: "Merge timing unavailable.",
      closedAt: null,
      closeNote: "Close timing unavailable.",
      notes: [],
    },
    tokenUsage: {
      status: options.tokenUsage?.status ?? "unavailable",
      explanation: "Synthetic token usage for unit tests.",
      totalTokens: options.tokenUsage?.totalTokens ?? null,
      costUsd: options.tokenUsage?.costUsd ?? null,
      sessions: [],
      attempts: [],
      agents: [],
      rawArtifacts: [],
      notes: [],
    },
    learnings: {
      status: "partial",
      observations: options.learnings?.observations ?? [],
      gaps: [],
    },
    artifacts: {
      rawIssueRoot: `/tmp/issues/${issueNumber.toString()}`,
      issueFile: `/tmp/issues/${issueNumber.toString()}/issue.json`,
      eventsFile: `/tmp/issues/${issueNumber.toString()}/events.jsonl`,
      attemptFiles: [],
      sessionFiles: [],
      logPointersFile: null,
      missingArtifacts: [],
      generatedReportJson: `/tmp/reports/issues/${issueNumber.toString()}/report.json`,
      generatedReportMarkdown: `/tmp/reports/issues/${issueNumber.toString()}/report.md`,
    },
    operatorInterventions: {
      status: "complete",
      summary: "No operator intervention required.",
      entries: [],
      note: "None.",
    },
  };

  return {
    report,
    rawReportJson: JSON.stringify(report),
    outputPaths: {
      issueRoot: `/tmp/reports/issues/${issueNumber.toString()}`,
      reportJsonFile: `/tmp/reports/issues/${issueNumber.toString()}/report.json`,
      reportMarkdownFile: `/tmp/reports/issues/${issueNumber.toString()}/report.md`,
    },
  };
}
