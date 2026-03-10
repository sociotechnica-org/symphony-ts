import { describe, expect, it } from "vitest";
import type { LinearProjectSnapshot } from "../../src/tracker/linear-normalize.js";
import { resolveLinearStateByName } from "../../src/tracker/linear-write.js";

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
  ],
};

describe("resolveLinearStateByName", () => {
  it("returns the matching workflow state", () => {
    expect(resolveLinearStateByName(PROJECT, "In Progress")).toEqual({
      id: "state-in-progress",
      name: "In Progress",
      type: "started",
      position: 1,
    });
  });

  it("fails clearly when the configured state is absent from the project", () => {
    expect(() => resolveLinearStateByName(PROJECT, "Done")).toThrowError(
      /Linear project symphony-linear is missing configured state 'Done'/i,
    );
  });
});
