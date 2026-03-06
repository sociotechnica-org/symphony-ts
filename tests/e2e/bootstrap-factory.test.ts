import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPromptBuilder,
  loadWorkflow,
} from "../../src/config/workflow.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { readFactoryStatusSnapshot } from "../../src/observability/status.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import { LocalRunner } from "../../src/runner/local.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { LocalWorkspaceManager } from "../../src/workspace/local.js";
import {
  countRemoteBranchCommits,
  createSeedRemote,
  createTempDir,
  readRemoteBranchFile,
} from "../support/git.js";
import { MockGitHubServer } from "../support/mock-github-server.js";
import { waitForExit } from "../support/process.js";

const originalEnv = { ...process.env };

async function writeWorkflow(options: {
  rootDir: string;
  remotePath: string;
  apiUrl: string;
  agentCommand: string;
  retryBackoffMs?: number;
  maxAttempts?: number;
  maxFollowUpAttempts?: number;
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
  review_bot_logins:
    - greptile[bot]
    - bugbot[bot]
polling:
  interval_ms: 5
  max_concurrent_runs: 1
  retry:
    max_attempts: ${options.maxAttempts ?? 2}
    max_follow_up_attempts: ${options.maxFollowUpAttempts ?? options.maxAttempts ?? 2}
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
{% if pull_request %}
Pull request lifecycle: {{ pull_request.kind }}
Pull request URL: {{ pull_request.pullRequest.url }}
Pending checks: {{ pull_request.pendingCheckNames | join: ", " }}
Failing checks: {{ pull_request.failingCheckNames | join: ", " }}
Actionable feedback: {{ pull_request.actionableReviewFeedback | size }}
{% endif %}
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
  const tracker = new GitHubBootstrapTracker(workflow.config.tracker, logger);
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

describe("Phase 1.2 PR lifecycle factory", () => {
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

  it("keeps the issue running after PR open until checks become green", async () => {
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
    const orchestrator = await createOrchestrator(workflowPath);

    await orchestrator.runOnce();

    let issue = server.getIssue(1);
    expect(issue.state).toBe("open");
    expect(issue.labels.map((label) => label.name)).toContain(
      "symphony:running",
    );
    expect(server.getPullRequests()).toHaveLength(1);
    const status = await readFactoryStatusSnapshot(
      path.join(tempDir, ".tmp", "status.json"),
    );
    expect(status.factoryState).toBe("blocked");
    expect(status.counts.running).toBe(1);
    expect(status.lastAction?.kind).toBe("awaiting-review");
    expect(status.activeIssues).toHaveLength(1);
    expect(status.activeIssues[0]).toMatchObject({
      issueNumber: 1,
      status: "awaiting-review",
      branchName: "symphony/1",
    });
    expect(status.activeIssues[0]?.pullRequest?.number).toBe(1);
    expect(status.activeIssues[0]?.checks.pendingNames).toEqual([]);

    server.setPullRequestCheckRuns("symphony/1", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    await orchestrator.runOnce();

    issue = server.getIssue(1);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain(
      "Symphony completed this issue successfully.",
    );

    const implemented = await readRemoteBranchFile(
      remotePath,
      "symphony/1",
      "IMPLEMENTED.txt",
    );
    expect(implemented).toContain("sociotechnica-org/symphony-ts#1");
  });

  it("reruns the same PR branch after CI failure and closes only after the rerun goes green", async () => {
    server.seedIssue({
      number: 2,
      title: "Retry CI failures",
      body: "Carry the PR through CI",
      labels: ["symphony:ready"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve("tests/fixtures/fake-agent-pr-follow-up.sh"),
    });
    const orchestrator = await createOrchestrator(workflowPath);

    await orchestrator.runOnce();
    server.setPullRequestCheckRuns("symphony/2", [
      { name: "CI", status: "completed", conclusion: "failure" },
    ]);

    await orchestrator.runOnce();

    let issue = server.getIssue(2);
    expect(issue.state).toBe("open");
    expect(server.getPullRequests()).toHaveLength(1);

    const secondAttempt = await readRemoteBranchFile(
      remotePath,
      "symphony/2",
      "IMPLEMENTED.txt",
    );
    expect(secondAttempt).toContain("attempt 2");
    expect(await countRemoteBranchCommits(remotePath, "symphony/2")).toBe(2);

    server.setPullRequestCheckRuns("symphony/2", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    await orchestrator.runOnce();

    issue = server.getIssue(2);
    expect(issue.state).toBe("closed");
  });

  it("resolves actionable review feedback after a follow-up push and waits for the PR to become clean", async () => {
    server.seedIssue({
      number: 3,
      title: "Handle review feedback",
      body: "Address bot comments on the open PR",
      labels: ["symphony:ready"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve("tests/fixtures/fake-agent-pr-follow-up.sh"),
    });
    const orchestrator = await createOrchestrator(workflowPath);

    await orchestrator.runOnce();
    server.setPullRequestCheckRuns("symphony/3", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    const threadId = server.addPullRequestReviewThread({
      head: "symphony/3",
      authorLogin: "greptile[bot]",
      body: "Please tighten this implementation",
      path: "src/tracker/github-bootstrap.ts",
      line: 42,
    });
    server.addPullRequestComment({
      head: "symphony/3",
      authorLogin: "bugbot[bot]",
      body: "There is still one more issue to fix",
    });

    await orchestrator.runOnce();

    expect(server.isReviewThreadResolved(threadId)).toBe(true);

    const secondAttempt = await readRemoteBranchFile(
      remotePath,
      "symphony/3",
      "IMPLEMENTED.txt",
    );
    expect(secondAttempt).toContain("attempt 2");
    expect(await countRemoteBranchCommits(remotePath, "symphony/3")).toBe(2);

    server.setPullRequestCheckRuns("symphony/3", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    await orchestrator.runOnce();

    const issue = server.getIssue(3);
    expect(issue.state).toBe("closed");
  });

  it("recovers a stale running issue and clears orphaned local ownership on startup", async () => {
    server.seedIssue({
      number: 4,
      title: "Recover orphaned run ownership",
      body: "Repair stale running state after a factory crash",
      labels: ["symphony:running"],
    });

    const workflowPath = await writeWorkflow({
      rootDir: tempDir,
      remotePath,
      apiUrl: server.baseUrl,
      agentCommand: path.resolve("tests/fixtures/fake-agent-success.sh"),
    });
    const workspaceRoot = path.join(tempDir, ".tmp", "workspaces");
    const lockDir = path.join(workspaceRoot, ".symphony-locks", "4");
    const orphan = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
    await fs.writeFile(
      path.join(lockDir, "run.json"),
      JSON.stringify(
        {
          issueNumber: 4,
          issueIdentifier: "sociotechnica-org/symphony-ts#4",
          branchName: "symphony/4",
          runSessionId: "sociotechnica-org/symphony-ts#4/attempt-1/orphaned",
          attempt: 1,
          ownerPid: 999999,
          runnerPid: orphan.pid,
          runRecordedAt: new Date().toISOString(),
          runnerStartedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const orchestrator = await createOrchestrator(workflowPath);

    try {
      await orchestrator.runOnce();

      expect(await fs.stat(lockDir).catch(() => null)).toBeNull();
      await waitForExit(orphan.pid!);

      let issue = server.getIssue(4);
      expect(issue.state).toBe("open");
      expect(issue.labels.map((label) => label.name)).toContain(
        "symphony:running",
      );
      expect(server.getPullRequests()).toHaveLength(1);

      server.setPullRequestCheckRuns("symphony/4", [
        { name: "CI", status: "completed", conclusion: "success" },
      ]);

      await orchestrator.runOnce();

      issue = server.getIssue(4);
      expect(issue.state).toBe("closed");
    } finally {
      orphan.kill("SIGKILL");
    }
  });
});
