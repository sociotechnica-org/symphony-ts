import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceOperatorStatusProgress,
  readOperatorStatusSnapshot,
  renderOperatorStatusSnapshot,
  updateOperatorStatusProgress,
  writeOperatorStatusSnapshot,
  type OperatorStatusSnapshot,
} from "../../src/observability/operator-status.js";
import { createTempDir } from "../support/git.js";

function createSnapshot(
  overrides?: Partial<OperatorStatusSnapshot>,
): OperatorStatusSnapshot {
  return {
    version: 1,
    state: "acting",
    message: "Running operator wake-up cycle",
    updatedAt: "2026-04-09T12:00:00Z",
    progress: null,
    repoRoot: "/tmp/operator-repo",
    instanceKey: "operator-test-123",
    detachedSessionName: "symphony-factory-operator-test-123",
    selectedInstanceRoot: "/tmp/selected-instance",
    operatorStateRoot: "/tmp/operator-state",
    pid: 12345,
    runOnce: true,
    intervalSeconds: 300,
    provider: "codex",
    model: "gpt-5.4-mini",
    commandSource: "provider-template",
    command: "codex exec -C . -",
    effectiveCommand: "codex exec -C . -",
    promptFile: "/tmp/operator-prompt.md",
    operatorControl: {
      path: "/tmp/control-state.json",
      posture: "clear",
      summary: "All checkpoints are clear.",
      blockingCheckpoint: null,
      nextActionSummary: null,
    },
    standingContext: "/tmp/standing-context.md",
    wakeUpLog: "/tmp/wake-up-log.md",
    operatorSession: {
      enabled: false,
      path: "/tmp/operator-session.json",
      mode: "disabled",
      summary: "Resumable operator sessions are disabled.",
      backendSessionId: null,
      resetReason: null,
    },
    releaseState: {
      path: "/tmp/release-state.json",
      releaseId: null,
      advancementState: "unconfigured",
      summary: "Release state is unavailable.",
      updatedAt: null,
      blockingPrerequisiteNumber: null,
      blockingPrerequisiteIdentifier: null,
      promotion: {
        state: "unconfigured",
        summary: "Ready promotion is unavailable.",
        updatedAt: null,
        eligibleIssueNumbers: [],
        readyLabelsAdded: [],
        readyLabelsRemoved: [],
      },
    },
    reportReviewState: "/tmp/report-review-state.json",
    selectedWorkflowPath: "/tmp/selected-instance/WORKFLOW.md",
    lastCycle: {
      startedAt: "2026-04-09T12:00:00Z",
      finishedAt: null,
      exitCode: null,
      logFile: "/tmp/operator-cycle.log",
    },
    nextWakeAt: null,
    ...overrides,
  };
}

describe("operator status helpers", () => {
  it("advances progress sequence, preserves the previous milestone, and resets sequence at the next cycle start", () => {
    const first = advanceOperatorStatusProgress({
      current: null,
      update: {
        milestone: "cycle-start",
        summary: "Wake-up cycle started.",
        updatedAt: "2026-04-09T12:00:00Z",
      },
    });
    const second = advanceOperatorStatusProgress({
      current: first,
      update: {
        milestone: "checkpoint-report-review",
        summary: "Reviewing completed-run report follow-up for #344.",
        updatedAt: "2026-04-09T12:02:00Z",
        relatedIssueNumber: 344,
      },
    });
    const terminal = advanceOperatorStatusProgress({
      current: second,
      update: {
        milestone: "cycle-finished",
        summary: "Operator cycle completed successfully.",
        updatedAt: "2026-04-09T12:03:00Z",
      },
    });
    const nextCycleStart = advanceOperatorStatusProgress({
      current: terminal,
      update: {
        milestone: "cycle-start",
        summary: "Next wake-up cycle started.",
        updatedAt: "2026-04-09T12:10:00Z",
      },
    });

    expect(first.sequence).toBe(1);
    expect(first.previousMilestone).toBeNull();
    expect(second.sequence).toBe(2);
    expect(second.previousMilestone).toBe("cycle-start");
    expect(second.previousSummary).toBe("Wake-up cycle started.");
    expect(second.relatedIssueNumber).toBe(344);
    expect(terminal.sequence).toBe(3);
    expect(nextCycleStart.sequence).toBe(1);
    expect(nextCycleStart.previousMilestone).toBe("cycle-finished");
  });

  it("writes markdown progress lines and keeps previous checkpoint context on terminal completion", async () => {
    const tempDir = await createTempDir("symphony-operator-status-");
    const statusJsonPath = path.join(tempDir, "status.json");
    const statusMdPath = path.join(tempDir, "status.md");

    try {
      await writeOperatorStatusSnapshot(
        { statusJsonPath, statusMdPath },
        createSnapshot(),
      );

      await updateOperatorStatusProgress(
        { statusJsonPath, statusMdPath },
        {
          milestone: "cycle-start",
          summary: "Wake-up cycle started.",
          relatedIssueNumber: 344,
          relatedIssueIdentifier: "sociotechnica-org/symphony-ts#344",
        },
      );
      await updateOperatorStatusProgress(
        { statusJsonPath, statusMdPath },
        {
          milestone: "post-merge-refresh",
          summary: "Refreshing the selected instance after merge.",
          relatedIssueNumber: 344,
          relatedIssueIdentifier: "sociotechnica-org/symphony-ts#344",
          relatedPullRequestNumber: 512,
        },
      );

      const finalSnapshot = await updateOperatorStatusProgress(
        { statusJsonPath, statusMdPath },
        {
          milestone: "cycle-finished",
          summary: "Operator cycle completed successfully",
          relatedIssueNumber: 344,
          relatedIssueIdentifier: "sociotechnica-org/symphony-ts#344",
          relatedPullRequestNumber: 512,
        },
      );
      const storedSnapshot = await readOperatorStatusSnapshot(statusJsonPath);
      const statusMd = await fs.readFile(statusMdPath, "utf8");

      expect(storedSnapshot.progress).toEqual(finalSnapshot.progress);
      expect(finalSnapshot.progress?.milestone).toBe("cycle-finished");
      expect(finalSnapshot.progress?.sequence).toBe(3);
      expect(finalSnapshot.progress?.previousMilestone).toBe(
        "post-merge-refresh",
      );
      expect(finalSnapshot.progress?.previousSummary).toContain(
        "Refreshing the selected instance",
      );
      expect(renderOperatorStatusSnapshot(finalSnapshot)).toContain(
        "- Progress milestone: cycle-finished",
      );
      expect(statusMd).toContain("- Progress milestone: cycle-finished");
      expect(statusMd).toContain(
        "- Previous progress milestone: post-merge-refresh",
      );
      expect(statusMd).toContain(
        "- Progress subject: sociotechnica-org/symphony-ts#344 / PR #512",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed partial status snapshots before rendering can reuse them", async () => {
    const tempDir = await createTempDir("symphony-operator-status-invalid-");
    const statusJsonPath = path.join(tempDir, "status.json");

    try {
      await fs.writeFile(
        statusJsonPath,
        JSON.stringify({
          version: 1,
          state: "acting",
          message: "partial",
          updatedAt: "2026-04-09T12:00:00Z",
        }),
        "utf8",
      );

      await expect(readOperatorStatusSnapshot(statusJsonPath)).rejects.toThrow(
        /Malformed operatorControl in operator status snapshot/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
