import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import type { LinearTrackerConfig } from "../../src/domain/workflow.js";
import { LinearTracker } from "../../src/tracker/linear.js";
import { MockLinearServer } from "../support/mock-linear-server.js";

function createConfig(server: MockLinearServer): LinearTrackerConfig {
  return {
    kind: "linear",
    endpoint: server.baseUrl,
    apiKey: "linear-token",
    projectSlug: "symphony-linear",
    assignee: "worker@example.test",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled"],
  };
}

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

    const tracker = new LinearTracker(createConfig(server), new JsonLogger());
    const ready = await tracker.fetchReadyIssues();

    expect(ready.map((issue) => issue.number)).toEqual([1, 2, 3]);
    expect(server.countRequests("GetProjectIssuesPage")).toBe(2);
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

  it("claims, marks handoff-ready, and completes issues against the mock server", async () => {
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
    expect(lifecycle.kind).toBe("handoff-ready");
    const handoffIssue = server.getIssue("symphony-linear", 7);
    expect(handoffIssue.comments).toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );

    await tracker.completeIssue(7);
    const completedIssue = server.getIssue("symphony-linear", 7);
    expect(completedIssue.stateName).toBe("Done");
    expect(completedIssue.comments).toContain(
      "Symphony completed this issue successfully.",
    );
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
});
