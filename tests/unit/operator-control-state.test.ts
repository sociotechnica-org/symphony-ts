import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateOperatorControlState,
  runtimeCheckpointFromFreshness,
  type OperatorControlActionCandidate,
  type OperatorControlPaths,
  type OperatorControlReleaseCheckpoint,
  type OperatorControlReportReviewCheckpoint,
  type OperatorControlRuntimeCheckpoint,
} from "../../src/observability/operator-control-state.js";

const paths: OperatorControlPaths = {
  operatorRepoRoot: "/operator",
  selectedInstanceRoot: "/instance",
  workflowPath: "/instance/WORKFLOW.md",
  controlStateFile: path.join(
    "/operator",
    ".ralph",
    "instances",
    "x",
    "control-state.json",
  ),
  releaseStateFile: path.join(
    "/operator",
    ".ralph",
    "instances",
    "x",
    "release-state.json",
  ),
  reportReviewStateFile: path.join(
    "/operator",
    ".ralph",
    "instances",
    "x",
    "report-review-state.json",
  ),
};

function runtimeCheckpoint(
  overrides: Partial<OperatorControlRuntimeCheckpoint> = {},
): OperatorControlRuntimeCheckpoint {
  return {
    kind: "runtime",
    state: "clear",
    summary: "Runtime is healthy.",
    controlState: "running",
    freshnessKind: "fresh",
    shouldRestart: false,
    factoryState: "idle",
    activeIssueCount: 0,
    ...overrides,
  };
}

function reportReviewCheckpoint(
  overrides: Partial<OperatorControlReportReviewCheckpoint> = {},
): OperatorControlReportReviewCheckpoint {
  return {
    kind: "report-review",
    state: "clear",
    summary: "No pending report reviews.",
    reviewStateFile: paths.reportReviewStateFile,
    pending: [],
    ...overrides,
  };
}

function releaseCheckpoint(
  overrides: Partial<OperatorControlReleaseCheckpoint> = {},
): OperatorControlReleaseCheckpoint {
  return {
    kind: "release",
    state: "clear",
    summary: "Release state is clear.",
    releaseStateFile: paths.releaseStateFile,
    advancementState: "configured-clear",
    promotionState: "labels-synchronized",
    blockingPrerequisiteNumber: null,
    ...overrides,
  };
}

function actionCandidate(
  overrides: Partial<OperatorControlActionCandidate> = {},
): OperatorControlActionCandidate {
  return {
    kind: "review-plan",
    issueNumber: 300,
    issueIdentifier: "sociotechnica-org/symphony-ts#300",
    title: "Issue 300",
    sourceStatus: "awaiting-human-handoff",
    summary: "Review the plan for issue #300.",
    pullRequestNumber: null,
    ...overrides,
  };
}

