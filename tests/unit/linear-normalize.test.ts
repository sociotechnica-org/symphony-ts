import { describe, expect, it } from "vitest";
import { normalizeLinearIssueResult } from "../../src/tracker/linear-normalize.js";

describe("normalizeLinearIssueResult", () => {
  it("throws a clear error when the project payload is missing", () => {
    expect(() =>
      normalizeLinearIssueResult({
        project: null,
      }),
    ).toThrowError(/Linear project not found in issue result/);
  });
});
