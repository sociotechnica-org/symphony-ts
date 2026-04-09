import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultPlanReviewReplyGuidance,
  buildDefaultPlanReviewReplyTemplateBlock,
  type PlanReviewProtocol,
} from "../../src/domain/plan-review.js";
import { JsonLogger } from "../../src/observability/logger.js";
import type { Logger } from "../../src/observability/logger.js";
import type { LinearTrackerConfig } from "../../src/domain/workflow.js";
import { LinearTracker } from "../../src/tracker/linear.js";
import { MockLinearServer } from "../support/mock-linear-server.js";

function createConfig(
  server: MockLinearServer,
  overrides: Partial<LinearTrackerConfig> = {},
): LinearTrackerConfig {
  return {
    kind: "linear",
    endpoint: server.baseUrl,
    apiKey: "linear-token",
    projectSlug: "symphony-linear",
    assignee: "worker@example.test",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled"],
    queuePriority: undefined,
    ...overrides,
  };
}

class CapturingLogger implements Logger {
  readonly warnings: string[] = [];

  info(_message: string, _data?: Record<string, unknown>): void {}

  warn(message: string, _data?: Record<string, unknown>): void {
    this.warnings.push(message);
  }

  error(_message: string, _data?: Record<string, unknown>): void {}
}

const customPlanReviewBase = {
  planReadySignal: "Review status: ready-for-human-plan",
  legacyPlanReadySignals: [],
  approvedSignal: "Review verdict: ship-it",
  changesRequestedSignal: "Review verdict: needs-revision",
  waivedSignal: "Review verdict: waived",
  metadataLabels: {
    planPath: "Plan file",
    branchName: "Issue branch",
    planUrl: "Plan link",
    branchUrl: "Branch link",
    compareUrl: "Diff link",
  },
} as const;

const customPlanReview: PlanReviewProtocol = {
  ...customPlanReviewBase,
  reviewReplyGuidance:
    buildDefaultPlanReviewReplyGuidance(customPlanReviewBase),
  replyTemplateBlock:
    buildDefaultPlanReviewReplyTemplateBlock(customPlanReviewBase),
};

