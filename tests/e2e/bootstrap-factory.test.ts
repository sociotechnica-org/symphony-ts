import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";
import {
  createPromptBuilder,
  loadWorkflow,
} from "../../src/config/workflow.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import { LocalRunner } from "../../src/runner/local.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import {
  createSeedRemote,
  createTempDir,
  readRemoteBranchFile,
} from "../support/git.js";
import { MockGitHubServer } from "../support/mock-github-server.js";

const originalEnv = { ...process.env };

async function writeWorkflow(options: {
  rootDir: string;
  remotePath: string;
  apiUrl: string;
  agentCommand: string;
  retryBackoffMs?: number;
  maxAttempts?: number;
}): Promise<string> {
  const workflowPath = path.join(options.rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: ${options.apiUrl}
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: Symphony completed this issue successfully.
polling:
  interval_ms: 5
  max_concurrent_runs: 1
  retry:
    max_attempts: ${options.maxAttempts ?? 2}
    backoff_ms: ${options.retryBackoffMs ?? 0}
workspace:
  root: ./.tmp/workspaces
  repo_url: ${options.remotePath}
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  command: ${options.agentCommand}
  prompt_transport: stdin
  timeout_ms: 30000
  env:
    GITHUB_REPO: sociotechnica-org/symphony-ts
---
You are working on issue {{ issue.identifier }}: {{ issue.title }}.
Description: {{ issue.description }}
`,
    "utf8",
  );
  return workflowPath;
}

describe("Phase 0 bootstrap factory", () => {
  let server: MockGitHubServer;
  let tempDir: string;
  let remotePath: string;
  let fixturePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("symphony-e2e-");
    const remote = await createSeedRemote();
    remotePath = remote.remotePath;
    server = new MockGitHubServer();
    await server.start();
    fixturePath = path.resolve("tests/fixtures");
    process.env = {
      ...originalEnv,
      GH_TOKEN: "test-token",
      MOCK_GITHUB_API_URL: server.baseUrl,
      PATH: `${fixturePath}:${originalEnv.PATH ?? ""}`,
    };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("processes a real issue end-to-end with a fake GitHub API and fake agent", async () => {
    server.seedIssue({
      number: 1,
      title: "Implement Symphony",
      body: "Make it work",
      labels: ["symphony:ready"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve("tests/fixtures/fake-agent-success.sh"),
    });

    await runCli([
      "node",
      "symphony",
      "run",
      "--once",
      "--workflow",
      workflowPath,
    ]);

    const issue = server.getIssue(1);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain(
      "Symphony completed this issue successfully.",
    );
    expect(server.getPullRequests()).toHaveLength(1);
    expect(server.getPullRequests()[0]?.head).toBe("symphony/1");

    const implemented = await readRemoteBranchFile(
      remotePath,
      "symphony/1",
      "IMPLEMENTED.txt",
    );
    expect(implemented).toContain("sociotechnica-org/symphony-ts#1");
  });

  it("retries a failed run and succeeds on the next attempt", async () => {
    server.seedIssue({
      number: 2,
      title: "Retry this",
      body: "Needs one retry",
      labels: ["symphony:ready"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve("tests/fixtures/fake-agent-flaky.sh"),
      retryBackoffMs: 0,
      maxAttempts: 2,
    });

    const workflow = await loadWorkflow(workflowPath);
    const logger = new JsonLogger();
    const promptBuilder = createPromptBuilder(workflow);
    const tracker = new GitHubBootstrapTracker(workflow.config.tracker, logger);
    const workspace = new LocalWorkspaceManager(
      workflow.config.workspace,
      workflow.config.hooks.afterCreate,
      logger,
    );
    const runner = new LocalRunner(workflow.config.agent, logger);
    const orchestrator = new BootstrapOrchestrator(
      workflow.config,
      promptBuilder,
      tracker,
      workspace,
      runner,
      logger,
    );

    await orchestrator.runOnce();
    let issue = server.getIssue(2);
    expect(issue.state).toBe("open");
    expect(
      issue.comments.some((comment) =>
        comment.includes("Retry scheduled by Symphony"),
      ),
    ).toBe(true);

    await orchestrator.runOnce();
    issue = server.getIssue(2);
    expect(issue.state).toBe("closed");
    expect(server.getPullRequests()).toHaveLength(1);
    const implemented = await readRemoteBranchFile(
      remotePath,
      "symphony/2",
      "IMPLEMENTED.txt",
    );
    expect(implemented).toContain("attempt 2");
  });

  it("retries successfully after a prior attempt pushed the branch without opening a PR", async () => {
    server.seedIssue({
      number: 3,
      title: "Retry after pushed branch",
      body: "First attempt pushes but forgets the PR",
      labels: ["symphony:ready"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve(
        "tests/fixtures/fake-agent-push-no-pr-then-succeed.sh",
      ),
      retryBackoffMs: 0,
      maxAttempts: 2,
    });

    const workflow = await loadWorkflow(workflowPath);
    const logger = new JsonLogger();
    const promptBuilder = createPromptBuilder(workflow);
    const tracker = new GitHubBootstrapTracker(workflow.config.tracker, logger);
    const workspace = new LocalWorkspaceManager(
      workflow.config.workspace,
      workflow.config.hooks.afterCreate,
      logger,
    );
    const runner = new LocalRunner(workflow.config.agent, logger);
    const orchestrator = new BootstrapOrchestrator(
      workflow.config,
      promptBuilder,
      tracker,
      workspace,
      runner,
      logger,
    );

    await orchestrator.runOnce();

    let issue = server.getIssue(3);
    expect(issue.state).toBe("open");
    expect(server.getPullRequests()).toHaveLength(0);

    const firstAttempt = await readRemoteBranchFile(
      remotePath,
      "symphony/3",
      "IMPLEMENTED.txt",
    );
    expect(firstAttempt).toContain("attempt 1");

    await orchestrator.runOnce();

    issue = server.getIssue(3);
    expect(issue.state).toBe("closed");
    expect(server.getPullRequests()).toHaveLength(1);

    const secondAttempt = await readRemoteBranchFile(
      remotePath,
      "symphony/3",
      "IMPLEMENTED.txt",
    );
    expect(secondAttempt).toContain("attempt 2");
  });
});
