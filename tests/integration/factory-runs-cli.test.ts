import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import {
  deriveFactoryRunsPublicationId,
  publishIssueToFactoryRuns,
} from "../../src/integration/factory-runs.js";
import {
  deriveIssueArtifactPaths,
  type IssueArtifactLogPointersDocument,
} from "../../src/observability/issue-artifacts.js";
import {
  ISSUE_REPORT_SCHEMA_VERSION,
  writeIssueReport,
} from "../../src/observability/issue-report.js";
import {
  checkoutGitBranch,
  commitAllFiles,
  createTempDir,
  initializeGitRepo,
} from "../support/git.js";
import {
  deriveReportInstance,
  downgradeIssueReportSchemaVersion,
  deriveWorkspaceRoot,
  seedFailedIssueArtifacts,
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const execFileAsync = promisify(execFile);
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

  it("publishes from the workflow checkout when the workflow lives under .tmp/factory-main", async () => {
    const instanceRoot = await createTempDir("symphony-factory-runs-runtime-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    const runtimeRoot = path.join(instanceRoot, ".tmp", "factory-main");
    tempRoots.push(instanceRoot, archiveRoot);

    await fs.mkdir(runtimeRoot, { recursive: true });
    const workflowPath = path.join(runtimeRoot, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: https://example.test
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
  review_bot_logins: []
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    backoff_ms: 0
workspace:
  root: ../../.tmp/workspaces
  repo_url: /tmp/repo.git
  branch_prefix: symphony/
  cleanup_on_success: false
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}
---
Prompt body
`,
      "utf8",
    );

    const workspaceRoot = deriveWorkspaceRoot(instanceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    await initializeGitRepo(runtimeRoot);
    await checkoutGitBranch(runtimeRoot, "symphony/44");
    await writeIssueReport(deriveReportInstance(instanceRoot), 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const runtimeHeadSha = await commitAllFiles(
      runtimeRoot,
      "seed runtime publish inputs",
    );

    await initializeGitRepo(archiveRoot);

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

    const publicationRoot = path.join(
      archiveRoot,
      "symphony-ts",
      "issues",
      "44",
      deriveFactoryRunsPublicationId("2026-03-09T10:25:30.123Z", runtimeHeadSha),
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(publicationRoot, "metadata.json"), "utf8"),
    ) as {
      readonly sourceRevision: {
        readonly checkoutPath: string;
        readonly currentBranch: string | null;
        readonly relevantSha: string | null;
      };
    };

    expect(metadata.sourceRevision.checkoutPath).toBe(runtimeRoot);
    expect(metadata.sourceRevision.currentBranch).toBe("symphony/44");
    expect(metadata.sourceRevision.relevantSha).toBe(runtimeHeadSha);
  });

  it("falls back to pointer manifests when a log is unreadable", async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const sourceRoot = await createTempDir("symphony-factory-runs-pointer-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);
    const unreadableLogPath = path.join(workspaceRoot, "logs", "runner.log");
    await fs.mkdir(path.dirname(unreadableLogPath), { recursive: true });
    await fs.writeFile(unreadableLogPath, "runner log contents\n", "utf8");

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

    const published = await (async () => {
      await fs.chmod(unreadableLogPath, 0o000);
      try {
        return await publishIssueToFactoryRuns({
          workspaceRoot,
          sourceRoot,
          archiveRoot,
          issueNumber: 44,
        });
      } finally {
        await fs.chmod(unreadableLogPath, 0o644);
      }
    })();

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

  it("falls back to a pointer manifest when copying a readable log fails", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-copyfail-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const readableLogPath = path.join(workspaceRoot, "logs", "runner.log");
    await fs.mkdir(path.dirname(readableLogPath), { recursive: true });
    await fs.writeFile(readableLogPath, "runner log contents\n", "utf8");

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const sourceHeadSha = await commitAllFiles(
      sourceRoot,
      "seed copy-failure publish inputs",
    );

    await initializeGitRepo(archiveRoot);

    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination) => {
      if (source === readableLogPath) {
        await fs.writeFile(destination, "partial log contents\n", "utf8");
        throw Object.assign(new Error("simulated copy failure"), {
          code: "EIO",
        });
      }
      await copyFile(source, destination);
    });

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
    const archivedLogPath = path.join(
      publicationRoot,
      "logs",
      encodeURIComponent(
        "sociotechnica-org/symphony-ts#44/attempt-1/session-1",
      ),
      "runner.log",
    );

    expect(published.status).toBe("partial");
    expect(published.metadata.logs.copiedCount).toBe(0);
    expect(published.metadata.logs.referencedCount).toBe(1);
    expect(published.metadata.logs.entries[0]?.note).toBe(
      "Local log file could not be copied during publication; preserved the original pointer metadata.",
    );
    await expect(fs.stat(archivedLogPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(pointerFile, "utf8")).resolves.toContain(
      "could not be copied during publication",
    );
  });

  it("keeps publication paths inside the archive root when report repo names contain traversal segments", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-traversal-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
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
    const rawReport = JSON.parse(
      await fs.readFile(generated.outputPaths.reportJsonFile, "utf8"),
    ) as {
      readonly summary: Record<string, unknown>;
    };
    await fs.writeFile(
      generated.outputPaths.reportJsonFile,
      `${JSON.stringify(
        {
          ...rawReport,
          summary: {
            ...rawReport.summary,
            repo: "owner/..",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await commitAllFiles(sourceRoot, "seed sanitized repo publish inputs");

    await initializeGitRepo(archiveRoot);

    const published = await publishIssueToFactoryRuns({
      workspaceRoot,
      sourceRoot,
      archiveRoot,
      issueNumber: 44,
    });

    const relativePublicationRoot = path.relative(
      archiveRoot,
      published.paths.publicationRoot,
    );
    const publicationStat = await fs.stat(published.paths.publicationRoot);

    expect(path.isAbsolute(relativePublicationRoot)).toBe(false);
    expect(relativePublicationRoot).not.toMatch(/^\.{2}(?:\/|\\|$)/u);
    expect(publicationStat.isDirectory()).toBe(true);
  });

  it("deduplicates session log pointers by session id and log name", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-dedupe-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const primaryLogPath = path.join(workspaceRoot, "logs", "runner.log");
    const duplicateLogPath = path.join(
      workspaceRoot,
      "logs",
      "runner-copy.log",
    );
    const artifactPaths = deriveIssueArtifactPaths(workspaceRoot, 44);
    await fs.mkdir(path.dirname(primaryLogPath), { recursive: true });
    await fs.writeFile(primaryLogPath, "primary log contents\n", "utf8");
    await fs.writeFile(duplicateLogPath, "duplicate log contents\n", "utf8");

    const logPointers = JSON.parse(
      await fs.readFile(artifactPaths.logPointersFile, "utf8"),
    ) as IssueArtifactLogPointersDocument;
    const sessionId = "sociotechnica-org/symphony-ts#44/attempt-1/session-1";
    const existingSession = logPointers.sessions[sessionId];
    if (existingSession === undefined) {
      throw new Error(`Expected log pointers for ${sessionId}`);
    }
    await fs.writeFile(
      artifactPaths.logPointersFile,
      `${JSON.stringify(
        {
          ...logPointers,
          sessions: {
            ...logPointers.sessions,
            [sessionId]: {
              ...existingSession,
              pointers: [
                {
                  name: "runner.log",
                  location: duplicateLogPath,
                  archiveLocation: "archive://runner.log",
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const sourceHeadSha = await commitAllFiles(
      sourceRoot,
      "seed deduplicated publish inputs",
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
    const archivedLogPath = path.join(
      publicationRoot,
      "logs",
      encodeURIComponent(sessionId),
      "runner.log",
    );

    expect(published.metadata.logs.copiedCount).toBe(1);
    expect(published.metadata.logs.referencedCount).toBe(0);
    expect(published.metadata.logs.entries).toHaveLength(1);
    await expect(fs.readFile(archivedLogPath, "utf8")).resolves.toBe(
      "primary log contents\n",
    );
  });

  it("captures commit-range metadata when the source remote default branch is origin/master", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-master-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    const remoteRoot = await createTempDir("symphony-factory-runs-remote-");
    const remotePath = path.join(remoteRoot, "origin.git");
    tempRoots.push(sourceRoot, archiveRoot, remoteRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await initializeGitRepo(sourceRoot, { branch: "master" });
    const baseSha = await commitAllFiles(sourceRoot, "seed master base");
    await execFileAsync("git", ["init", "--bare", "-b", "master", remotePath], {
      cwd: remoteRoot,
    });
    await execFileAsync("git", ["remote", "add", "origin", remotePath], {
      cwd: sourceRoot,
    });
    await execFileAsync("git", ["push", "-u", "origin", "master"], {
      cwd: sourceRoot,
    });

    await checkoutGitBranch(sourceRoot, "symphony/44");
    await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    const sourceHeadSha = await commitAllFiles(
      sourceRoot,
      "seed master-derived publish inputs",
    );

    await initializeGitRepo(archiveRoot);

    const published = await publishIssueToFactoryRuns({
      workspaceRoot,
      sourceRoot,
      archiveRoot,
      issueNumber: 44,
    });

    expect(published.metadata.sourceRevision.baseSha).toBe(baseSha);
    expect(published.metadata.sourceRevision.commitRange).toBe(
      `${baseSha}..${sourceHeadSha}`,
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
      `No generated issue report JSON found for issue #44 at ${path.join(sourceRoot, ".var", "reports", "issues", "44", "report.json")}; run 'symphony-report issue --issue 44' first.`,
    );

    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts", "issues", "44")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(archiveRoot, "README.md"), "utf8"),
    ).resolves.toBe("# archive\n");
    expect(workflowPath).toContain("WORKFLOW.md");
  });

  it("fails clearly when the generated report schema is stale and leaves the archive unchanged", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-stale-");
    const archiveRoot = await createTempDir("symphony-factory-runs-archive-");
    tempRoots.push(sourceRoot, archiveRoot);

    await writeReportWorkflow(sourceRoot);
    const workspaceRoot = deriveWorkspaceRoot(sourceRoot);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    await initializeGitRepo(sourceRoot);
    await checkoutGitBranch(sourceRoot, "symphony/44");
    const generated = await writeIssueReport(workspaceRoot, 44, {
      generatedAt: "2026-03-09T10:25:30.123Z",
    });
    await downgradeIssueReportSchemaVersion(
      generated.outputPaths.reportJsonFile,
    );
    await commitAllFiles(sourceRoot, "seed stale report publish inputs");

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
      `Generated issue report JSON at ${generated.outputPaths.reportJsonFile} uses schema version 1, but this build expects ${ISSUE_REPORT_SCHEMA_VERSION.toString()}; run 'symphony-report issue --issue 44' first to regenerate it.`,
    );

    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts", "issues", "44")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(archiveRoot, "README.md"), "utf8"),
    ).resolves.toBe("# archive\n");
  });

  it("cleans up empty archive directories when publication fails after staging starts", async () => {
    const sourceRoot = await createTempDir("symphony-factory-runs-cleanup-");
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
    await commitAllFiles(sourceRoot, "seed cleanup publish inputs");

    await initializeGitRepo(archiveRoot);

    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      new Error("simulated staging failure"),
    );

    await expect(
      publishIssueToFactoryRuns({
        workspaceRoot,
        sourceRoot,
        archiveRoot,
        issueNumber: 44,
      }),
    ).rejects.toThrowError("simulated staging failure");

    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts", "issues", "44")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up empty archive directories when staging directory creation fails", async () => {
    const sourceRoot = await createTempDir(
      "symphony-factory-runs-staging-mkdir-",
    );
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
    await commitAllFiles(sourceRoot, "seed staging mkdir failure inputs");

    await initializeGitRepo(archiveRoot);

    const originalMkdir = fs.mkdir.bind(fs);
    const stagingRootSuffix = path.join(
      "issues",
      "44",
      `.factory-runs.20260309T102530123Z`,
    );
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        target.includes(stagingRootSuffix) &&
        target.endsWith(".tmp")
      ) {
        await originalMkdir(path.dirname(target), { recursive: true });
        throw new Error("simulated staging mkdir failure");
      }

      return await originalMkdir(target, options);
    });

    await expect(
      publishIssueToFactoryRuns({
        workspaceRoot,
        sourceRoot,
        archiveRoot,
        issueNumber: 44,
      }),
    ).rejects.toThrowError("simulated staging mkdir failure");

    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(archiveRoot, "symphony-ts", "issues", "44")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

    expect(published.status).toBe("partial");
    expect(published.metadata.logs.status).toBe("unavailable");
    expect(published.metadata.logs.copiedCount).toBe(0);
    expect(published.metadata.logs.referencedCount).toBe(0);
    expect(published.metadata.notes).toContain(
      "No session logs were available for publication.",
    );
    expect(workflowPath).toContain("WORKFLOW.md");
  });
});
