import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "../support/git.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const ralphDir = path.join(repoRoot, ".ralph");
const statusJsonPath = path.join(ralphDir, "status.json");
const statusMdPath = path.join(ralphDir, "status.md");
const scratchpadPath = path.join(ralphDir, "operator-scratchpad.md");

interface FileBackup {
  readonly existed: boolean;
  readonly content: string | null;
}

async function backupFile(filePath: string): Promise<FileBackup> {
  try {
    return {
      existed: true,
      content: await fs.readFile(filePath, "utf8"),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        existed: false,
        content: null,
      };
    }
    throw error;
  }
}

async function restoreFile(
  filePath: string,
  backup: FileBackup,
): Promise<void> {
  if (!backup.existed) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, backup.content ?? "", "utf8");
}

describe("operator loop workflow selection", () => {
  const createdPaths = new Set<string>();

  afterEach(async () => {
    for (const filePath of createdPaths) {
      await fs.rm(filePath, { force: true });
    }
    createdPaths.clear();
  });

  it("publishes the selected workflow path in loop status metadata", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-");
    const workflowPath = path.join(tempDir, "WORKFLOW.md");
    await fs.writeFile(workflowPath, "tracker:\n  kind: github\n", "utf8");

    const statusJsonBackup = await backupFile(statusJsonPath);
    const statusMdBackup = await backupFile(statusMdPath);
    const scratchpadBackup = await backupFile(scratchpadPath);
    let createdLogFile: string | null = null;

    try {
      await execFileAsync(
        "bash",
        [
          path.join("skills", "symphony-operator", "operator-loop.sh"),
          "--once",
          "--workflow",
          workflowPath,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            SYMPHONY_OPERATOR_COMMAND: "cat >/dev/null",
          },
        },
      );

      const statusJson = JSON.parse(
        await fs.readFile(statusJsonPath, "utf8"),
      ) as {
        readonly state: string;
        readonly selectedWorkflowPath: string | null;
        readonly lastCycle: {
          readonly logFile: string | null;
        };
      };
      const statusMd = await fs.readFile(statusMdPath, "utf8");

      createdLogFile = statusJson.lastCycle.logFile;
      if (createdLogFile !== null) {
        createdPaths.add(createdLogFile);
      }

      expect(statusJson.state).toBe("idle");
      expect(statusJson.selectedWorkflowPath).toBe(workflowPath);
      expect(statusMd).toContain(`- Selected workflow: ${workflowPath}`);
    } finally {
      await restoreFile(statusJsonPath, statusJsonBackup);
      await restoreFile(statusMdPath, statusMdBackup);
      await restoreFile(scratchpadPath, scratchpadBackup);
      await fs.rm(tempDir, { recursive: true, force: true });
      if (createdLogFile !== null) {
        await fs.rm(createdLogFile, { force: true });
      }
    }
  });
});
