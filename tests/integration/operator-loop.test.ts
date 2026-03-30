import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceKey,
} from "../../src/domain/instance-identity.js";
import { writeOperatorReleaseState } from "../../src/observability/operator-release-state.js";
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
  readonly releaseStatePath: string;
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
    releaseStatePath: paths.releaseStatePath,
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

async function writeIssueSummary(args: {
  readonly workflowPath: string;
  readonly issueNumber: number;
  readonly currentOutcome: string;
}): Promise<void> {
  const issueRoot = path.join(
    path.dirname(args.workflowPath),
    ".var",
    "factory",
    "issues",
    args.issueNumber.toString(),
  );
  await fs.mkdir(issueRoot, { recursive: true });
  await fs.writeFile(
    path.join(issueRoot, "issue.json"),
    `${JSON.stringify(
      {
        version: 1,
        issueNumber: args.issueNumber,
        issueIdentifier: `sociotechnica-org/symphony-ts#${args.issueNumber.toString()}`,
        repo: "sociotechnica-org/symphony-ts",
        title: `Issue ${args.issueNumber.toString()}`,
        issueUrl: `https://github.com/sociotechnica-org/symphony-ts/issues/${args.issueNumber.toString()}`,
        branch: null,
        currentOutcome: args.currentOutcome,
        currentSummary: `Outcome ${args.currentOutcome}`,
        firstObservedAt: "2026-03-30T00:00:00Z",
        lastUpdatedAt: "2026-03-30T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        latestAttemptNumber: null,
        latestSessionId: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
        readonly releaseState: {
          readonly path: string;
          readonly advancementState: string;
        };
      };
      const statusMd = await fs.readFile(run.statusMdPath, "utf8");

      expect(run.stateRoot.startsWith(ralphInstancesRoot)).toBe(true);
      expect(statusJson.state).toBe("idle");
      expect(statusJson.selectedWorkflowPath).toBe(workflowPath);
      expect(statusJson.operatorStateRoot).toBe(run.stateRoot);
      expect(statusJson.standingContext).toBe(run.standingContextPath);
      expect(statusJson.wakeUpLog).toBe(run.wakeUpLogPath);
      expect(statusJson.releaseState.path).toBe(run.releaseStatePath);
      expect(statusJson.releaseState.advancementState).toBe("unconfigured");
      expect(statusMd).toContain(`- Selected workflow: ${workflowPath}`);
      expect(statusMd).toContain(`- Operator state root: ${run.stateRoot}`);
      expect(statusMd).toContain(
        `- Standing context: ${run.standingContextPath}`,
      );
      expect(statusMd).toContain(`- Wake-up log: ${run.wakeUpLogPath}`);
      expect(statusMd).toContain(`- Release state: ${run.releaseStatePath}`);
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
      const freshnessIndex = prompt.indexOf(
        "bin/check-factory-runtime-freshness.ts",
      );
      const reportReviewIndex = prompt.indexOf(
        "bin/symphony-report.ts review-pending",
      );
      const releaseStateIndex = prompt.indexOf(
        "bin/check-operator-release-state.ts",
      );
      const queueWorkIndex = prompt.indexOf("review any active `plan-ready`");
      const standingContextIndex = prompt.indexOf(
        "SYMPHONY_OPERATOR_STANDING_CONTEXT",
      );
      const wakeUpLogIndex = prompt.indexOf("SYMPHONY_OPERATOR_WAKE_UP_LOG");
      const appendIndex = prompt.indexOf(
        "append a new timestamped journal entry",
      );

      expect(freshnessIndex).toBeGreaterThanOrEqual(0);
      expect(reportReviewIndex).toBeGreaterThanOrEqual(0);
      expect(releaseStateIndex).toBeGreaterThanOrEqual(0);
      expect(queueWorkIndex).toBeGreaterThanOrEqual(0);
      expect(standingContextIndex).toBeGreaterThanOrEqual(0);
      expect(wakeUpLogIndex).toBeGreaterThanOrEqual(0);
      expect(appendIndex).toBeGreaterThanOrEqual(0);
      expect(freshnessIndex).toBeLessThan(reportReviewIndex);
      expect(reportReviewIndex).toBeLessThan(releaseStateIndex);
      expect(releaseStateIndex).toBeLessThan(queueWorkIndex);
      expect(prompt).toContain("bin/check-factory-runtime-freshness.ts");
      expect(standingContextIndex).toBeLessThan(appendIndex);
      expect(prompt).toContain("bin/symphony-report.ts review-pending");
      expect(prompt).toContain("bin/check-operator-release-state.ts");
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
      const releaseState = JSON.parse(
        await fs.readFile(paths.releaseStatePath, "utf8"),
      ) as {
        readonly evaluation: {
          readonly advancementState: string;
        };
      };

      expect(standingContext).toContain("## Migrated Legacy Scratchpad");
      expect(standingContext).toContain("Preserve release sequencing notes.");
      expect(wakeUpLog).toContain("## Migration Note");
      expect(legacyScratchpad).toContain("# Operator Scratchpad");
      expect(releaseState.evaluation.advancementState).toBe("unconfigured");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the operator loop running when release-state refresh fails", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-release-fail-");
    const workflowPath = await writeWorkflow(tempDir);
    const markerPath = path.join(tempDir, "operator-ran.txt");
    const instanceKey = deriveSymphonyInstanceKey(path.dirname(workflowPath));
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: repoRoot,
      instanceKey,
    });

    try {
      const malformedIssueRoot = path.join(
        path.dirname(workflowPath),
        ".var",
        "factory",
        "issues",
        "111",
      );
      await fs.mkdir(malformedIssueRoot, { recursive: true });
      await fs.writeFile(
        path.join(malformedIssueRoot, "issue.json"),
        '{"issueNumber":"bad"}\n',
        "utf8",
      );

      await runOperatorLoopWithCommand(
        workflowPath,
        `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran\\n")`)}`,
      );
      createdPaths.add(tempDir);
      createdPaths.add(paths.operatorStateRoot);

      const statusJson = JSON.parse(
        await fs.readFile(paths.statusJsonPath, "utf8"),
      ) as {
        readonly state: string;
        readonly lastCycle: {
          readonly exitCode: number | null;
        };
        readonly releaseState: {
          readonly advancementState: string;
          readonly summary: string;
        };
      };
      const statusMd = await fs.readFile(paths.statusMdPath, "utf8");

      expect(await fs.readFile(markerPath, "utf8")).toContain("ran");
      expect(statusJson.state).toBe("idle");
      expect(statusJson.lastCycle.exitCode).toBe(0);
      expect(statusJson.releaseState.advancementState).toBe("unavailable");
      expect(statusJson.releaseState.summary).toContain(
        "Release state refresh failed:",
      );
      expect(statusJson.releaseState.summary).toContain(
        "Malformed issue summary",
      );
      expect(statusMd).toContain("- Release advancement state: unavailable");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces blocked prerequisite release state in operator status artifacts", async () => {
    const tempDir = await createTempDir("symphony-operator-loop-release-");
    const workflowPath = await writeWorkflow(tempDir);
    const instanceKey = deriveSymphonyInstanceKey(path.dirname(workflowPath));
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: repoRoot,
      instanceKey,
    });

    try {
      await fs.mkdir(paths.operatorStateRoot, { recursive: true });
      await writeOperatorReleaseState(paths.releaseStatePath, {
        version: 1,
        updatedAt: "2026-03-30T00:00:00Z",
        configuration: {
          releaseId: "context-library-bun-migration",
          dependencies: [
            {
              prerequisite: {
                issueNumber: 111,
                issueIdentifier: "sociotechnica-org/symphony-ts#111",
                title: "Issue 111",
              },
              downstream: [
                {
                  issueNumber: 112,
                  issueIdentifier: "sociotechnica-org/symphony-ts#112",
                  title: "Issue 112",
                },
              ],
            },
          ],
        },
        evaluation: {
          advancementState: "configured-clear",
          summary: "Initial value",
          evaluatedAt: "2026-03-30T00:00:00Z",
          blockingPrerequisite: null,
          blockedDownstream: [],
          unresolvedReferences: [],
        },
      });
      await writeIssueSummary({
        workflowPath,
        issueNumber: 111,
        currentOutcome: "failed",
      });
      await writeIssueSummary({
        workflowPath,
        issueNumber: 112,
        currentOutcome: "awaiting-landing-command",
      });

      const run = await runOperatorLoop(workflowPath);
      createdPaths.add(tempDir);
      createdPaths.add(paths.operatorStateRoot);
      if (run.logFile !== null) {
        createdPaths.add(run.logFile);
      }

      const statusJson = JSON.parse(
        await fs.readFile(run.statusJsonPath, "utf8"),
      ) as {
        readonly releaseState: {
          readonly path: string;
          readonly releaseId: string | null;
          readonly advancementState: string;
          readonly summary: string;
          readonly blockingPrerequisiteNumber: number | null;
        };
      };
      const statusMd = await fs.readFile(run.statusMdPath, "utf8");

      expect(statusJson.releaseState.path).toBe(paths.releaseStatePath);
      expect(statusJson.releaseState.releaseId).toBe(
        "context-library-bun-migration",
      );
      expect(statusJson.releaseState.advancementState).toBe(
        "blocked-by-prerequisite-failure",
      );
      expect(statusJson.releaseState.blockingPrerequisiteNumber).toBe(111);
      expect(statusJson.releaseState.summary).toContain("#111");
      expect(statusMd).toContain(
        "- Release advancement state: blocked-by-prerequisite-failure",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
