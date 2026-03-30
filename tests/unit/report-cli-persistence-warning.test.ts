import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/integration/factory-runs.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/integration/factory-runs.js")
  >("../../src/integration/factory-runs.js");
  return {
    ...actual,
    publishIssueToFactoryRuns: vi.fn(),
  };
});

vi.mock("../../src/observability/operator-report-review.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/operator-report-review.js")
  >("../../src/observability/operator-report-review.js");
  return {
    ...actual,
    recordOperatorReportReviewDecision: vi.fn(),
  };
});

vi.mock("../../src/observability/issue-artifacts.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/issue-artifacts.js")
  >("../../src/observability/issue-artifacts.js");
  return {
    ...actual,
    appendIssueArtifactEvent: vi.fn(),
  };
});

import { runReportCli } from "../../src/cli/report.js";
import { publishIssueToFactoryRuns } from "../../src/integration/factory-runs.js";
import { appendIssueArtifactEvent } from "../../src/observability/issue-artifacts.js";
import { recordOperatorReportReviewDecision } from "../../src/observability/operator-report-review.js";
import { createTempDir } from "../support/git.js";
import { writeReportWorkflow } from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runReportCli additive issue-artifact persistence warnings", () => {
  it("warns without failing when publish artifact append fails", async () => {
    const instanceRoot = await createTempDir("symphony-report-publish-cli-");
    tempRoots.push(instanceRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];

    vi.mocked(publishIssueToFactoryRuns).mockResolvedValue({
      publicationId: "pub-44",
      status: "complete",
      paths: {
        repoRoot: "/tmp/factory-runs/symphony-ts",
        issueRoot: "/tmp/factory-runs/symphony-ts/issues/44",
        publicationRoot: "/tmp/factory-runs/44",
        reportJsonFile: "/tmp/factory-runs/44/report.json",
        reportMarkdownFile: "/tmp/factory-runs/44/report.md",
        metadataFile: "/tmp/factory-runs/44/metadata.json",
        logsDir: "/tmp/factory-runs/44/logs",
      },
      metadata: {
        version: 1,
        publicationId: "pub-44",
        publishedAt: "2026-03-30T04:45:00.000Z",
        publicationStatus: "complete",
        notes: [],
        repo: "sociotechnica-org/symphony-ts",
        repoName: "symphony-ts",
        issueNumber: 44,
        issueIdentifier: "sociotechnica-org/symphony-ts#44",
        title: "Persist operator interventions",
        issueUrl: "https://github.com/sociotechnica-org/symphony-ts/issues/44",
        branchName: "symphony/44",
        pullRequests: [],
        reportGeneratedAt: "2026-03-30T04:44:00.000Z",
        startedAt: null,
        endedAt: null,
        latestSessionId: null,
        sessionIds: [],
        attempts: [],
        sourceRevision: {
          checkoutPath: "/tmp/source",
          currentBranch: "symphony/44",
          relevantSha: "abcdef12",
          baseSha: null,
          commitRange: null,
        },
        sourceArtifacts: {
          rawIssueRoot: "/tmp/source/.var/factory/issues/44",
          issueFile: "/tmp/source/.var/factory/issues/44/issue.json",
          eventsFile: "/tmp/source/.var/factory/issues/44/events.jsonl",
          attemptFiles: [],
          sessionFiles: [],
          logPointersFile: null,
          reportJsonFile: "/tmp/source/.var/reports/issues/44/report.json",
          reportMarkdownFile: "/tmp/source/.var/reports/issues/44/report.md",
        },
        logs: {
          status: "complete",
          copiedCount: 0,
          referencedCount: 0,
          unavailableCount: 0,
          entries: [],
        },
      },
    } as unknown as Awaited<ReturnType<typeof publishIssueToFactoryRuns>>);
    vi.mocked(appendIssueArtifactEvent).mockRejectedValue(
      new Error("artifact append failed"),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write);

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "publish",
        "--workflow",
        workflowPath,
        "--issue",
        "44",
        "--archive-root",
        "/tmp/factory-runs",
      ]),
    ).resolves.toBeUndefined();

    expect(stdout.join("")).toContain("Published issue #44 to factory-runs");
    expect(stderr.join("")).toContain(
      "canonical issue artifact persistence failed: artifact append failed",
    );
  });

  it("warns without failing when review-record artifact append fails", async () => {
    const instanceRoot = await createTempDir("symphony-report-review-cli-");
    tempRoots.push(instanceRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];

    vi.mocked(recordOperatorReportReviewDecision).mockResolvedValue({
      issueNumber: 44,
      issueIdentifier: "sociotechnica-org/symphony-ts#44",
      issueTitle: "Persist operator interventions",
      issueOutcome: "succeeded",
      issueUpdatedAt: "2026-03-30T04:44:00.000Z",
      reportGeneratedAt: "2026-03-30T04:45:00.000Z",
      reportMarkdownFile: "/tmp/report.md",
      status: "reviewed-no-follow-up",
      summary: "No follow-up required.",
      note: null,
      blockedStage: null,
      reportJsonFile: "/tmp/report.json",
      reviewStateFile: "/tmp/review-state.json",
      recordedAt: "2026-03-30T04:46:00.000Z",
      followUpIssues: [],
      draftFollowUpIssue: null,
    } as Awaited<ReturnType<typeof recordOperatorReportReviewDecision>>);
    vi.mocked(appendIssueArtifactEvent).mockRejectedValue(
      new Error("artifact append failed"),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write);

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "review-record",
        "--workflow",
        workflowPath,
        "--operator-repo-root",
        instanceRoot,
        "--issue",
        "44",
        "--status",
        "reviewed-no-follow-up",
        "--summary",
        "No follow-up required.",
      ]),
    ).resolves.toBeUndefined();

    expect(stdout.join("")).toContain(
      "Recorded reviewed-no-follow-up for issue #44",
    );
    expect(stderr.join("")).toContain(
      "canonical issue artifact persistence failed: artifact append failed",
    );
  });
});
