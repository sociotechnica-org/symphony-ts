import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinearTrackerConfig } from "../../src/domain/workflow.js";
import { LinearClient } from "../../src/tracker/linear-client.js";
import { normalizeLinearProject } from "../../src/tracker/linear-normalize.js";
import { LinearIssueWriter } from "../../src/tracker/linear-write.js";
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

describe("LinearIssueWriter", () => {
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

  it("creates Linear comments through the focused write seam", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 7,
      title: "Issue 7",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });

    const updated = await writer.createComment(issue.id, "Tracked");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]?.body).toBe("Tracked");
    expect(server.getIssue("symphony-linear", 7).comments).toContain("Tracked");
  });

  it("updates issue description and state by configured state name", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 8,
      title: "Issue 8",
      description: "Before",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });
    const projectResult = await client.fetchProject();
    if (projectResult.project === null) {
      throw new Error("expected seeded project");
    }
    const project = normalizeLinearProject(projectResult.project);

    const updated = await writer.updateIssue(
      {
        id: issue.id,
        description: "After",
        stateName: "In Progress",
      },
      project,
    );
    const request = server.requests("UpdateIssueDescriptionAndState")[0];

    expect(updated.description).toBe("After");
    expect(updated.state.name).toBe("In Progress");
    expect(server.getIssue("symphony-linear", 8).description).toBe("After");
    expect(server.getIssue("symphony-linear", 8).stateName).toBe("In Progress");
    expect(request?.variables).toMatchObject({
      id: issue.id,
      description: "After",
    });
    expect(typeof request?.variables["stateId"]).toBe("string");
  });

  it("updates issue description without requiring a project snapshot", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 11,
      title: "Issue 11",
      description: "Before",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });

    const updated = await writer.updateIssue({
      id: issue.id,
      description: "After only",
    });
    const request = server.requests("UpdateIssueDescription")[0];

    expect(updated.description).toBe("After only");
    expect(updated.state.name).toBe("Todo");
    expect(server.getIssue("symphony-linear", 11).description).toBe(
      "After only",
    );
    expect(server.countRequests("GetProject")).toBe(0);
    expect(request?.variables).toEqual({
      id: issue.id,
      description: "After only",
    });
  });

  it("surfaces failed comment writes without leaking GraphQL parsing details", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 9,
      title: "Issue 9",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });
    server.enqueueGraphQLError("CreateComment", "simulated comment failure");

    await expect(
      writer.createComment(issue.id, "Tracked"),
    ).rejects.toThrowError(/CreateComment: simulated comment failure/i);
  });

  it("surfaces failed issue updates without leaking GraphQL parsing details", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 10,
      title: "Issue 10",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });
    const projectResult = await client.fetchProject();
    if (projectResult.project === null) {
      throw new Error("expected seeded project");
    }
    const project = normalizeLinearProject(projectResult.project);
    server.enqueueGraphQLError("UpdateIssueState", "simulated update failure");

    await expect(
      writer.updateIssue(
        {
          id: issue.id,
          stateName: "In Progress",
        },
        project,
      ),
    ).rejects.toThrowError(/UpdateIssueState: simulated update failure/i);
  });

  it("fails fast when no issue fields are provided", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 12,
      title: "Issue 12",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));
    const writer = new LinearIssueWriter(client, {
      configuredAssignee: "worker@example.test",
    });

    await expect(
      writer.updateIssue({
        id: issue.id,
      }),
    ).rejects.toThrowError(/Linear issue update requires at least one field/i);
    expect(server.countRequests("UpdateIssue")).toBe(0);
    expect(server.countRequests("UpdateIssueDescription")).toBe(0);
    expect(server.countRequests("UpdateIssueState")).toBe(0);
    expect(server.countRequests("UpdateIssueDescriptionAndState")).toBe(0);
  });
});
