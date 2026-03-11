import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveFactoryRunsPublicationId,
  deriveFactoryRunsPublicationPaths,
} from "../../src/integration/factory-runs.js";

describe("factory-runs publication helpers", () => {
  it("derives a stable filesystem-safe publication id", () => {
    expect(
      deriveFactoryRunsPublicationId(
        "2026-03-09T10:25:30.123Z",
        "abcdef1234567890abcdef1234567890abcdef12",
      ),
    ).toBe("20260309T102530123Z-abcdef12");
  });

  it("derives the expected archive layout for one issue publication", () => {
    const publicationPaths = deriveFactoryRunsPublicationPaths({
      archiveRoot: "/tmp/factory-runs",
      repoName: "symphony-ts",
      issueNumber: 45,
      publicationId: "20260309T102530123Z-abcdef12",
    });

    expect(publicationPaths.repoRoot).toBe(
      path.join("/tmp/factory-runs", "symphony-ts"),
    );
    expect(publicationPaths.issueRoot).toBe(
      path.join("/tmp/factory-runs", "symphony-ts", "issues", "45"),
    );
    expect(publicationPaths.publicationRoot).toBe(
      path.join(
        "/tmp/factory-runs",
        "symphony-ts",
        "issues",
        "45",
        "20260309T102530123Z-abcdef12",
      ),
    );
    expect(publicationPaths.metadataFile).toBe(
      path.join(
        "/tmp/factory-runs",
        "symphony-ts",
        "issues",
        "45",
        "20260309T102530123Z-abcdef12",
        "metadata.json",
      ),
    );
  });
});
