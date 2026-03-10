import { describe, expect, it } from "vitest";
import {
  createLinearHandoffLifecycle,
  extractIssueNumberFromBranchName,
  resolveLinearClaimStateName,
  resolveLinearHumanReviewStateName,
  resolveLinearTerminalStateName,
} from "../../src/tracker/linear-policy.js";
import type {
  LinearComment,
  LinearIssueSnapshot,
  LinearProjectSnapshot,
} from "../../src/tracker/linear-normalize.js";
import { writeLinearWorkpad } from "../../src/tracker/linear-workpad.js";

const PROJECT: LinearProjectSnapshot = {
  id: "project-1",
  slugId: "symphony-linear",
  name: "Symphony Linear",
  states: [
    {
      id: "state-todo",
      name: "Todo",
      type: "unstarted",
      position: 0,
    },
    {
      id: "state-in-progress",
      name: "In Progress",
      type: "started",
      position: 1,
    },
    {
      id: "state-done",
      name: "Done",
      type: "completed",
      position: 5,
    },
    {
      id: "state-human-review",
      name: "Human Review",
      type: "started",
      position: 2,
    },
    {
      id: "state-rework",
      name: "Rework",
      type: "started",
      position: 3,
    },
    {
      id: "state-merging",
      name: "Merging",
      type: "started",
      position: 4,
    },
  ],
};

function createIssue(
  stateName: string,
  options: {
    readonly comments?: readonly LinearComment[];
    readonly workpadStatus?: "handoff-ready" | "completed";
  } = {},
): LinearIssueSnapshot {
  const description =
    options.workpadStatus === undefined
      ? ""
      : writeLinearWorkpad("", {
          status: options.workpadStatus,
          summary: "Ready for review",
          branchName: "symphony/1",
          updatedAt: "2026-03-10T00:00:00.000Z",
        });
  return {
    id: "issue-1",
    identifier: "SYM-1",
    number: 1,
    title: "Issue 1",
    description,
    priority: null,
    branchName: null,
    url: "https://linear.example/SYM-1",
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    state: PROJECT.states.find((state) => state.name === stateName)!,
    assignee: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    comments: options.comments ?? [],
    workpad:
      options.workpadStatus === undefined
        ? null
        : {
            status: options.workpadStatus,
            summary: "Ready for review",
            branchName: "symphony/1",
            updatedAt: "2026-03-10T00:00:00.000Z",
          },
    runtimeIssue: {
      id: "issue-1",
      identifier: "SYM-1",
      number: 1,
      title: "Issue 1",
      description,
      labels: [],
      state: stateName,
      url: "https://linear.example/SYM-1",
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
    },
  };
}

describe("extractIssueNumberFromBranchName", () => {
  it("reads issue numbers from the standard symphony branch format", () => {
    expect(extractIssueNumberFromBranchName("symphony/70")).toBe(70);
  });

  it("reads issue numbers when the branch leaf carries a slug suffix", () => {
    expect(
      extractIssueNumberFromBranchName("symphony/70-linear-mocked-integration"),
    ).toBe(70);
  });

  it("returns null when the branch leaf does not start with an issue number", () => {
    expect(extractIssueNumberFromBranchName("symphony/linear-70")).toBeNull();
  });
});