describe("evaluateOperatorControlState", () => {
  it("keeps stale busy runtime drift actionable until the next safe restart checkpoint", () => {
    const checkpoint = runtimeCheckpointFromFreshness({
      kind: "stale-runtime-busy",
      shouldRestart: false,
      runningRuntimeIdentity: null,
      currentRuntimeIdentity: null,
      runtimeHeadSha: "runtime-sha",
      engineHeadSha: "engine-sha",
      runningWorkflowIdentity: null,
      currentWorkflowIdentity: null,
      runtimeChanged: true,
      workflowChanged: false,
      unavailableReasons: [],
      controlState: "running",
      factoryState: "running",
      activeIssueCount: 1,
      summary:
        "Factory runtime drift is present, but the factory is busy so restart should wait for a safe checkpoint.",
    });

    expect(checkpoint.state).toBe("clear");
    expect(checkpoint.shouldRestart).toBe(false);
    expect(checkpoint.summary).toContain("restart should wait");
  });

  it("blocks stale idle runtime drift until the operator restarts the factory", () => {
    const checkpoint = runtimeCheckpointFromFreshness({
      kind: "stale-runtime-idle",
      shouldRestart: true,
      runningRuntimeIdentity: null,
      currentRuntimeIdentity: null,
      runtimeHeadSha: "runtime-sha",
      engineHeadSha: "engine-sha",
      runningWorkflowIdentity: null,
      currentWorkflowIdentity: null,
      runtimeChanged: true,
      workflowChanged: false,
      unavailableReasons: [],
      controlState: "running",
      factoryState: "idle",
      activeIssueCount: 0,
      summary:
        "Factory runtime drift is present and the factory is idle, so restart should happen before queue work.",
    });

    expect(checkpoint.state).toBe("blocked");
    expect(checkpoint.shouldRestart).toBe(true);
    expect(checkpoint.summary).toContain("Runtime checkpoint is blocked");
  });

  it("prioritizes runtime blockers over later checkpoints", () => {
    const document = evaluateOperatorControlState({
      updatedAt: "2026-04-08T00:00:00Z",
      paths,
      runtime: runtimeCheckpoint({
        state: "blocked",
        summary: "Restart before queue work.",
        freshnessKind: "stale-runtime-idle",
        shouldRestart: true,
      }),
      reportReview: reportReviewCheckpoint({
        state: "blocked",
        summary: "Report review is pending.",
      }),
      release: releaseCheckpoint({
        state: "blocked",
        summary: "Release is blocked.",
      }),
      actionCandidates: [actionCandidate()],
    });

    expect(document.posture).toBe("runtime-blocked");
    expect(document.blockingCheckpoint).toBe("runtime");
    expect(document.actions.state).toBe("blocked");
    expect(document.actions.items[0]?.blockedBy).toBe("runtime");
  });

  it("blocks on pending completed-run report review before plan review or landing", () => {
    const document = evaluateOperatorControlState({
      updatedAt: "2026-04-08T00:00:00Z",
      paths,
      runtime: runtimeCheckpoint(),
      reportReview: reportReviewCheckpoint({
        state: "blocked",
        summary: "One report review is pending.",
        pending: [
          {
            issueNumber: 44,
            issueIdentifier: "sociotechnica-org/symphony-ts#44",
            issueTitle: "Issue 44",
            issueOutcome: "succeeded",
            issueUpdatedAt: "2026-04-08T00:00:00Z",
            reportGeneratedAt: "2026-04-08T00:00:00Z",
            reportJsonFile: "/tmp/report.json",
            reportMarkdownFile: "/tmp/report.md",
            status: "report-ready",
            summary: "Issue #44 has a report ready for review.",
            note: null,
            blockedStage: null,
            followUpIssues: [],
            draftFollowUpIssue: null,
          },
        ],
      }),
      release: releaseCheckpoint(),
      actionCandidates: [actionCandidate()],
    });

    expect(document.posture).toBe("report-review-blocked");
    expect(document.blockingCheckpoint).toBe("report-review");
    expect(document.nextActionSummary).toContain("#44");
    expect(document.actions.items[0]?.state).toBe("blocked");
  });

  it("surfaces release blockers ahead of landing work", () => {
    const document = evaluateOperatorControlState({
      updatedAt: "2026-04-08T00:00:00Z",
      paths,
      runtime: runtimeCheckpoint(),
      reportReview: reportReviewCheckpoint(),
      release: releaseCheckpoint({
        state: "blocked",
        summary: "Release gate blocks downstream landing.",
        advancementState: "blocked-by-prerequisite-failure",
        blockingPrerequisiteNumber: 111,
      }),
      actionCandidates: [
        actionCandidate({
          kind: "post-land-command",
          sourceStatus: "awaiting-landing-command",
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          summary: "Post /land for PR #112.",
          pullRequestNumber: 112,
        }),
      ],
    });

    expect(document.posture).toBe("release-blocked");
    expect(document.blockingCheckpoint).toBe("release");
    expect(document.actions.items[0]?.blockedBy).toBe("release");
  });

  it("emits action-required when plan review or landing work is pending", () => {
    const document = evaluateOperatorControlState({
      updatedAt: "2026-04-08T00:00:00Z",
      paths,
      runtime: runtimeCheckpoint(),
      reportReview: reportReviewCheckpoint(),
      release: releaseCheckpoint(),
      actionCandidates: [
        actionCandidate(),
        actionCandidate({
          kind: "post-land-command",
          sourceStatus: "awaiting-landing-command",
          issueNumber: 301,
          issueIdentifier: "sociotechnica-org/symphony-ts#301",
          title: "Issue 301",
          summary: "Post /land for PR #301.",
          pullRequestNumber: 301,
        }),
      ],
    });

    expect(document.posture).toBe("action-required");
    expect(document.blockingCheckpoint).toBeNull();
    expect(document.actions.state).toBe("pending");
    expect(document.actions.items).toHaveLength(2);
  });

  it("emits clear when no blockers or operator-gated actions remain", () => {
    const document = evaluateOperatorControlState({
      updatedAt: "2026-04-08T00:00:00Z",
      paths,
      runtime: runtimeCheckpoint(),
      reportReview: reportReviewCheckpoint(),
      release: releaseCheckpoint(),
      actionCandidates: [],
    });

    expect(document.posture).toBe("clear");
    expect(document.blockingCheckpoint).toBeNull();
    expect(document.nextActionSummary).toBeNull();
    expect(document.actions.state).toBe("clear");
  });
});
