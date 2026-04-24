import { describe, expect, it } from "vitest";
import { parseDevinVerdict } from "../../src/tracker/reviewer-app-devin.js";

describe("parseDevinVerdict", () => {
  it("recognizes Devin issue summaries with singular new-issue wording", () => {
    expect(
      parseDevinVerdict(
        "**Devin Review** found 1 new potential issue.\n\nView 6 additional findings in Devin Review.",
      ),
    ).toBe("issues-found");
  });

  it("recognizes clean Devin summaries", () => {
    expect(parseDevinVerdict("## ✅ Devin Review: No Issues Found")).toBe(
      "pass",
    );
  });

  it("does not treat later no-issues text as an overriding pass", () => {
    expect(
      parseDevinVerdict(
        "## Devin Review: Found 3 potential issues\n\n---\nInfo: no issues found in main module",
      ),
    ).toBe("issues-found");
  });

  it("keeps issue findings blocking when later file coverage says no issues were found", () => {
    expect(
      parseDevinVerdict(
        "**Devin Review** found 1 new potential issue.\n\nNo issues found in 5 of 6 files reviewed.",
      ),
    ).toBe("issues-found");
  });
});
