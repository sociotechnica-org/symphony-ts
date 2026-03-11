import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import {
  deriveFactoryRunsPublicationId,
  publishIssueToFactoryRuns,
} from "../../src/integration/factory-runs.js";
import { writeIssueReport } from "../../src/observability/issue-report.js";
import {
  checkoutGitBranch,
  commitAllFiles,
  createTempDir,
  initializeGitRepo,
} from "../support/git.js";
import {
  deriveWorkspaceRoot,
  seedFailedIssueArtifacts,
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("factory-runs publication", () => {
  it("publishes generated issue outputs and copied logs into the archive repo", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-source-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    const workflowPath = await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const readableLogPath = path.join(workspaceRoot, "logs", "runner.log");
    await fs.mkdir(path.dirname(readableLogPath), { recursive: true });
    await fs.writeFile(readableLogPath, "runner log contents\n", "utf8");

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const sourceHeadSha = await commitAllFiles(
      sourceRoot,
      "seed publish inputs",
    );

    await initializeGitRepo(archiveRoot);

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await runReportCli([
      "node",
      "symphony-report",
      "publish",
      "--issue",
      "44",
      "--workflow",
      workflowPath,
      "--archive-root",
      archiveRoot,
    ]);

    const publicationId = deriveFactoryRunsPublicationId(
      generated.report.generatedAt,
      sourceHeadSha,
    );
    const publicationRoot = path.join(
      archiveRoot,
      "symphony-ts",
      "issues",
      "44",
      publicationId,
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(publicationRoot, "metadata.json"), "utf8"),
    ) as {
      readonly repo: string;
      readonly branchName: string;
      readonly pullRequests: readonly { readonly number: number }[];
      readonly sourceRevision: { readonly relevantSha: string | null };
      readonly logs: {
        readonly copiedCount: number;
        readonly referencedCount: number;
      };
    };

    await expect(
      fs.readFile(path.join(publicationRoot, "report.json"), "utf8"),
    ).resolves.toContain('"issueNumber": 44');
    await expect(
      fs.readFile(path.join(publicationRoot, "report.md"), "utf8"),
    ).resolves.toContain("## Summary");
    await expect(
      fs.readFile(
        path.join(
          publicationRoot,
          "logs",
          encodeURIComponent(
            "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
          ),
          "runner.log",
        ),
        "utf8",
      ),
    ).resolves.toBe("runner log contents\n");

    expect(metadata.repo).toBe("sociotechnica-org/symphony-ts");
    expect(metadata.branchName).toBe("symphony/44");
    expect(metadata.pullRequests).toContainEqual({
      number: 144,
      url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
    });
    expect(metadata.sourceRevision.relevantSha).toBe(sourceHeadSha);
    expect(metadata.logs.copiedCount).toBe(1);
    expect(metadata.logs.referencedCount).toBe(0);
    expect(stdout.join("")).toContain(`publication id: ${publicationId}`);

    await expect(
      fs.readFile(generated.outputPaths.reportJsonFile, "utf8"),
    ).resolves.toContain('"githubActivity"');
  });

  it("falls back to pointer manifests when a log cannot be copied", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-pointer-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const sourceHeadSha = await commitAllFiles(
      sourceRoot,
      "seed partial publish inputs",
    );

    await initializeGitRepo(archiveRoot);

    const published = await publishIssueToFactoryRuns({
      workspaceRoot,
      sourceRoot,
      archiveRoot,
      issueNumber: 44,
    });

    const publicationRoot = path.join(
      archiveRoot,
      "symphony-ts",
      "issues",
      "44",
      deriveFactoryRunsPublicationId("2026-03-09T10:25:30.123Z", sourceHeadSha),
    );
    const pointerFile = path.join(
      publicationRoot,
      "logs",
      encodeURIComponent(
        "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
      ),
      "runner.log.pointer.json",
    );

    expect(published.status).toBe("partial");
    await expect(fs.readFile(pointerFile, "utf8")).resolves.toContain(
      '"archiveLocation": null',
    );
    expect(published.metadata.logs.copiedCount).toBe(0);
    expect(published.metadata.logs.referencedCount).toBe(1);
    expect(published.metadata.notes).toContain(
      "Publication completed with partial log coverage; see logs.entries for per-log outcomes.",
    );
  });

  it("fails clearly when generated reports are missing and leaves the archive unchanged", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-missing-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    const workflowPath = await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    await commitAllFiles(sourceRoot, "seed raw artifacts only");

    await initializeGitRepo(archiveRoot);
    await fs.writeFile(
      path.join(archiveRoot, "README.md"),
      "# archive\n",
      "utf8",
    );

    await expect(
      publishIssueToFactoryRuns({
        workspaceRoot,
        sourceRoot,
        archiveRoot,
        issueNumber: 44,
      }),
    ).rejects.toThrowError(
      `No generated issue report found for issue #44 at ${path.join(sourceRoot, ".var", "reports", "issues", "44")}; run 'symphony-report issue --issue 44' first.`,
    );

    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts", "issues", "44")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(archiveRoot, "README.md"), "utf8"),
    ).resolves.toBe("# archive\n");
    expect(workflowPath).toContain("WORKFLOW.md");
  });

  it("publishes successfully when an issue has no session logs", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-no-logs-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    const workflowPath = await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedFailedIssueArtifacts(workspaceRoot, 44);

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T11:15:00.000Z",
    });
    await commitAllFiles(sourceRoot, "seed no-log publish inputs");

    await initializeGitRepo(archiveRoot);

    const published = await publishIssueToFactoryRuns({
      workspaceRoot,
      sourceRoot,
      archiveRoot,
      issueNumber: 44,
    });

    expect(published.status).toBe("complete");
    expect(published.metadata.logs.status).toBe("unavailable");
    expect(published.metadata.logs.copiedCount).toBe(0);
    expect(published.metadata.logs.referencedCount).toBe(0);
    expect(published.metadata.notes).toContain(
      "No session logs were available for publication.",
    );
    expect(workflowPath).toContain("WORKFLOW.md");
  });
});