describe("createLinearHandoffLifecycle", () => {
  const config = {
    kind: "linear" as const,
    endpoint: "https://linear.example/graphql",
    apiKey: "token",
    projectSlug: "symphony-linear",
    assignee: null,
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done"],
  };

  it("maps Human Review to awaiting-human-handoff", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Human Review"),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("awaiting-human-handoff");
  });

  it("maps Human Review with changes-requested to actionable-follow-up", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Human Review", {
        comments: [
          createComment(
            "Plan review: changes-requested\n\nRequired changes\n- Fix it.",
          ),
        ],
      }),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("actionable-follow-up");
  });

  it("maps handoff-ready workpad plus approved review to awaiting-system-checks", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("In Progress", {
        workpadStatus: "handoff-ready",
        comments: [
          createComment("Plan review: approved\n\nSummary\n- Approved."),
        ],
      }),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("awaiting-system-checks");
  });

  it("maps Rework to actionable-follow-up", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Rework"),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("actionable-follow-up");
  });

  it("maps Merging to awaiting-system-checks", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Merging"),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("awaiting-system-checks");
  });

  it("maps configured active states to missing-target before handoff", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("In Progress"),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("missing-target");
  });

  it("maps configured terminal states to handoff-ready", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Done"),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("handoff-ready");
  });

  it("matches configured state names case-insensitively", () => {
    const lowercaseConfig = {
      ...config,
      activeStates: ["todo", "in progress"],
      terminalStates: ["done"],
    };

    expect(
      createLinearHandoffLifecycle(
        createIssue("In Progress"),
        "symphony/1",
        lowercaseConfig,
      ).kind,
    ).toBe("missing-target");
    expect(
      createLinearHandoffLifecycle(
        createIssue("Done"),
        "symphony/1",
        lowercaseConfig,
      ).kind,
    ).toBe("handoff-ready");
  });

  it("uses comment order when review signals share the same timestamp", () => {
    const lifecycle = createLinearHandoffLifecycle(
      createIssue("Human Review", {
        comments: [
          createComment("Plan review: approved", {
            id: "comment-z",
            createdAt: "2026-03-10T00:00:00.000Z",
          }),
          createComment("Plan review: changes-requested", {
            id: "comment-a",
            createdAt: "2026-03-10T00:00:00.000Z",
          }),
        ],
      }),
      "symphony/1",
      config,
    );

    expect(lifecycle.kind).toBe("actionable-follow-up");
  });
});

describe("resolveLinearClaimStateName", () => {
  it("returns the next configured active state name", () => {
    expect(
      resolveLinearClaimStateName(createIssue("Todo"), {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
      }),
    ).toBe("In Progress");
  });

  it("returns null when the current state is outside the configured active list", () => {
    expect(
      resolveLinearClaimStateName(createIssue("Done"), {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
      }),
    ).toBeNull();
  });

  it("returns null when the current state is the last configured active state", () => {
    expect(
      resolveLinearClaimStateName(createIssue("In Progress"), {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
      }),
    ).toBeNull();
  });

  it("returns null when the next configured active state would be a duplicate no-op even across case differences", () => {
    expect(
      resolveLinearClaimStateName(createIssue("In Progress"), {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "in progress", "IN PROGRESS"],
        terminalStates: ["Done"],
      }),
    ).toBeNull();
  });
});

describe("resolveLinearTerminalStateName", () => {
  it("returns the first configured terminal state that exists in the project", () => {
    expect(
      resolveLinearTerminalStateName(PROJECT, {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Closed", "Done"],
      }),
    ).toBe("Done");
  });

  it("matches configured terminal states case-insensitively", () => {
    expect(
      resolveLinearTerminalStateName(PROJECT, {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["closed", "done"],
      }),
    ).toBe("Done");
  });

  it("fails clearly when the project exposes none of the configured terminal states", () => {
    expect(() =>
      resolveLinearTerminalStateName(PROJECT, {
        kind: "linear",
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "symphony-linear",
        assignee: null,
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Closed"],
      }),
    ).toThrowError(
      /Linear project symphony-linear does not expose any configured terminal state/i,
    );
  });
});

describe("resolveLinearHumanReviewStateName", () => {
  it("returns Human Review when the project exposes that state", () => {
    expect(resolveLinearHumanReviewStateName(PROJECT)).toBe("Human Review");
  });
});

function createComment(
  body: string,
  overrides: Partial<LinearComment> = {},
): LinearComment {
  return {
    id: body,
    body,
    createdAt: "2026-03-10T00:00:00.000Z",
    userName: "Reviewer",
    userEmail: "reviewer@example.test",
    ...overrides,
  };
}
