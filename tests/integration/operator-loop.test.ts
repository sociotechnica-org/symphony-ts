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
  readonly standingContextPath: string;
  readonly wakeUpLogPath: string;
  readonly legacyScratchpadPath: string;
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
    standingContextPath: paths.standingContextPath,
    wakeUpLogPath: paths.wakeUpLogPath,
    legacyScratchpadPath: paths.legacyScratchpadPath,
    logFile: statusJson.lastCycle.logFile,
  };
}

async function runOperatorLoopWithCommand(
  workflowPath: string,
  command: string,
): Promise<void> {
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
        SYMPHONY_OPERATOR_COMMAND: command,
      },
    },
  );
}

function buildAppendWakeUpLogCommand(entryTitle: string): string {
  const entry = `\n## ${entryTitle}\n- Appended by integration test.\n`;
  const program = `const fs = require("node:fs"); fs.appendFileSync(process.env.SYMPHONY_OPERATOR_WAKE_UP_LOG, ${JSON.stringify(entry)});`;
  return `node -e ${JSON.stringify(program)}`;
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
        readonly standingContext: string;
        readonly wakeUpLog: string;
      };
      const statusMd = await fs.readFile(run.statusMdPath, "utf8");

      expect(run.stateRoot.startsWith(ralphInstancesRoot)).toBe(true);
      expect(statusJson.state).toBe("idle");
      expect(statusJson.selectedWorkflowPath).toBe(workflowPath);
      expect(statusJson.operatorStateRoot).toBe(run.stateRoot);
      expect(statusJson.standingContext).toBe(run.standingContextPath);
      expect(statusJson.wakeUpLog).toBe(run.wakeUpLogPath);
      expect(statusMd).toContain(`- Selected workflow: ${workflowPath}`);
      expect(statusMd).toContain(`- Operator state root: ${run.stateRoot}`);
      expect(statusMd).toContain(
        `- Standing context: ${run.standingContextPath}`,
      );
      expect(statusMd).toContain(`- Wake-up log: ${run.wakeUpLogPath}`);
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
      expect(await fs.readFile(firstRun.standingContextPath, "utf8")).toContain(
        "# Standing Context",
      );
      expect(await fs.readFile(firstRun.wakeUpLogPath, "utf8")).toContain(
        "# Wake-Up Log",
      );
      expect(
        await fs.readFile(secondRun.standingContextPath, "utf8"),
      ).toContain("# Standing Context");
      expect(await fs.readFile(secondRun.wakeUpLogPath, "utf8")).toContain(
        "# Wake-Up Log",
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

  it("prompts the operator to read the notebook first and review completed-run reports before other queue work", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-prompt-");
    const workflowPath = await writeWorkflow(tempDir);
    const promptCapture = path.join(tempDir, "operator-prompt.txt");

    try {
      await runOperatorLoopWithCommand(
        workflowPath,
        `cat > ${JSON.stringify(promptCapture)}`,
      );
      createdPaths.add(tempDir);
      const prompt = await fs.readFile(promptCapture, "utf8");
      const reportReviewIndex = prompt.indexOf(
        "bin/symphony-report.ts review-pending",
      );
      const queueWorkIndex = prompt.indexOf("review any active `plan-ready`");
      const standingContextIndex = prompt.indexOf(
        "SYMPHONY_OPERATOR_STANDING_CONTEXT",
      );
      const wakeUpLogIndex = prompt.indexOf("SYMPHONY_OPERATOR_WAKE_UP_LOG");
      const appendIndex = prompt.indexOf(
        "append a new timestamped journal entry",
      );

      expect(reportReviewIndex).toBeGreaterThanOrEqual(0);
      expect(queueWorkIndex).toBeGreaterThanOrEqual(0);
      expect(standingContextIndex).toBeGreaterThanOrEqual(0);
      expect(wakeUpLogIndex).toBeGreaterThanOrEqual(0);
      expect(appendIndex).toBeGreaterThanOrEqual(0);
      expect(reportReviewIndex).toBeLessThan(queueWorkIndex);
      expect(standingContextIndex).toBeLessThan(appendIndex);
      expect(prompt).toContain("bin/symphony-report.ts review-pending");
      expect(prompt).toContain("Read the instance-scoped standing context");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves standing context while later cycles append wake-up history", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-notebook-");
    const workflowPath = await writeWorkflow(tempDir);

    try {
      await runOperatorLoopWithCommand(
        workflowPath,
        buildAppendWakeUpLogCommand("Wake-up 1"),
      );
      const instanceKey = deriveSymphonyInstanceKey(path.dirname(workflowPath));
      const paths = deriveOperatorInstanceStatePaths({
        operatorRepoRoot: repoRoot,
        instanceKey,
      });

      await fs.appendFile(
        paths.standingContextPath,
        "\n## Release Queue\n- After SPIKE-001, queue FEAT-001.\n",
        "utf8",
      );

      await runOperatorLoopWithCommand(
        workflowPath,
        buildAppendWakeUpLogCommand("Wake-up 2"),
      );
      createdPaths.add(tempDir);
      createdPaths.add(paths.operatorStateRoot);

      const standingContext = await fs.readFile(
        paths.standingContextPath,
        "utf8",
      );
      const wakeUpLog = await fs.readFile(paths.wakeUpLogPath, "utf8");

      expect(standingContext).toContain("After SPIKE-001, queue FEAT-001.");
      expect(wakeUpLog).toContain("## Wake-up 1");
      expect(wakeUpLog).toContain("## Wake-up 2");
      expect(wakeUpLog.indexOf("## Wake-up 1")).toBeLessThan(
        wakeUpLog.indexOf("## Wake-up 2"),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy scratchpad content into standing context without dropping it", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-migrate-");
    const workflowPath = await writeWorkflow(tempDir);
    const instanceKey = deriveSymphonyInstanceKey(path.dirname(workflowPath));
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: repoRoot,
      instanceKey,
    });

    try {
      await fs.mkdir(paths.operatorStateRoot, { recursive: true });
      await fs.writeFile(
        paths.legacyScratchpadPath,
        "# Operator Scratchpad\n\n- Preserve release sequencing notes.\n",
        "utf8",
      );

      await runOperatorLoop(workflowPath);
      createdPaths.add(tempDir);
      createdPaths.add(paths.operatorStateRoot);

      const standingContext = await fs.readFile(
        paths.standingContextPath,
        "utf8",
      );
      const wakeUpLog = await fs.readFile(paths.wakeUpLogPath, "utf8");
      const legacyScratchpad = await fs.readFile(
        paths.legacyScratchpadPath,
        "utf8",
      );

      expect(standingContext).toContain("## Migrated Legacy Scratchpad");
      expect(standingContext).toContain("Preserve release sequencing notes.");
      expect(wakeUpLog).toContain("## Migration Note");
      expect(legacyScratchpad).toContain("# Operator Scratchpad");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
