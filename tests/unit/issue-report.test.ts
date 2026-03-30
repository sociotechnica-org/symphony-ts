import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUE_REPORT_SCHEMA_VERSION,
  generateIssueReport,
  readIssueReport,
  writeIssueReport,
} from "../../src/observability/issue-report.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  deriveIssueArtifactPaths,
} from "../../src/observability/issue-artifacts.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import { createTempDir } from "../support/git.js";
import {
  downgradeIssueReportSchemaVersion,
  deriveReportInstance,
  deriveWorkspaceRoot,
  seedSessionAnchoredPartialArtifacts,
  seedSuccessfulIssueArtifacts,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("issue report generation", () => {
  it("derives canonical report facts and markdown from complete issue artifacts", async () => {
    const tempDir = await createTempDir("symphony-issue-report-unit-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:00:00.000Z",
    });

    expect(generated.report.summary.issueIdentifier).toBe(
      "sociotechnica-org/symphony-ts#44",
    );
    expect(generated.report.summary.outcome).toBe("succeeded");
    expect(generated.report.summary.attemptCount).toBe(1);
    expect(generated.report.summary.pullRequestCount).toBe(1);
    expect(generated.report.learnings.status).toBe("complete");
    expect(generated.report.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "claimed",
        "plan-ready",
        "runner-spawned",
        "pr-opened",
        "succeeded",
      ]),
    );
    expect(generated.report.tokenUsage.status).toBe("unavailable");
    expect(generated.markdown).toContain("## Summary");
    expect(generated.markdown).toContain("## Timeline");
    expect(generated.markdown).toContain("## GitHub Activity");
    expect(generated.markdown).toContain("## Token Usage");
    expect(generated.markdown).toContain("## Learnings");
    expect(generated.markdown).toContain("pending checks None");
    expect(generated.markdown).toContain("failing checks None");
  });

  it("projects canonical runner-event accounting into report token usage", async () => {
    const tempDir = await createTempDir("symphony-issue-report-accounting-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      accounting: {
        status: "partial",
        inputTokens: 2000,
        outputTokens: 750,
        totalTokens: 2750,
        costUsd: null,
      },
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:05:00.000Z",
    });

    expect(generated.report.tokenUsage.status).toBe("partial");
    expect(generated.report.tokenUsage.totalTokens).toBe(2750);
    expect(generated.report.tokenUsage.costUsd).toBeNull();
    expect(generated.report.tokenUsage.observedTokenSubtotal).toBe(2750);
    expect(generated.report.tokenUsage.observedCostSubtotal).toBeNull();
    expect(generated.report.tokenUsage.sessions[0]).toEqual(
      expect.objectContaining({
        status: "partial",
        inputTokens: 2000,
        outputTokens: 750,
        totalTokens: 2750,
        costUsd: null,
      }),
    );
    expect(generated.report.tokenUsage.explanation).toContain(
      "Canonical runner-event accounting",
    );
    expect(generated.report.tokenUsage.explanation).toContain(
      "1 remained partial",
    );
    expect(generated.report.tokenUsage.explanation).not.toContain(
      "remained estimated",
    );
  });

  it("summarizes non-plan operator interventions from canonical events", async () => {
    const tempDir = await createTempDir("symphony-issue-report-interventions-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const artifactPaths = deriveIssueArtifactPaths(
      deriveReportInstance(tempDir),
      44,
    );
    await fs.appendFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "landing-command-observed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:12:00.000Z",
          attemptNumber: 1,
          sessionId: null,
          details: {
            eventKey: "landing-command:comment-44",
            summary: "Observed /land on the current PR head.",
            landingCommand: {
              commentId: "comment-44",
              authorLogin: "jessmartin",
              observedAt: "2026-03-09T10:12:00.000Z",
              url: "https://example.test/pr/144#comment-44",
            },
            pullRequest: {
              number: 144,
              url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
              headSha: "head-sha-144",
              latestCommitAt: "2026-03-09T10:11:30.000Z",
            },
          },
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "report-follow-up-filed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:40:00.000Z",
          attemptNumber: null,
          sessionId: null,
          details: {
            source: "operator-cli",
            command: "review-follow-up",
            summary: "Filed a follow-up issue for missing merge facts.",
            followUpIssueNumber: 257,
            followUpIssueUrl:
              "https://github.com/sociotechnica-org/symphony-ts/issues/257",
            followUpIssueTitle: "Capture missing merge facts in issue reports",
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
        .concat("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:06:00.000Z",
    });

    expect(generated.report.operatorInterventions.summary).toBe(
      "Observed 2 operator intervention event(s) in canonical local artifacts.",
    );
    expect(generated.report.operatorInterventions.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "landing-command-observed",
          summary: "Landing command observed",
        }),
        expect.objectContaining({
          kind: "report-follow-up-filed",
          summary: "Report follow-up filed",
        }),
      ]),
    );
    expect(generated.markdown).toContain(
      "Landing command observed: 2026-03-09T10:12:00.000Z (landing-command-observed)",
    );
    expect(generated.markdown).toContain(
      "Follow-up issue #257: https://github.com/sociotechnica-org/symphony-ts/issues/257",
    );
  });

  it("surfaces reviewer-app verdict posture in issue and campaign-facing report fields", async () => {
    const tempDir = await createTempDir("symphony-issue-report-reviewer-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      review: {
        actionableCount: 0,
        unresolvedThreadCount: 0,
        reviewerVerdict: "blocking-issues-found",
        blockingReviewerKeys: ["devin"],
        requiredReviewerState: "satisfied",
      },
    });

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:07:00.000Z",
    });

    expect(generated.report.githubActivity.reviewLoopSummary).toContain(
      "reviewer-app blocking verdicts",
    );
    expect(generated.report.githubActivity.pullRequests[0]).toMatchObject({
      reviewerVerdict: "blocking-issues-found",
      blockingReviewerKeys: ["devin"],
      requiredReviewerState: "satisfied",
    });
    expect(generated.markdown).toContain(
      "reviewer verdict blocking-issues-found (devin)",
    );
  });

  it("keeps review rounds visible when reviewer-app blocking verdicts are also recorded", async () => {
    const tempDir = await createTempDir("symphony-issue-report-review-rounds-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      review: {
        actionableCount: 2,
        unresolvedThreadCount: 0,
        reviewerVerdict: "blocking-issues-found",
        blockingReviewerKeys: ["devin"],
        requiredReviewerState: "satisfied",
      },
    });
    const paths = deriveIssueArtifactPaths(deriveReportInstance(tempDir), 44);
    const reviewFeedbackEvent = {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      kind: "review-feedback",
      issueNumber: 44,
      observedAt: "2026-03-09T10:15:00.000Z",
      attemptNumber: 1,
      sessionId: "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
      details: {
        summary: "Follow-up review feedback recorded.",
      },
    };
    await fs.appendFile(
      paths.eventsFile,
      `${JSON.stringify(reviewFeedbackEvent)}\n${JSON.stringify(reviewFeedbackEvent)}\n${JSON.stringify(reviewFeedbackEvent)}\n`,
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:08:00.000Z",
    });

    expect(generated.report.githubActivity.reviewLoopSummary).toContain(
      "reviewer-app blocking verdicts",
    );
    expect(generated.report.githubActivity.reviewLoopSummary).toContain(
      "Recorded 3 review-feedback round(s)",
    );
  });

  it("keeps strict issue totals null while surfacing observed subtotals for mixed session coverage", async () => {
    const tempDir = await createTempDir("symphony-issue-report-observed-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44, {
      accounting: {
        status: "partial",
        inputTokens: 2000,
        outputTokens: 750,
        totalTokens: 2750,
        costUsd: null,
      },
    });

    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.writeFile(
      path.join(
        artifactPaths.sessionsDir,
        encodeURIComponent(
          "sociotechnica-org/symphony-ts#44/attempt-1/session-2",
        ).concat(".json"),
      ),
      `${JSON.stringify(
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          issueNumber: 44,
          attemptNumber: 1,
          sessionId: "sociotechnica-org/symphony-ts#44/attempt-1/session-2",
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          transport: createRunnerTransportMetadata("local-process", {
            canTerminateLocalProcess: true,
          }),
          backendSessionId: "claude-session-2",
          backendThreadId: null,
          latestTurnId: null,
          latestTurnNumber: 1,
          startedAt: "2026-03-09T10:06:00.000Z",
          finishedAt: "2026-03-09T10:10:00.000Z",
          workspacePath: path.join(workspaceRoot, "issue-44"),
          branch: "symphony/44",
          logPointers: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:06:00.000Z",
    });

    expect(generated.report.tokenUsage.status).toBe("partial");
    expect(generated.report.tokenUsage.totalTokens).toBeNull();
    expect(generated.report.tokenUsage.costUsd).toBeNull();
    expect(generated.report.tokenUsage.observedTokenSubtotal).toBe(2750);
    expect(generated.report.tokenUsage.observedCostSubtotal).toBeNull();
    expect(generated.report.tokenUsage.notes).toContain(
      "1 of 2 recorded session(s) supplied token totals, yielding an observed token subtotal of 2750 even though the strict aggregate total remained unavailable.",
    );
    expect(generated.markdown).toContain("Observed token subtotal: 2750");
  });

  it("generates a partial report when issue and event artifacts are missing but session artifacts remain", async () => {
    const tempDir = await createTempDir("symphony-issue-report-partial-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);

    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:10:00.000Z",
    });

    expect(generated.report.summary.status).toBe("partial");
    expect(generated.report.summary.title).toBeNull();
    expect(generated.report.summary.issueIdentifier).toBeNull();
    expect(generated.report.summary.outcome).toBe("attempt-failed");
    expect(generated.report.artifacts.missingArtifacts).toEqual(
      expect.arrayContaining([
        path.join(tempDir, ".var", "factory", "issues", "44", "issue.json"),
        path.join(tempDir, ".var", "factory", "issues", "44", "events.jsonl"),
      ]),
    );
    expect(generated.markdown).toContain("Unavailable");
    expect(generated.markdown).toContain("## Operator Interventions");
    await expect(
      fs.readFile(generated.outputPaths.reportJsonFile, "utf8"),
    ).resolves.toContain('"summary"');
    await expect(
      fs.readFile(generated.outputPaths.reportMarkdownFile, "utf8"),
    ).resolves.toContain("## Artifacts");
  });

  it("keeps older artifacts readable when reviewer verdict fields are absent", async () => {
    const tempDir = await createTempDir("symphony-issue-report-legacy-review-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const paths = deriveIssueArtifactPaths(deriveReportInstance(tempDir), 44);
    const attemptFile = path.join(paths.attemptsDir, "1.json");
    const succeededEventFile = paths.eventsFile;
    const attempt = JSON.parse(await fs.readFile(attemptFile, "utf8")) as {
      review?: Record<string, unknown>;
    };
    if (attempt.review) {
      delete attempt.review["reviewerVerdict"];
      delete attempt.review["blockingReviewerKeys"];
      delete attempt.review["requiredReviewerState"];
    }
    await fs.writeFile(attemptFile, `${JSON.stringify(attempt, null, 2)}\n`);

    const events = (await fs.readFile(succeededEventFile, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            details?: { review?: Record<string, unknown> };
          },
      );
    for (const event of events) {
      if (event.details?.review) {
        delete event.details.review["reviewerVerdict"];
        delete event.details.review["blockingReviewerKeys"];
        delete event.details.review["requiredReviewerState"];
      }
    }
    await fs.writeFile(
      succeededEventFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:11:00.000Z",
    });

    expect(generated.report.githubActivity.pullRequests[0]).toMatchObject({
      reviewerVerdict: null,
      requiredReviewerState: null,
    });
    expect(generated.markdown).toContain("reviewer verdict Unavailable");
  });

  it("ignores nested .json directories when reading attempt and session artifacts", async () => {
    const tempDir = await createTempDir("symphony-issue-report-nested-json-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await fs.mkdir(
      path.join(
        tempDir,
        ".var",
        "factory",
        "issues",
        "44",
        "attempts",
        "nested.json",
      ),
      { recursive: true },
    );
    await fs.mkdir(
      path.join(
        tempDir,
        ".var",
        "factory",
        "issues",
        "44",
        "sessions",
        "nested.json",
      ),
      { recursive: true },
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:20:00.000Z",
    });

    expect(generated.report.summary.outcome).toBe("succeeded");
    expect(generated.report.artifacts.attemptFiles).toHaveLength(1);
    expect(generated.report.artifacts.sessionFiles).toHaveLength(1);
  });

  it("keeps events.jsonl in artifact pointers when the file exists but is empty", async () => {
    const tempDir = await createTempDir("symphony-issue-report-empty-events-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const eventsFile = path.join(
      tempDir,
      ".var",
      "factory",
      "issues",
      "44",
      "events.jsonl",
    );
    await fs.writeFile(eventsFile, "", "utf8");

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:30:00.000Z",
    });

    expect(generated.report.artifacts.eventsFile).toBe(eventsFile);
    expect(generated.report.artifacts.missingArtifacts).not.toContain(
      eventsFile,
    );
    expect(generated.report.summary.notes).toContain(
      "The canonical lifecycle event ledger was present but contained no recorded lifecycle events.",
    );
  });

  it("ignores non-numeric attempt json files when loading attempt artifacts", async () => {
    const tempDir = await createTempDir("symphony-issue-report-attempt-json-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await fs.writeFile(
      path.join(
        tempDir,
        ".var",
        "factory",
        "issues",
        "44",
        "attempts",
        "metadata.json",
      ),
      `${JSON.stringify({ note: "ignore me" }, null, 2)}\n`,
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:40:00.000Z",
    });

    expect(generated.report.summary.outcome).toBe("succeeded");
    expect(generated.report.artifacts.attemptFiles).toEqual([
      path.join(
        tempDir,
        ".var",
        "factory",
        "issues",
        "44",
        "attempts",
        "1.json",
      ),
    ]);
  });

  it("downgrades every stored token-usage session when rewriting a report to schema v1", async () => {
    const tempDir = await createTempDir("symphony-issue-report-downgrade-");
    tempRoots.push(tempDir);
    const reportJsonFile = path.join(tempDir, "report.json");

    await fs.writeFile(
      reportJsonFile,
      `${JSON.stringify(
        {
          version: ISSUE_REPORT_SCHEMA_VERSION,
          tokenUsage: {
            sessions: [
              {
                sessionId: "session-1",
                status: "complete",
                notes: ["note-1"],
              },
              {
                sessionId: "session-2",
                status: "partial",
                notes: ["note-2"],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await downgradeIssueReportSchemaVersion(reportJsonFile);

    const downgraded = JSON.parse(
      await fs.readFile(reportJsonFile, "utf8"),
    ) as {
      readonly version: number;
      readonly tokenUsage: {
        readonly sessions: readonly Record<string, unknown>[];
      };
    };

    expect(downgraded.version).toBe(1);
    expect(downgraded.tokenUsage.sessions).toEqual([
      { sessionId: "session-1" },
      { sessionId: "session-2" },
    ]);
  });

  it.each(["approved", "waived"] as const)(
    "does not keep awaiting plan review after a %s handoff event",
    async (decisionKind) => {
      const tempDir = await createTempDir(
        `symphony-issue-report-${decisionKind}-`,
      );
      tempRoots.push(tempDir);
      const workspaceRoot = deriveWorkspaceRoot(tempDir);
      const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
      await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
      await fs.writeFile(
        artifactPaths.eventsFile,
        [
          {
            version: ISSUE_ARTIFACT_SCHEMA_VERSION,
            kind: "claimed",
            issueNumber: 44,
            observedAt: "2026-03-09T10:00:00.000Z",
            attemptNumber: null,
            sessionId: null,
            details: {},
          },
          {
            version: ISSUE_ARTIFACT_SCHEMA_VERSION,
            kind: "plan-ready",
            issueNumber: 44,
            observedAt: "2026-03-09T10:02:00.000Z",
            attemptNumber: null,
            sessionId: null,
            details: {},
          },
          {
            version: ISSUE_ARTIFACT_SCHEMA_VERSION,
            kind: decisionKind,
            issueNumber: 44,
            observedAt: "2026-03-09T10:03:00.000Z",
            attemptNumber: null,
            sessionId: null,
            details: {},
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
        "utf8",
      );

      const generated = await generateIssueReport(workspaceRoot, 44, {
        generatedAt: "2026-03-09T13:50:00.000Z",
      });

      expect(generated.report.summary.outcome).toBe("claimed");
      expect(generated.report.summary.outcome).not.toBe("awaiting-plan-review");
    },
  );

  it("keeps awaiting-human-review when review-feedback events record a waiting lifecycle", async () => {
    const tempDir = await createTempDir("symphony-issue-report-human-review-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
    await fs.writeFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "claimed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:00:00.000Z",
          attemptNumber: null,
          sessionId: null,
          details: {},
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "review-feedback",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            lifecycleKind: "awaiting-human-review",
            summary:
              "Waiting for human review on https://github.com/sociotechnica-org/symphony-ts/pull/144",
            pullRequest: {
              number: 144,
              url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
              latestCommitAt: "2026-03-09T10:09:30.000Z",
            },
            review: {
              actionableCount: 0,
              unresolvedThreadCount: 1,
            },
            checks: {
              pendingNames: [],
              failingNames: [],
            },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:00:00.000Z",
    });

    expect(generated.report.summary.outcome).toBe("awaiting-human-review");
  });

  it("orders shutdown timeline entries ahead of review feedback when timestamps match", async () => {
    const tempDir = await createTempDir(
      "symphony-issue-report-shutdown-order-",
    );
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
    await fs.writeFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "shutdown-terminated",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            summary: "Runner exited during coordinated shutdown",
          },
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "review-feedback",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            lifecycleKind: "awaiting-review-feedback",
            summary:
              "Waiting for review feedback on https://github.com/sociotechnica-org/symphony-ts/pull/173",
            pullRequest: {
              number: 173,
              url: "https://github.com/sociotechnica-org/symphony-ts/pull/173",
              latestCommitAt: "2026-03-09T10:09:30.000Z",
            },
            review: {
              actionableCount: 1,
              unresolvedThreadCount: 1,
            },
            checks: {
              pendingNames: [],
              failingNames: [],
            },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:05:00.000Z",
    });

    expect(generated.report.timeline.map((entry) => entry.kind)).toEqual([
      "shutdown-terminated",
      "review-feedback",
    ]);
  });

  it("keeps landing observations after pull-request activity and report actions after terminal outcomes when timestamps match", async () => {
    const tempDir = await createTempDir(
      "symphony-issue-report-intervention-order-",
    );
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
    await fs.writeFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "pr-opened",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            summary: "PR opened and awaiting checks",
          },
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "landing-command-observed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            summary: "Observed /land on the current PR head.",
          },
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "succeeded",
          issueNumber: 44,
          observedAt: "2026-03-09T10:20:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            summary: "Issue completed successfully",
          },
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "report-published",
          issueNumber: 44,
          observedAt: "2026-03-09T10:20:00.000Z",
          attemptNumber: null,
          sessionId: null,
          details: {
            summary: "Published report artifacts to the run archive.",
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:05:00.000Z",
    });

    expect(generated.report.timeline.map((entry) => entry.kind)).toEqual([
      "pr-opened",
      "landing-command-observed",
      "succeeded",
      "report-published",
    ]);
  });

  it("reports merged when the latest landing-blocked event records an already-merged lifecycle", async () => {
    const tempDir = await createTempDir("symphony-issue-report-merged-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
    await fs.writeFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "claimed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:00:00.000Z",
          attemptNumber: null,
          sessionId: null,
          details: {},
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "landing-blocked",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 1,
          sessionId: "session-1",
          details: {
            lifecycleKind: "merged",
            summary:
              "Landing blocked for https://github.com/sociotechnica-org/symphony-ts/pull/144 because it is already merged.",
            pullRequest: {
              number: 144,
              url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
              latestCommitAt: "2026-03-09T10:09:30.000Z",
            },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:00:00.000Z",
    });

    expect(generated.report.summary.outcome).toBe("merged");
  });

  it("treats landing-failed as an attempt failure in report summaries and timeline copy", async () => {
    const tempDir = await createTempDir(
      "symphony-issue-report-landing-failed-",
    );
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
    await fs.writeFile(
      artifactPaths.eventsFile,
      [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "claimed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:00:00.000Z",
          attemptNumber: null,
          sessionId: null,
          details: {},
        },
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "landing-failed",
          issueNumber: 44,
          observedAt: "2026-03-09T10:10:00.000Z",
          attemptNumber: 2,
          sessionId: null,
          details: {
            summary:
              "Landing request failed for sociotechnica-org/symphony-ts#44: Error: merge temporarily blocked",
            branch: "symphony/44",
            error: "Error: merge temporarily blocked",
            success: false,
            lifecycleKind: "attempt-failed",
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:10:00.000Z",
    });

    expect(generated.report.summary.outcome).toBe("attempt-failed");
    expect(generated.report.timeline).toContainEqual(
      expect.objectContaining({
        kind: "landing-failed",
        title: "Landing failed",
        summary:
          "Landing request failed for sociotechnica-org/symphony-ts#44: Error: merge temporarily blocked",
      }),
    );
    expect(generated.markdown).toContain("Landing failed");
  });

  it.each([
    {
      fileName: "report.json",
      fileKind: "JSON",
    },
    {
      fileName: "report.md",
      fileKind: "markdown",
    },
  ] as const)(
    "names the missing %s artifact when reading a stored issue report",
    async ({ fileName, fileKind }) => {
      const tempDir = await createTempDir("symphony-issue-report-read-");
      tempRoots.push(tempDir);
      const workspaceRoot = deriveWorkspaceRoot(tempDir);
      await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

      const generated = await writeIssueReport(workspaceRoot, 44, {
        generatedAt: "2026-03-09T14:00:00.000Z",
      });

      await fs.rm(path.join(generated.outputPaths.issueRoot, fileName));

      await expect(readIssueReport(workspaceRoot, 44)).rejects.toThrowError(
        `No generated issue report ${fileKind} found for issue #44 at ${path.join(generated.outputPaths.issueRoot, fileName)}; run 'symphony-report issue --issue 44' first.`,
      );
    },
  );

  it("prefers the JSON-missing error when both generated report files are absent", async () => {
    const tempDir = await createTempDir("symphony-issue-report-read-both-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:05:00.000Z",
    });

    await Promise.all([
      fs.rm(path.join(generated.outputPaths.issueRoot, "report.json")),
      fs.rm(path.join(generated.outputPaths.issueRoot, "report.md")),
    ]);

    await expect(readIssueReport(workspaceRoot, 44)).rejects.toThrowError(
      `No generated issue report JSON found for issue #44 at ${path.join(generated.outputPaths.issueRoot, "report.json")}; run 'symphony-report issue --issue 44' first.`,
    );
  });

  it("rejects stored generated reports from older schema versions with a regeneration error", async () => {
    const tempDir = await createTempDir("symphony-issue-report-read-stale-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T14:10:00.000Z",
    });
    await downgradeIssueReportSchemaVersion(
      generated.outputPaths.reportJsonFile,
    );

    await expect(readIssueReport(workspaceRoot, 44)).rejects.toThrowError(
      `Generated issue report JSON at ${generated.outputPaths.reportJsonFile} uses schema version 1, but this build expects ${ISSUE_REPORT_SCHEMA_VERSION.toString()}; run 'symphony-report issue --issue 44' first to regenerate it.`,
    );
  });
});
