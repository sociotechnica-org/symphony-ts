import { describe, expect, it } from "vitest";
import {
  parseLinearWorkpad,
  writeLinearWorkpad,
} from "../../src/tracker/linear-workpad.js";

describe("linear-workpad", () => {
  it("round-trips the Symphony workpad while preserving surrounding text", () => {
    const description = ["# Work item", "", "Keep this content."].join("\n");

    const next = writeLinearWorkpad(description, {
      status: "running",
      summary: "Claimed by Symphony",
      branchName: "symphony/70",
      updatedAt: "2026-03-10T12:00:00.000Z",
    });

    expect(next).toContain("Keep this content.");
    expect(parseLinearWorkpad(next)).toEqual({
      status: "running",
      summary: "Claimed by Symphony",
      branchName: "symphony/70",
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
  });
});
