import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

describe("parseArgs", () => {
  it("parses the run command", () => {
    const args = parseArgs(["node", "symphony", "run", "--once"]);
    expect(args.command).toBe("run");
    expect(args.once).toBe(true);
  });

  it("fails when the run command is missing", () => {
    expect(() => parseArgs(["node", "symphony"])).toThrowError(
      "Usage: symphony run [--once] [--workflow <path>]",
    );
  });
});