describe("LinearTracker", () => {
  let server: MockLinearServer;

  beforeEach(async () => {
    server = new MockLinearServer();
    await server.start();
    server.seedProject({
      slugId: "symphony-linear",
      name: "Symphony Linear",
      states: [
        { name: "Todo", type: "unstarted" },
        { name: "In Progress", type: "started" },
        { name: "Human Review", type: "started" },
        { name: "Rework", type: "started" },
        { name: "Merging", type: "started" },
        { name: "Done", type: "completed" },
        { name: "Canceled", type: "canceled" },
      ],
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it("reads paginated ready issues from the mock Linear GraphQL surface", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Issue 1",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      labels: ["Backend"],
      priority: 2,
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 2,
      title: "Issue 2",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      labels: ["Needs Review"],
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 3,
      title: "Issue 3",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const ready = await tracker.fetchReadyIssues();

    expect(ready.map((issue) => issue.number)).toEqual([1, 2, 3]);
    expect(ready[0]?.labels).toEqual(["backend"]);
    expect(ready[0]?.queuePriority).toBeNull();
    expect(ready[1]?.labels).toEqual(["needs review"]);
    expect(server.countRequests("GetProjectIssuesPage")).toBe(2);
  });

  it("returns normalized queue priority from Linear native priority when enabled", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Urgent issue",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      priority: 1,
    });

    const tracker = new LinearTracker(
      createConfig(server, {
        queuePriority: { enabled: true },
      }),
      new JsonLogger(),
    );
    const ready = await tracker.fetchReadyIssues();

    expect(ready[0]?.queuePriority).toEqual({
      rank: 1,
      label: "Urgent",
    });
  });

  it("keeps Linear queue priority null when omitted or disabled", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "High issue",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      priority: 2,
    });

    const omittedTracker = new LinearTracker(
      createConfig(server),
      new JsonLogger(),
    );
    const disabledTracker = new LinearTracker(
      createConfig(server, {
        queuePriority: { enabled: false },
      }),
      new JsonLogger(),
    );

    const omittedReady = await omittedTracker.fetchReadyIssues();
    const disabledReady = await disabledTracker.fetchReadyIssues();

    expect(omittedReady[0]?.queuePriority).toBeNull();
    expect(disabledReady[0]?.queuePriority).toBeNull();
  });

  it("returns normalized blocker references on runtime issues", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Upstream blocker",
      stateName: "In Progress",
      assigneeEmail: "worker@example.test",
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 2,
      title: "Blocked issue",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      inverseRelations: [{ type: "blocks", issueNumber: 1 }],
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const ready = await tracker.fetchReadyIssues();
    const blocked = ready.find((issue) => issue.number === 2);

    expect(blocked?.blockedBy).toEqual([
      {
        id: expect.any(String),
        identifier: "SYMPHONY-LINEAR-1",
        title: "Upstream blocker",
        state: "In Progress",
      },
    ]);
  });

  it("filters ready issues by normalized assignee routing instead of GraphQL query parameters", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Assigned to worker",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 2,
      title: "Assigned elsewhere",
      stateName: "Todo",
      assigneeEmail: "other@example.test",
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 3,
      title: "Unassigned",
      stateName: "Todo",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const ready = await tracker.fetchReadyIssues();
    const request = server.requests("GetProjectIssuesPage")[0];

    expect(ready.map((issue) => issue.number)).toEqual([1]);
    expect(request?.variables).toEqual({
      slugId: "symphony-linear",
      after: null,
    });
  });

  it("breaks defensively when Linear reports another page without an end cursor", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Issue 1",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 2,
      title: "Issue 2",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 3,
      title: "Issue 3",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    server.forceNullEndCursorWithNextPage();

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const ready = await tracker.fetchReadyIssues();

    expect(ready.map((issue) => issue.number)).toEqual([1, 2]);
    expect(server.countRequests("GetProjectIssuesPage")).toBe(1);
  });

  it("surfaces GraphQL errors distinctly from transport success", async () => {
    server.enqueueGraphQLError(
      "GetProjectIssuesPage",
      "simulated GraphQL failure",
    );

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());

    await expect(tracker.fetchReadyIssues()).rejects.toThrowError(
      /simulated GraphQL failure/i,
    );
  });

  it("claims, moves successful runs into Human Review, and completes terminal issues", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 7,
      title: "Implement Linear flow",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());

    const claimed = await tracker.claimIssue(7);
    expect(claimed?.state).toBe("In Progress");
    const claimedIssue = server.getIssue("symphony-linear", 7);
    expect(claimedIssue.stateName).toBe("In Progress");
    expect(claimedIssue.description).toContain("symphony-linear-workpad");
    expect(claimedIssue.comments).toContain(
      "Symphony claimed this issue for implementation.",
    );

    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/7", null);
    expect(lifecycle.kind).toBe("awaiting-human-review");
    expect(server.countRequests("GetProjectIssue")).toBe(2);
    const handoffIssue = server.getIssue("symphony-linear", 7);
    expect(handoffIssue.stateName).toBe("Human Review");
    expect(handoffIssue.comments).toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );

    server.addComment({
      projectSlug: "symphony-linear",
      issueNumber: 7,
      body: "Plan review: approved\n\nSummary\n- Approved to merge.",
    });
    server.updateIssueState("symphony-linear", 7, "Merging");
    expect((await tracker.inspectIssueHandoff("symphony/7")).kind).toBe(
      "awaiting-landing-command",
    );

    server.updateIssueState("symphony-linear", 7, "Done");
    expect((await tracker.inspectIssueHandoff("symphony/7")).kind).toBe(
      "handoff-ready",
    );

    await tracker.completeIssue(7);
    const completedIssue = server.getIssue("symphony-linear", 7);
    expect(completedIssue.stateName).toBe("Done");
    expect(completedIssue.comments).toContain(
      "Symphony completed this issue successfully.",
    );
  });

  it("warns when a successful run cannot move into Human Review because the project lacks that state", async () => {
    const logger = new CapturingLogger();
    server.seedProject({
      slugId: "no-review-state",
      name: "No Review State",
      states: [
        { name: "Todo", type: "unstarted" },
        { name: "In Progress", type: "started" },
        { name: "Done", type: "completed" },
        { name: "Canceled", type: "canceled" },
      ],
    });
    server.seedIssue({
      projectSlug: "no-review-state",
      number: 20,
      title: "No review column",
      stateName: "In Progress",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(
      createConfig(server, { projectSlug: "no-review-state" }),
      logger,
    );

    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/20", null);

    expect(server.getIssue("no-review-state", 20).stateName).toBe(
      "In Progress",
    );
    expect(lifecycle.kind).toBe("awaiting-human-review");
    expect(logger.warnings).toContain(
      "Linear project has no 'Human Review' state; issue will not be moved after a successful run",
    );
  });

  it("returns awaiting-human-review when a stale approved comment exists from a prior run", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 25,
      title: "Fresh run after older approval",
      stateName: "In Progress",
      assigneeEmail: "worker@example.test",
    });
    server.addComment({
      projectSlug: "symphony-linear",
      issueNumber: 25,
      body: "Plan review: approved\n\nSummary\n- Approved to merge.",
      createdAt: "2026-03-10T00:00:00.000Z",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/25", null);

    expect(server.getIssue("symphony-linear", 25).stateName).toBe(
      "Human Review",
    );
    expect(lifecycle.kind).toBe("awaiting-human-review");
  });

  it("maps configured plan-review markers into the shared Linear handoff lifecycle", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 26,
      title: "Custom review protocol",
      stateName: "Human Review",
      assigneeEmail: "worker@example.test",
    });
    server.addComment({
      projectSlug: "symphony-linear",
      issueNumber: 26,
      body: "Review verdict: ship-it\n\nSummary\n- Approved to merge.",
    });

    const tracker = new LinearTracker(
      createConfig(server, {
        planReview: customPlanReview,
      }),
      new JsonLogger(),
    );
    const lifecycle = await tracker.inspectIssueHandoff("symphony/26");

    expect(lifecycle.kind).toBe("awaiting-landing-command");
  });

  it("does not move a successful run backward from Rework into Human Review", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 21,
      title: "Manual rework handoff",
      stateName: "Rework",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/21", null);

    expect(server.getIssue("symphony-linear", 21).stateName).toBe("Rework");
    expect(server.getIssue("symphony-linear", 21).comments).not.toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );
    expect(lifecycle.kind).toBe("rework-required");
  });

  it("does not post a duplicate handoff-ready comment when a successful run is already in Human Review", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 24,
      title: "Already waiting for review",
      stateName: "Human Review",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/24", null);

    expect(server.getIssue("symphony-linear", 24).stateName).toBe(
      "Human Review",
    );
    expect(server.getIssue("symphony-linear", 24).comments).not.toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );
    expect(lifecycle.kind).toBe("awaiting-human-review");
  });

  it("does not move a successful run backward from Merging into Human Review", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 22,
      title: "Manual merge handoff",
      stateName: "Merging",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/22", null);

    expect(server.getIssue("symphony-linear", 22).stateName).toBe("Merging");
    expect(server.getIssue("symphony-linear", 22).comments).not.toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );
    expect(lifecycle.kind).toBe("awaiting-landing-command");
  });

  it("does not move a successful run backward from Done into Human Review", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 23,
      title: "Manual terminal handoff",
      stateName: "Done",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.reconcileSuccessfulRun("symphony/23", null);

    expect(server.getIssue("symphony-linear", 23).stateName).toBe("Done");
    expect(server.getIssue("symphony-linear", 23).comments).not.toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );
    expect(lifecycle.kind).toBe("handoff-ready");
  });

  it("marks failed issues in the workpad and exposes them via fetchFailedIssues", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 9,
      title: "Broken issue",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());

    await tracker.markIssueFailed(9, "runner exited with 1");
    const failed = await tracker.fetchFailedIssues();

    expect(failed.map((issue) => issue.number)).toEqual([9]);
    expect(server.getIssue("symphony-linear", 9).comments).toContain(
      "Symphony failed this run: runner exited with 1",
    );
  });

  it("fails loudly when the configured claim state is missing from the project workflow", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 10,
      title: "Issue 10",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(
      createConfig(server, {
        activeStates: ["Todo", "Working"],
      }),
      new JsonLogger(),
    );

    await expect(tracker.claimIssue(10)).rejects.toThrowError(
      /Linear project symphony-linear is missing configured state 'Working'/i,
    );
  });

  it("fails loudly when the configured terminal states are absent from the project workflow", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 11,
      title: "Issue 11",
      stateName: "In Progress",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(
      createConfig(server, {
        terminalStates: ["Closed"],
      }),
      new JsonLogger(),
    );

    await expect(tracker.completeIssue(11)).rejects.toThrowError(
      /Linear project symphony-linear does not expose any configured terminal state/i,
    );
  });

  it("matches configured active and terminal states case-insensitively", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 18,
      title: "Case insensitive workflow config",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(
      createConfig(server, {
        activeStates: ["todo", "in progress"],
        terminalStates: ["done", "canceled"],
      }),
      new JsonLogger(),
    );

    const claimed = await tracker.claimIssue(18);
    expect(claimed?.state).toBe("In Progress");

    await tracker.completeIssue(18);

    const completedIssue = server.getIssue("symphony-linear", 18);
    expect(completedIssue.stateName).toBe("Done");
    expect((await tracker.inspectIssueHandoff("symphony/18")).kind).toBe(
      "handoff-ready",
    );
  });

  it("updates only the workpad when completeIssue is called on an already-terminal issue", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 19,
      title: "Already done",
      stateName: "Done",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());

    await tracker.completeIssue(19);

    expect(server.getIssue("symphony-linear", 19).stateName).toBe("Done");
    expect(server.countRequests("UpdateIssueDescription")).toBe(1);
    expect(server.countRequests("UpdateIssueState")).toBe(0);
    expect(server.countRequests("UpdateIssueDescriptionAndState")).toBe(0);
  });

  it("maps Human Review to awaiting-human-review", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 12,
      title: "Waiting for review",
      stateName: "Human Review",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/12");

    expect(lifecycle.kind).toBe("awaiting-human-review");
  });

  it("maps Human Review with changes-requested to rework-required", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 13,
      title: "Needs revision",
      stateName: "Human Review",
      assigneeEmail: "worker@example.test",
    });
    server.addComment({
      projectSlug: "symphony-linear",
      issueNumber: 13,
      body: "Plan review: changes-requested\n\nRequired changes\n- Rework the policy.",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/13");

    expect(lifecycle.kind).toBe("rework-required");
  });

  it("maps Rework to rework-required", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 14,
      title: "Explicit rework",
      stateName: "Rework",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/14");

    expect(lifecycle.kind).toBe("rework-required");
  });

  it("maps Merging to awaiting-landing-command", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 15,
      title: "Landing in progress",
      stateName: "Merging",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/15");

    expect(lifecycle.kind).toBe("awaiting-landing-command");
  });

  it("maps active states to missing-target before a handoff marker exists", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 16,
      title: "Still coding",
      stateName: "In Progress",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/16");

    expect(lifecycle.kind).toBe("missing-target");
  });

  it("maps configured terminal states to handoff-ready", async () => {
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 17,
      title: "Ready to complete",
      stateName: "Done",
      assigneeEmail: "worker@example.test",
    });

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const lifecycle = await tracker.inspectIssueHandoff("symphony/17");

    expect(lifecycle.kind).toBe("handoff-ready");
  });
});
