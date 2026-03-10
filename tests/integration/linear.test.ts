import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
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
    ...overrides,
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
      labels: ["Backend"],
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
    expect(ready[1]?.labels).toEqual(["needs review"]);
    expect(server.countRequests("GetProjectIssuesPage")).toBe(2);
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
});
