import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTerminalIssues,
  readTerminalIssueReportingReceipt,
  reconcileTerminalIssueReporting,
} from "../../src/observability/terminal-reporting.js";
import {
  commitAllFiles,
  createTempDir,
  initializeGitRepo,
} from "../support/git.js";
import {
  deriveReportInstance,
  deriveWorkspaceRoot,
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("terminal issue reporting", () => {
  it("generates the current terminal issue report when archive publication is not configured", async () => {
    const rootDir = await createTempDir("symphony-terminal-reporting-");
    tempRoots.push(rootDir);

    await writeReportWorkflow(rootDir);
    const workspaceRoot = deriveWorkspaceRoot(rootDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 44);

    const instance = deriveReportInstance(rootDir);
    const [issue] = await listTerminalIssues(instance);
    expect(issue?.issueNumber).toBe(44);

    const result = await reconcileTerminalIssueReporting({
      instance,
      issue: issue!,
      archiveRoot: null,
    });

    expect(result.receipt.state).toBe("report-generated");
    expect(result.receipt.reportJsonFile).toBe(
      path.join(rootDir, ".var", "reports", "issues", "44", "report.json"),
    );
    await expect(
      fs.readFile(result.receipt.reportJsonFile!, "utf8"),
    ).resolves.toContain('"issueNumber": 44');
    await expect(
      fs.readFile(result.receipt.reportMarkdownFile!, "utf8"),
    ).resolves.toContain("## Summary");
  });

  it("records blocked publication and then converges once the archive root is repaired", async () => {
    const rootDir = await createTempDir("symphony-terminal-reporting-publish-");
    const archiveRoot = await createTempDir(
      "symphony-terminal-reporting-archive-",
    );
    const missingArchiveRoot = path.join(rootDir, "..", "missing-factory-runs");
    tempRoots.push(rootDir, archiveRoot);

    await writeReportWorkflow(rootDir);
    const workspaceRoot = deriveWorkspaceRoot(rootDir);
    await seedSuccessfulIssueArtifacts(workspaceRoot, 45);
    const readableLogPath = path.join(workspaceRoot, "logs", "runner.log");
    await fs.mkdir(path.dirname(readableLogPath), { recursive: true });
    await fs.writeFile(readableLogPath, "runner log contents\n", "utf8");

    await initializeGitRepo(rootDir);
    await commitAllFiles(rootDir, "seed terminal reporting inputs");

    const instance = deriveReportInstance(rootDir);
    const [issue] = await listTerminalIssues(instance);
    if (issue === undefined) {
      throw new Error("Expected one terminal issue");
    }

    const blocked = await reconcileTerminalIssueReporting({
      instance,
      issue,
      archiveRoot: missingArchiveRoot,
    });
    expect(blocked.receipt.state).toBe("blocked");
    expect(blocked.receipt.blockedStage).toBe("publication");
    expect(blocked.receipt.note).toContain("Archive root does not exist");

    await initializeGitRepo(archiveRoot);
    const recovered = await reconcileTerminalIssueReporting({
      instance,
      issue,
      archiveRoot,
    });
    expect(recovered.receipt.state).toBe("published");
    expect(recovered.receipt.publicationRoot).toContain(
      path.join(archiveRoot, "symphony-ts", "issues", "45"),
    );
    await expect(
      fs.readFile(
        path.join(recovered.receipt.publicationRoot!, "report.json"),
        "utf8",
      ),
    ).resolves.toContain('"issueNumber": 45');

    const stored = await readTerminalIssueReportingReceipt(instance, 45);
    expect(stored?.state).toBe("published");
    expect(stored?.blockedStage).toBeNull();
  });
});
