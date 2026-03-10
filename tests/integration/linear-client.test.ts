import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinearTrackerConfig } from "../../src/domain/workflow.js";
import { LinearClient } from "../../src/tracker/linear-client.js";
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

describe("LinearClient", () => {
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

  it("sends the configured auth headers and returns the typed project payload", async () => {
    const client = new LinearClient(createConfig(server));

    const result = await client.fetchProject();
    const request = server.requests("GetProject")[0];

    expect(result.project?.slugId).toBe("symphony-linear");
    expect(request?.authorization).toBe("Bearer linear-token");
    expect(request?.contentType).toBe("application/json");
    expect(request?.variables).toEqual({ slugId: "symphony-linear" });
  });

  it("fetches project issues across multiple pages inside the client", async () => {
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

    const client = new LinearClient(createConfig(server));
    const result = await client.fetchProjectIssues();

    expect(result.project.slugId).toBe("symphony-linear");
    expect(result.issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
    // The mock Linear server pages two issues at a time, so 3 seeded issues require 2 requests.
    expect(server.countRequests("GetProjectIssuesPage")).toBe(2);
  });

  it("stops pagination defensively when Linear omits the next-page cursor", async () => {
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

    const client = new LinearClient(createConfig(server));
    const result = await client.fetchProjectIssues();

    // The first mock page returns issues 1 and 2; the client stops when hasNextPage=true but endCursor=null.
    expect(result.issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(server.countRequests("GetProjectIssuesPage")).toBe(1);
  });

  it("returns typed project issue and mutation payloads", async () => {
    const issue = server.seedIssue({
      projectSlug: "symphony-linear",
      number: 7,
      title: "Issue 7",
      description: "Before",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
    });
    const client = new LinearClient(createConfig(server));

    const projectIssue = await client.fetchProjectIssue(7);
    const updateResult = await client.updateIssue({
      id: issue.id,
      description: "After",
    });
    const commentResult = await client.createComment(issue.id, "Tracked");

    expect(projectIssue.project?.issue?.number).toBe(7);
    expect(updateResult.issueUpdate.success).toBe(true);
    expect(updateResult.issueUpdate.issue?.description).toBe("After");
    expect(commentResult.commentCreate.success).toBe(true);
    expect(commentResult.commentCreate.issue?.comments.nodes).toHaveLength(1);
    expect(server.getIssue("symphony-linear", 7).comments).toContain("Tracked");
  });

  it("surfaces GraphQL errors distinctly from HTTP failures", async () => {
    const client = new LinearClient(createConfig(server));
    server.enqueueGraphQLError("GetProject", "simulated GraphQL failure");

    await expect(client.fetchProject()).rejects.toThrowError(
      /GetProject: simulated GraphQL failure/i,
    );
  });

  it("surfaces HTTP failures with the operation name", async () => {
    const client = new LinearClient(createConfig(server));
    server.enqueueHttpError("GetProject", 503, { error: "outage" });

    await expect(client.fetchProject()).rejects.toThrowError(
      /GetProject: HTTP 503/i,
    );
  });

  it("surfaces transport failures deterministically", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("simulated transport failure");
    };
    const client = new LinearClient(createConfig(server), {
      fetch: failingFetch,
    });

    await expect(client.fetchProject()).rejects.toThrowError(
      /GetProject: simulated transport failure/i,
    );
  });

  it("surfaces non-Error transport failures deterministically", async () => {
    const failingFetch: typeof fetch = async () => {
      throw "simulated string transport failure";
    };
    const client = new LinearClient(createConfig(server), {
      fetch: failingFetch,
    });

    await expect(client.fetchProject()).rejects.toThrowError(
      /GetProject: simulated string transport failure/i,
    );
  });

  it("turns malformed paginated payloads into TrackerError failures", async () => {
    const malformedFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            project: {
              id: "project-1",
              slugId: "symphony-linear",
              name: "Symphony Linear",
              states: { nodes: [] },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    const client = new LinearClient(createConfig(server), {
      fetch: malformedFetch,
    });

    await expect(client.fetchProjectIssues()).rejects.toThrowError(
      /GetProjectIssuesPage\.data\.project\.issues/i,
    );
  });
});
