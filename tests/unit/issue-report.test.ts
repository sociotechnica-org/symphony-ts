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
import { createTempDir } from "../support/git.js";
import {
  downgradeIssueReportSchemaVersion,
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
