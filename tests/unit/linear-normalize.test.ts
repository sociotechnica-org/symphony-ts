import { describe, expect, it } from "vitest";
import {
  normalizeLinearIssueResult,
  normalizeLinearIssueSnapshot,
} from "../../src/tracker/linear-normalize.js";

function createIssuePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    number: 1,
    title: "Implement normalization",
    description: "Issue body",
    priority: 2,
    branchName: "feature/linear-normalize",
    url: "https://linear.example/SYM-1",
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-02T12:00:00.000Z",
    assignee: {
      id: "user-1",
      name: "Worker Example",
      email: "worker@example.test",
    },
    labels: {
      nodes: [{ name: "Backend" }, { name: "Needs Review" }, { name: "" }],
    },
    inverseRelations: {
      nodes: [
        {
          type: "blocks",
          issue: {
            id: "issue-0",
            identifier: "SYM-0",
            title: "Upstream dependency",
            state: {
              name: "In Progress",
            },
          },
        },
        {
          type: "related",
          issue: {
            id: "issue-2",
            identifier: "SYM-2",
            title: "Non-blocker",
            state: {
              name: "Todo",
            },
          },
        },
      ],
    },
    state: {
      id: "state-1",
      name: "Todo",
      type: "unstarted",
      position: 0,
    },
    comments: {
      nodes: [
        {
          id: "comment-1",
          body: "Tracked",
          createdAt: "2026-03-02T12:05:00.000Z",
          user: {
            name: "Symphony",
            email: "symphony@example.test",
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("normalizeLinearIssueSnapshot", () => {
  it("normalizes labels, blocker relations, assignee routing, and timestamps", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload(),
      "issue",
      { configuredAssignee: "worker@example.test" },
    );

    expect(snapshot.priority).toBe(2);
    expect(snapshot.branchName).toBe("feature/linear-normalize");
    expect(snapshot.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(snapshot.updatedAt).toBe("2026-03-02T12:00:00.000Z");
    expect(snapshot.assignedToWorker).toBe(true);
    expect(snapshot.labels).toEqual(["backend", "needs review"]);
    expect(snapshot.runtimeIssue.labels).toEqual(["backend", "needs review"]);
    expect(snapshot.blockedBy).toEqual([
      {
        id: "issue-0",
        identifier: "SYM-0",
        title: "Upstream dependency",
        state: "In Progress",
      },
    ]);
  });

  it("tolerates missing optional assignee, labels, relations, and branch metadata", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload({
        description: null,
        priority: null,
        branchName: null,
        assignee: null,
        labels: null,
        inverseRelations: null,
      }),
      "issue",
      { configuredAssignee: null },
    );

    expect(snapshot.description).toBe("");
    expect(snapshot.priority).toBeNull();
    expect(snapshot.branchName).toBeNull();
    expect(snapshot.assignee).toBeNull();
    expect(snapshot.assignedToWorker).toBe(true);
    expect(snapshot.labels).toEqual([]);
    expect(snapshot.blockedBy).toEqual([]);
  });

  it("normalizes Linear priority 0 to null for unset priority", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload({ priority: 0 }),
      "issue",
    );

    expect(snapshot.priority).toBeNull();
  });

  it("marks unassigned or differently assigned issues as not routed to the worker", () => {
    const unassigned = normalizeLinearIssueSnapshot(
      createIssuePayload({ assignee: null }),
      "issue",
      { configuredAssignee: "worker@example.test" },
    );
    const differentAssignee = normalizeLinearIssueSnapshot(
      createIssuePayload({
        assignee: {
          id: "user-2",
          name: "Another Worker",
          email: "other@example.test",
        },
      }),
      "issue",
      { configuredAssignee: "worker@example.test" },
    );

    expect(unassigned.assignedToWorker).toBe(false);
    expect(differentAssignee.assignedToWorker).toBe(false);
  });

  it("accepts assignee identity matches by id as well as email", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload(),
      "issue",
      { configuredAssignee: "USER-1" },
    );

    expect(snapshot.assignedToWorker).toBe(true);
  });

  it("fails clearly when required fields are missing", () => {
    expect(() =>
      normalizeLinearIssueSnapshot(
        createIssuePayload({ identifier: null }),
        "issue",
      ),
    ).toThrowError(/issue\.identifier/i);
  });
});

describe("normalizeLinearIssueResult", () => {
  it("throws a clear error when the project payload is missing", () => {
    expect(() =>
      normalizeLinearIssueResult({
        project: null,
      }),
    ).toThrowError(/Linear project not found in issue result/);
  });
});
