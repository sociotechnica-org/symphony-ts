import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPromptBuilder,
  loadWorkflow,
} from "../../src/config/workflow.js";
import {
  readIssueArtifactSummary,
  readIssueArtifactEvents,
} from "../../src/observability/issue-artifacts.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { readFactoryStatusSnapshot } from "../../src/observability/status.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import { LocalRunner } from "../../src/runner/local.js";
import { createTracker } from "../../src/tracker/factory.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import {
  countRemoteBranchCommits,
  createSeedRemote,
  createTempDir,
  readRemoteBranchFile,
} from "../support/git.js";
import { MockLinearServer } from "../support/mock-linear-server.js";

async function writeWorkflow(options: {
  readonly rootDir: string;
  readonly remotePath: string;
  readonly endpoint: string;
  readonly agentCommand: string;
}): Promise<string> {
  const workflowPath = path.join(options.rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  endpoint: ${options.endpoint}
  api_key: linear-token
  project_slug: symphony-linear
  assignee: worker@example.test
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
polling:
  interval_ms: 5
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 2
    backoff_ms: 0
workspace:
  root: ./.tmp/workspaces
  repo_url: ${options.remotePath}
  branch_prefix: symphony/
  cleanup_on_success: false
hooks:
  after_create: []
agent:
  command: ${options.agentCommand}
  prompt_transport: stdin
  timeout_ms: 30000
  env: {}
---
You are working on issue {{ issue.identifier }}: {{ issue.title }}.
Description: {{ issue.description }}
`,
    "utf8",
  );
  return workflowPath;
}

async function createOrchestrator(
  workflowPath: string,
): Promise<BootstrapOrchestrator> {
  const workflow = await loadWorkflow(workflowPath);
  const logger = new JsonLogger();
  const promptBuilder = createPromptBuilder(workflow);
  const tracker = createTracker(workflow.config.tracker, logger);
  const workspace = new LocalWorkspaceManager(
    workflow.config.workspace,
    workflow.config.hooks.afterCreate,
    logger,
  );
  const runner = new LocalRunner(workflow.config.agent, logger);
  return new BootstrapOrchestrator(
    workflow.config,
    promptBuilder,
    tracker,
    workspace,
    runner,
    logger,
  );
}

describe("Linear factory e2e", () => {
  let server: MockLinearServer;
  let tempDir: string;
  let remotePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("symphony-linear-e2e-");
    const remote = await createSeedRemote();
    remotePath = remote.remotePath;
    server = new MockLinearServer();
    await server.start();
    server.seedProject({
      slugId: "symphony-linear",
      name: "Symphony Linear",
      states: [
        { name: "Todo", type: "unstarted" },
        { name: "In Progress", type: "started" },
        { name: "Done", type: "completed" },
        { name: "Canceled", type: "canceled" },
      ],
    });
    server.seedIssue({
      projectSlug: "symphony-linear",
      number: 1,
      title: "Implement Linear adapter coverage",
      description: "Drive the Linear flow",
      stateName: "Todo",
      assigneeEmail: "worker@example.test",
      identifier: "SYM-1",
    });
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs a complete factory loop against mocked Linear", async () => {
    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      endpoint: server.baseUrl,
      agentCommand: `bash ${path.resolve("tests/fixtures/fake-agent-linear-success.sh")}`,
    });

    const orchestrator = await createOrchestrator(workflowPath);
    await orchestrator.runOnce();

    const issue = server.getIssue("symphony-linear", 1);
    expect(issue.stateName).toBe("Done");
    expect(issue.comments).toContain(
      "Symphony claimed this issue for implementation.",
    );
    expect(issue.comments).toContain(
      "Symphony run finished and marked this issue handoff-ready.",
    );
    expect(issue.comments).toContain(
      "Symphony completed this issue successfully.",
    );

    const artifactSummary = await readIssueArtifactSummary(
      path.join(tempDir, ".tmp", "workspaces"),
      1,
    );
    expect(artifactSummary.currentOutcome).toBe("succeeded");
    expect(artifactSummary.repo).toBe("linear/symphony-linear");

    const artifactEvents = await readIssueArtifactEvents(
      path.join(tempDir, ".tmp", "workspaces"),
      1,
    );
    expect(artifactEvents.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["claimed", "runner-spawned", "succeeded"]),
    );

    const status = await readFactoryStatusSnapshot(
      path.join(tempDir, ".tmp", "status.json"),
    );
    expect(status.counts.running).toBe(0);
    expect(status.lastAction?.kind).toBe("issue-completed");

    expect(await countRemoteBranchCommits(remotePath, "symphony/1")).toBe(1);
    expect(
      await readRemoteBranchFile(remotePath, "symphony/1", "IMPLEMENTED.txt"),
    ).toContain("implemented SYM-1");
  });
});
