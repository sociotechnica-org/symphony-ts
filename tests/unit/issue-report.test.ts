import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateIssueReport,
  writeIssueReport,
} from "../../src/observability/issue-report.js";
import { createTempDir } from "../support/git.js";
import {
  deriveWorkspaceRoot,
  seedSessionAnchoredPartialArtifacts,
  seedSuccessfulIssueArtifacts,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("issue report generation", () => {
  it("derives canonical report facts and markdown from complete issue artifacts", async () => {
    const tempDir = await createTempDir("symphony-issue-report-unit-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const generated = await generateIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:00:00.000Z",
    });

    expect(generated.report.summary.issueIdentifier).toBe(
      "sociotechnica-org/symphony-ts#44",
    );
    expect(generated.report.summary.outcome).toBe("succeeded");
    expect(generated.report.summary.attemptCount).toBe(1);
    expect(generated.report.summary.pullRequestCount).toBe(1);
    expect(generated.report.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "claimed",
        "plan-ready",
        "runner-spawned",
        "pr-opened",
        "succeeded",
      ]),
    );
    expect(generated.report.tokenUsage.status).toBe("unavailable");
    expect(generated.markdown).toContain("## Summary");
    expect(generated.markdown).toContain("## Timeline");
    expect(generated.markdown).toContain("## GitHub Activity");
    expect(generated.markdown).toContain("## Token Usage");
    expect(generated.markdown).toContain("## Learnings");
  });

  it("generates a partial report when issue and event artifacts are missing but session artifacts remain", async () => {
    const tempDir = await createTempDir("symphony-issue-report-partial-");
    tempRoots.push(tempDir);
    const workspaceRoot = deriveWorkspaceRoot(tempDir);
    await seedSessionAnchoredPartialArtifacts(workspaceRoot, 44);

    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T13:10:00.000Z",
    });

    expect(generated.report.summary.status).toBe("partial");
    expect(generated.report.summary.title).toBeNull();
    expect(generated.report.summary.issueIdentifier).toBeNull();
    expect(generated.report.summary.outcome).toBe("attempt-failed");
    expect(generated.report.artifacts.missingArtifacts).toEqual(
      expect.arrayContaining([
        path.join(tempDir, ".var", "factory", "issues", "44", "issue.json"),
        path.join(tempDir, ".var", "factory", "issues", "44", "events.jsonl"),
      ]),
    );
    expect(generated.markdown).toContain("Unavailable");
    expect(generated.markdown).toContain("## Operator Interventions");
    await expect(
      fs.readFile(generated.outputPaths.reportJsonFile, "utf8"),
    ).resolves.toContain('"summary"');
    await expect(
      fs.readFile(generated.outputPaths.reportMarkdownFile, "utf8"),
    ).resolves.toContain("## Artifacts");
  });
});
