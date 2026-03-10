import { describe, expect, it } from "vitest";
import {
  extractIssueNumberFromBranchName,
  resolveLinearClaimStateName,
  resolveLinearTerminalStateName,
} from "../../src/tracker/linear-policy.js";
import type {
  LinearIssueSnapshot,
  LinearProjectSnapshot,
} from "../../src/tracker/linear-normalize.js";

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
      position: 2,
    },
  ],
};

function createIssue(stateName: string): LinearIssueSnapshot {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    number: 1,
    title: "Issue 1",
    description: "",
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
    comments: [],
    workpad: null,
    runtimeIssue: {
      id: "issue-1",
      identifier: "SYM-1",
      number: 1,
      title: "Issue 1",
      description: "",
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
