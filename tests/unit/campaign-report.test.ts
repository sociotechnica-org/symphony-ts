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
            issueStateTransitionsStatus: "complete",
            issueStateTransitionsNote:
              "Canonical local artifacts preserved 2 observed issue state/label transitions.",
            issueTransitions: [
              {
                at: "2026-03-03T10:05:00.000Z",
                kind: "labels-changed",
                summary: "Issue labels changed (1 added, 1 removed).",
                details: [],
              },
              {
                at: "2026-03-03T12:00:00.000Z",
                kind: "state-changed",
                summary: "Issue state changed from open to closed.",
                details: [],
              },
            ],
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
                reviewerVerdict: "blocking-issues-found",
                blockingReviewerKeys: ["devin"],
                requiredReviewerState: "satisfied",
                pendingChecks: ["CI"],
                failingChecks: [],
              },
            ],
            reviewFeedbackRounds: 1,
            mergedAt: "2026-03-03T11:30:00.000Z",
            closedAt: "2026-03-03T12:00:00.000Z",
          },
          tokenUsage: {
            status: "complete",
            totalTokens: 3200,
            costUsd: 1.5,
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
            outcome: "awaiting-system-checks",
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
                reviewerVerdict: "no-blocking-verdict",
                blockingReviewerKeys: [],
                requiredReviewerState: "satisfied",
                pendingChecks: [],
                failingChecks: ["lint"],
              },
            ],
          },
          tokenUsage: {
            status: "estimated",
            totalTokens: 1200,
            costUsd: 2.25,
            observedCostSubtotal: null,
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
    expect(digest.githubActivity.blockingReviewerVerdictCount).toBe(1);
    expect(digest.githubActivity.issueTransitionStatus).toBe("partial");
    expect(digest.githubActivity.stateTransitionCount).toBe(1);
    expect(digest.githubActivity.labelTransitionCount).toBe(1);
    expect(digest.githubActivity.issuesWithTransitions).toEqual([
      { issueNumber: 32, issueTitle: "Issue 32", transitionCount: 2 },
    ]);
    expect(digest.githubActivity.mergeObservedCount).toBe(1);
    expect(digest.githubActivity.earliestMergedAt).toBe(
      "2026-03-03T11:30:00.000Z",
    );
    expect(digest.githubActivity.latestClosedAt).toBe(
      "2026-03-03T12:00:00.000Z",
    );
    expect(digest.tokenUsage.status).toBe("partial");
    expect(digest.tokenUsage.totalTokens).toBeNull();
    expect(digest.tokenUsage.costUsd).toBeNull();
    expect(digest.tokenUsage.observedTokenSubtotal).toBe(4400);
    expect(digest.tokenUsage.observedCostSubtotal).toBe(1.5);
    expect(digest.tokenUsage.notes).toContain(
      "2 of 3 selected issue reports supplied observed token data.",
    );
    expect(digest.tokenUsage.notes).toContain(
      "1 of 3 selected issue reports supplied observed cost data.",
    );
    expect(digest.learnings.changesToMake).toContain(
      "Expand token-usage capture or enrichment; campaign token coverage was partial across 3 issue reports.",
    );
  });

  it("sums aggregate campaign cost when complete and estimated issue reports are both priceable", () => {
    const digest = buildCampaignDigest(
      {
        kind: "issues",
        issueNumbers: [32, 44],
      },
      [
        buildStoredIssueReport({
          issueNumber: 32,
          tokenUsage: {
            status: "complete",
            totalTokens: 3200,
            costUsd: 1.5,
          },
        }),
        buildStoredIssueReport({
          issueNumber: 44,
          tokenUsage: {
            status: "estimated",
            totalTokens: 1200,
            costUsd: 2.25,
            observedCostSubtotal: null,
          },
        }),
      ],
      "2026-03-11T12:00:00.000Z",
    );

    expect(digest.tokenUsage.status).toBe("estimated");
    expect(digest.tokenUsage.totalTokens).toBe(4400);
    expect(digest.tokenUsage.costUsd).toBe(3.75);
    expect(digest.tokenUsage.observedCostSubtotal).toBe(1.5);
    expect(digest.tokenUsage.explanation).toContain(
      "at least one total remained estimated",
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
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- Blocking reviewer-app verdicts: Unavailable",
    );
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- Merge timing: No selected issue reports recorded merge timing.",
    );
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- First merge observed: Unavailable",
    );
  });

  it("treats blocking reviewer verdict totals as unavailable when legacy pull requests omit reviewer verdict data", () => {
    const digest = buildCampaignDigest(
      {
        kind: "issues",
        issueNumbers: [43, 44],
      },
      [
        buildStoredIssueReport({
          issueNumber: 43,
          githubActivity: {
            pullRequests: [
              {
                number: 143,
                url: "https://example.test/pr/143",
                attemptNumbers: [1],
                firstObservedAt: "2026-03-04T14:10:00.000Z",
                latestCommitAt: "2026-03-04T15:00:00.000Z",
                reviewFeedbackRounds: 0,
                actionableReviewCount: 0,
                unresolvedThreadCount: 0,
                reviewerVerdict: null,
                blockingReviewerKeys: [],
                requiredReviewerState: null,
                pendingChecks: [],
                failingChecks: [],
              },
            ],
            reviewFeedbackRounds: 0,
          },
        }),
        buildStoredIssueReport({
          issueNumber: 44,
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
                reviewerVerdict: "blocking-issues-found",
                blockingReviewerKeys: ["devin"],
                requiredReviewerState: "satisfied",
                pendingChecks: [],
                failingChecks: [],
              },
            ],
            reviewFeedbackRounds: 0,
          },
        }),
      ],
      "2026-03-11T12:00:00.000Z",
    );

    expect(digest.githubActivity.blockingReviewerVerdictCount).toBeNull();
    expect(renderCampaignGitHubActivityMarkdown(digest)).toContain(
      "- Blocking reviewer-app verdicts: Unavailable",
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
            outcome: "awaiting-system-checks",
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
      | "merged"
      | "awaiting-human-review"
      | "awaiting-system-checks"
      | "awaiting-landing-command"
      | "awaiting-landing"
      | "rework-required"
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
    readonly issueStateTransitionsStatus?:
      | IssueReportDocument["githubActivity"]["issueStateTransitionsStatus"]
      | undefined;
    readonly issueStateTransitionsNote?: string | undefined;
    readonly issueTransitions?:
      | IssueReportDocument["githubActivity"]["issueTransitions"]
      | undefined;
    readonly pullRequests?:
      | IssueReportDocument["githubActivity"]["pullRequests"]
      | undefined;
    readonly reviewFeedbackRounds?: number | undefined;
    readonly blockingReviewerVerdictCount?: number | null | undefined;
    readonly mergedAt?: string | null | undefined;
    readonly closedAt?: string | null | undefined;
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
    readonly observedTokenSubtotal?: number | null | undefined;
    readonly observedCostSubtotal?: number | null | undefined;
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
      issueStateTransitionsStatus:
        options.githubActivity?.issueStateTransitionsStatus ?? "unavailable",
      issueStateTransitionsNote:
        options.githubActivity?.issueStateTransitionsNote ??
        "Canonical local artifacts do not record issue state transitions.",
      issueTransitions: options.githubActivity?.issueTransitions ?? [],
      pullRequests: options.githubActivity?.pullRequests ?? [],
      reviewFeedbackRounds: options.githubActivity?.reviewFeedbackRounds ?? 0,
      reviewLoopSummary: "No review activity recorded.",
      mergedAt: options.githubActivity?.mergedAt ?? null,
      mergeNote:
        options.githubActivity?.mergedAt === undefined ||
        options.githubActivity.mergedAt === null
          ? "Merge timing unavailable."
          : "Merge timing recorded in canonical issue artifacts.",
      closedAt: options.githubActivity?.closedAt ?? null,
      closeNote:
        options.githubActivity?.closedAt === undefined ||
        options.githubActivity.closedAt === null
          ? "Close timing unavailable."
          : "Close timing recorded in canonical issue artifacts.",
      notes: [],
    },
    tokenUsage: {
      status: options.tokenUsage?.status ?? "unavailable",
      explanation: "Synthetic token usage for unit tests.",
      totalTokens: options.tokenUsage?.totalTokens ?? null,
      costUsd: options.tokenUsage?.costUsd ?? null,
      observedTokenSubtotal:
        options.tokenUsage?.observedTokenSubtotal === undefined
          ? (options.tokenUsage?.totalTokens ?? null)
          : options.tokenUsage.observedTokenSubtotal,
      observedCostSubtotal:
        options.tokenUsage?.observedCostSubtotal === undefined
          ? (options.tokenUsage?.costUsd ?? null)
          : options.tokenUsage.observedCostSubtotal,
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
