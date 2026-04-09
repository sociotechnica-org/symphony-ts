import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { loadWorkflow } from "../../src/config/workflow.js";
import { createTempDir } from "../support/git.js";

async function withEnvVarUnset<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousValue = process.env[name];
  delete process.env[name];
  try {
    return await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

describe("init CLI integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a target-repo workflow whose instance paths stay rooted in the target repository", async () => {
    const tempDir = await createTempDir("symphony-init-integration-");
    const targetRepo = path.join(tempDir, "target-repo");
    await fs.mkdir(targetRepo, { recursive: true });
    const workflowPath = path.join(targetRepo, "WORKFLOW.md");
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );

    try {
      await runCli([
        "node",
        "symphony",
        "init",
        targetRepo,
        "--tracker-repo",
        "acme/widgets",
        "--runner",
        "generic-command",
      ]);

      const workflow = await withEnvVarUnset("SYMPHONY_REPO", () =>
        loadWorkflow(workflowPath),
      );
      const workflowBody = await fs.readFile(workflowPath, "utf8");
      const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
      const operatorPlaybookBody = await fs.readFile(
        operatorPlaybookPath,
        "utf8",
      );

      expect(workflow.config.workflowPath).toBe(workflowPath);
      expect(workflow.config.instance.instanceRoot).toBe(targetRepo);
      expect(workflow.config.instance.workspaceRoot).toBe(
        path.join(targetRepo, ".tmp", "workspaces"),
      );
      expect(workflow.config.instance.statusFilePath).toBe(
        path.join(targetRepo, ".tmp", "status.json"),
      );
      expect(workflowBody).toContain("kind: generic-command");
      expect(workflowBody).toContain("command: your-runner-command --print");
      expect(workflowBody).toContain(
        "ready for review by default, not as a draft",
      );
      expect(workflowBody).toContain(
        "Only use draft mode when repository instructions or explicit issue/prompt policy require it",
      );
      expect(operatorPlaybookPath).toBe(path.join(targetRepo, "OPERATOR.md"));
      expect(operatorPlaybookBody).toContain(
        "This file is the repository-owned operator policy companion to `WORKFLOW.md` and `AGENTS.md`.",
      );
      expect(operatorPlaybookBody).toContain("## Post-Merge Refresh Policy");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
