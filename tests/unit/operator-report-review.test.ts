import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowInstancePaths } from "../../src/config/workflow.js";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../../src/domain/instance-identity.js";
import {
  recordOperatorReportFollowUpIssue,
  recordOperatorReportReviewDecision,
  syncOperatorReportReviews,
} from "../../src/observability/operator-report-review.js";
import { createTempDir } from "../support/git.js";
import {
  seedSessionAnchoredPartialArtifacts,
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("operator report review state", () => {
  it("detects completed issues as pending review and generates missing reports", async () => {
    const instanceRoot = await createTempDir(
      "symphony-report-review-instance-",
    );
    const operatorRoot = await createTempDir(
      "symphony-report-review-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const instance = await loadWorkflowInstancePaths(workflowPath);
    await seedSuccessfulIssueArtifacts(`${instanceRoot}/.tmp/workspaces`, 44);

    const identity = deriveSymphonyInstanceIdentity(workflowPath);
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: identity.instanceKey,
    });

    const synced = await syncOperatorReportReviews({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
    });

    expect(synced.pending).toHaveLength(1);
    expect(synced.pending[0]).toMatchObject({
      issueNumber: 44,
      status: "report-ready",
    });
    await expect(
      fs.readFile(paths.reportReviewStatePath, "utf8"),
    ).resolves.toContain('"status": "report-ready"');
    await expect(
      fs.readFile(`${instanceRoot}/.var/reports/issues/44/report.json`, "utf8"),
    ).resolves.toContain('"issueNumber": 44');
  });

  it("does not resurface a report after the current generated report was reviewed", async () => {
    const instanceRoot = await createTempDir(
      "symphony-report-review-reviewed-",
    );
    const operatorRoot = await createTempDir(
      "symphony-report-review-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const instance = await loadWorkflowInstancePaths(workflowPath);
    await seedSuccessfulIssueArtifacts(`${instanceRoot}/.tmp/workspaces`, 44);

    const identity = deriveSymphonyInstanceIdentity(workflowPath);
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: identity.instanceKey,
    });

    await syncOperatorReportReviews({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
    });
    await recordOperatorReportReviewDecision({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
      issueNumber: 44,
      status: "reviewed-no-follow-up",
      summary: "Reviewed the completed report; no follow-up issue was needed.",
    });

    const resynced = await syncOperatorReportReviews({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
    });

    expect(resynced.pending).toHaveLength(0);
    await expect(
      fs.readFile(paths.reportReviewStatePath, "utf8"),
    ).resolves.toContain('"status": "reviewed-no-follow-up"');
  });

  it("preserves linked follow-up issue references in the review ledger", async () => {
    const instanceRoot = await createTempDir(
      "symphony-report-review-follow-up-",
    );
    const operatorRoot = await createTempDir(
      "symphony-report-review-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const instance = await loadWorkflowInstancePaths(workflowPath);
    await seedSuccessfulIssueArtifacts(`${instanceRoot}/.tmp/workspaces`, 44);

    const identity = deriveSymphonyInstanceIdentity(workflowPath);
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: identity.instanceKey,
    });

    await syncOperatorReportReviews({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
    });
    const recorded = await recordOperatorReportFollowUpIssue({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
      issueNumber: 44,
      findingKey: "missing-merge-close-facts",
      createdIssue: {
        number: 2571,
        url: "https://github.com/sociotechnica-org/symphony-ts/issues/2571",
        title: "Capture merge and close lifecycle facts in issue reports",
      },
      summary:
        "Filed a follow-up issue for missing merge/close lifecycle facts.",
    });

    expect(recorded.status).toBe("reviewed-follow-up-filed");
    expect(recorded.followUpIssues).toEqual([
      {
        findingKey: "missing-merge-close-facts",
        number: 2571,
        url: "https://github.com/sociotechnica-org/symphony-ts/issues/2571",
        title: "Capture merge and close lifecycle facts in issue reports",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("skips numeric artifact directories that do not have an issue summary", async () => {
    const instanceRoot = await createTempDir("symphony-report-review-partial-");
    const operatorRoot = await createTempDir(
      "symphony-report-review-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);

    const workflowPath = await writeReportWorkflow(instanceRoot);
    const instance = await loadWorkflowInstancePaths(workflowPath);
    const workspaceRoot = `${instanceRoot}/.tmp/workspaces`;
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 45);

    const identity = deriveSymphonyInstanceIdentity(workflowPath);
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: identity.instanceKey,
    });

    const synced = await syncOperatorReportReviews({
      instance,
      reviewStateFile: paths.reportReviewStatePath,
    });

    expect(synced.pending).toEqual([
      expect.objectContaining({
        issueNumber: 44,
        status: "report-ready",
      }),
    ]);
  });
});
