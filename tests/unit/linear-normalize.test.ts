import { describe, expect, it } from "vitest";
import {
  normalizeLinearIssueResult,
  normalizeLinearIssueMutationResult,
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
    expect(snapshot.runtimeIssue.queuePriority).toBeNull();
    expect(snapshot.blockedBy).toEqual([
      {
        id: "issue-0",
        identifier: "SYM-0",
        title: "Upstream dependency",
        state: "In Progress",
      },
    ]);
  });

  it("normalizes enabled Linear priority into queue priority metadata", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload({ priority: 1 }),
      "issue",
      {
        configuredAssignee: null,
        queuePriority: { enabled: true },
      },
    );

    expect(snapshot.priority).toBe(1);
    expect(snapshot.runtimeIssue.queuePriority).toEqual({
      rank: 1,
      label: "Urgent",
    });
  });

  it("keeps queue priority null when Linear queue priority is disabled", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload({ priority: 2 }),
      "issue",
      {
        configuredAssignee: null,
        queuePriority: { enabled: false },
      },
    );

    expect(snapshot.priority).toBe(2);
    expect(snapshot.runtimeIssue.queuePriority).toBeNull();
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
    expect(snapshot.runtimeIssue.queuePriority).toBeNull();
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
    expect(snapshot.runtimeIssue.queuePriority).toBeNull();
  });

  it("silently skips a 'blocks' relation whose issue is null", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload({
        inverseRelations: {
          nodes: [{ type: "blocks", issue: null }],
        },
      }),
      "issue",
    );

    expect(snapshot.blockedBy).toEqual([]);
  });

  it("fails clearly when the priority is outside Linear's supported range", () => {
    expect(() =>
      normalizeLinearIssueSnapshot(
        createIssuePayload({ priority: 5 }),
        "issue",
      ),
    ).toThrowError(/Expected Linear priority in range 1-4 or 0/i);
  });

  it("fails clearly when the priority is not a Linear enum integer", () => {
    expect(() =>
      normalizeLinearIssueSnapshot(
        createIssuePayload({ priority: 1.5 }),
        "issue",
      ),
    ).toThrowError(/Expected Linear priority in range 1-4 or 0/i);
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
    const byId = normalizeLinearIssueSnapshot(createIssuePayload(), "issue", {
      configuredAssignee: "USER-1",
    });
    const byEmail = normalizeLinearIssueSnapshot(
      createIssuePayload(),
      "issue",
      { configuredAssignee: "worker@example.test" },
    );

    expect(byId.assignedToWorker).toBe(true);
    expect(byEmail.assignedToWorker).toBe(true);
  });

  it("does not treat assignee display names as stable routing identities", () => {
    const snapshot = normalizeLinearIssueSnapshot(
      createIssuePayload(),
      "issue",
      { configuredAssignee: "Worker Example" },
    );

    expect(snapshot.assignedToWorker).toBe(false);
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

describe("normalizeLinearIssueMutationResult", () => {
  it("throws a clear error when a mutation reports success=false", () => {
    expect(() =>
      normalizeLinearIssueMutationResult(
        {
          issueUpdate: {
            success: false,
            issue: createIssuePayload(),
          },
        },
        "issueUpdate",
      ),
    ).toThrowError(/Linear mutation issueUpdate reported success=false/i);
  });

  it("throws a clear error when a successful mutation returns no issue", () => {
    expect(() =>
      normalizeLinearIssueMutationResult(
        {
          issueUpdate: {
            success: true,
            issue: null,
          },
        },
        "issueUpdate",
      ),
    ).toThrowError(
      /Linear mutation issueUpdate reported success=true but returned no issue/i,
    );
  });
});
