import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceKey,
} from "../../src/domain/instance-identity.js";
import { createTempDir } from "../support/git.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const ralphInstancesRoot = path.join(repoRoot, ".ralph", "instances");

async function writeWorkflow(rootDir: string): Promise<string> {
  const workflowPath = path.join(rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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
  return workflowPath;
}

async function runOperatorLoop(workflowPath: string): Promise<{
  readonly stateRoot: string;
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
  readonly scratchpadPath: string;
  readonly logFile: string | null;
}> {
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

  const instanceKey = deriveSymphonyInstanceKey(path.dirname(workflowPath));
  const paths = deriveOperatorInstanceStatePaths({
    operatorRepoRoot: repoRoot,
    instanceKey,
  });
  const statusJson = JSON.parse(
    await fs.readFile(paths.statusJsonPath, "utf8"),
  ) as {
    readonly lastCycle: {
      readonly logFile: string | null;
    };
  };

  return {
    stateRoot: paths.operatorStateRoot,
    statusJsonPath: paths.statusJsonPath,
    statusMdPath: paths.statusMdPath,
    scratchpadPath: paths.scratchpadPath,
    logFile: statusJson.lastCycle.logFile,
  };
}

describe("operator loop workflow selection", () => {
  const createdPaths = new Set<string>();

  afterEach(async () => {
    for (const filePath of createdPaths) {
      await fs.rm(filePath, { recursive: true, force: true });
    }
    createdPaths.clear();
  });

  it("publishes selected workflow metadata inside the instance-scoped operator state root", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-");
    const workflowPath = await writeWorkflow(tempDir);

    try {
      const run = await runOperatorLoop(workflowPath);
      createdPaths.add(tempDir);
      createdPaths.add(run.stateRoot);
      if (run.logFile !== null) {
        createdPaths.add(run.logFile);
      }

      const statusJson = JSON.parse(
        await fs.readFile(run.statusJsonPath, "utf8"),
      ) as {
        readonly state: string;
        readonly selectedWorkflowPath: string | null;
        readonly operatorStateRoot: string;
        readonly scratchpad: string;
      };
      const statusMd = await fs.readFile(run.statusMdPath, "utf8");

      expect(run.stateRoot.startsWith(ralphInstancesRoot)).toBe(true);
      expect(statusJson.state).toBe("idle");
      expect(statusJson.selectedWorkflowPath).toBe(workflowPath);
      expect(statusJson.operatorStateRoot).toBe(run.stateRoot);
      expect(statusJson.scratchpad).toBe(run.scratchpadPath);
      expect(statusMd).toContain(`- Selected workflow: ${workflowPath}`);
      expect(statusMd).toContain(`- Operator state root: ${run.stateRoot}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("isolates operator-loop generated state per selected instance", async () => {
    const firstDir = await createTempDir("symphony-operator-loop-a-");
    const secondDir = await createTempDir("symphony-operator-loop-b-");
    const firstWorkflow = await writeWorkflow(firstDir);
    const secondWorkflow = await writeWorkflow(secondDir);

    try {
      const firstRun = await runOperatorLoop(firstWorkflow);
      const secondRun = await runOperatorLoop(secondWorkflow);
      createdPaths.add(firstDir);
      createdPaths.add(secondDir);
      createdPaths.add(firstRun.stateRoot);
      createdPaths.add(secondRun.stateRoot);
      if (firstRun.logFile !== null) {
        createdPaths.add(firstRun.logFile);
      }
      if (secondRun.logFile !== null) {
        createdPaths.add(secondRun.logFile);
      }

      expect(firstRun.stateRoot).not.toBe(secondRun.stateRoot);
      expect(await fs.readFile(firstRun.scratchpadPath, "utf8")).toContain(
        "# Operator Scratchpad",
      );
      expect(await fs.readFile(secondRun.scratchpadPath, "utf8")).toContain(
        "# Operator Scratchpad",
      );

      const firstStatus = JSON.parse(
        await fs.readFile(firstRun.statusJsonPath, "utf8"),
      ) as {
        readonly selectedWorkflowPath: string | null;
      };
      const secondStatus = JSON.parse(
        await fs.readFile(secondRun.statusJsonPath, "utf8"),
      ) as {
        readonly selectedWorkflowPath: string | null;
      };

      expect(firstStatus.selectedWorkflowPath).toBe(firstWorkflow);
      expect(secondStatus.selectedWorkflowPath).toBe(secondWorkflow);
    } finally {
      await fs.rm(firstDir, { recursive: true, force: true });
      await fs.rm(secondDir, { recursive: true, force: true });
    }
  });
});
