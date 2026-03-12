import { describe, expect, it } from "vitest";
import {
  createRunningEntry,
  integrateCodexUpdate,
} from "../../src/orchestrator/running-entry.js";

describe("integrateCodexUpdate", () => {
  it("increments turnCount for slash-style completed events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "turn/completed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(entry.turnCount).toBe(1);
  });

  it("increments turnCount for underscore-style completed events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "turn_completed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(entry.turnCount).toBe(1);
  });
});
