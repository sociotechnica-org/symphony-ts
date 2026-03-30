import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/integration/github-follow-up-issues.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/integration/github-follow-up-issues.js")
  >("../../src/integration/github-follow-up-issues.js");
  return {
    ...actual,
    createGitHubFollowUpIssue: vi.fn(),
  };
});

vi.mock("../../src/observability/operator-report-review.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/operator-report-review.js")
  >("../../src/observability/operator-report-review.js");
  return {
    ...actual,
    blockOperatorReportFollowUpIssue: vi.fn(),
    recordOperatorReportFollowUpIssue: vi.fn(),
  };
});

import { runReportCli } from "../../src/cli/report.js";
import { createGitHubFollowUpIssue } from "../../src/integration/github-follow-up-issues.js";
import {
  blockOperatorReportFollowUpIssue,
  recordOperatorReportFollowUpIssue,
} from "../../src/observability/operator-report-review.js";
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

describe("runReportCli review-follow-up", () => {
  it("records a review-recording block with the created issue when ledger persistence fails", async () => {
    const instanceRoot = await createTempDir("symphony-report-follow-up-cli-");
    tempRoots.push(instanceRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const createdIssue = {
      number: 2571,
      url: "https://github.com/sociotechnica-org/symphony-ts/issues/2571",
      title: "Capture missing merge and close facts in issue reports",
    };
    const persistenceError = new Error("failed to persist review ledger");

    vi.mocked(createGitHubFollowUpIssue).mockResolvedValue(createdIssue);
    vi.mocked(recordOperatorReportFollowUpIssue).mockRejectedValue(
      persistenceError,
    );
    vi.mocked(blockOperatorReportFollowUpIssue).mockResolvedValue(
      {} as Awaited<ReturnType<typeof blockOperatorReportFollowUpIssue>>,
    );

    await expect(
      runReportCli([
        "node",
        "symphony-report",
        "review-follow-up",
        "--workflow",
        workflowPath,
        "--operator-repo-root",
        instanceRoot,
        "--issue",
        "44",
        "--title",
        createdIssue.title,
        "--body",
        "Report review found missing merge/close lifecycle facts.",
        "--summary",
        "Filed a follow-up issue for missing merge/close lifecycle facts.",
        "--finding-key",
        "missing-merge-close-facts",
      ]),
    ).rejects.toThrow("failed to persist review ledger");

    expect(createGitHubFollowUpIssue).toHaveBeenCalledWith({
      repo: "sociotechnica-org/symphony-ts",
      title: createdIssue.title,
      body: "Report review found missing merge/close lifecycle facts.",
    });
    expect(recordOperatorReportFollowUpIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 44,
        createdIssue,
      }),
    );
    expect(blockOperatorReportFollowUpIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 44,
        blockedStage: "review-recording",
        createdIssue,
        draft: {
          title: createdIssue.title,
          body: "Report review found missing merge/close lifecycle facts.",
        },
      }),
    );
  });
});
