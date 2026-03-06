import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult, RunSession } from "../../src/domain/run.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { MockGitHubServer } from "../support/mock-github-server.js";

const logger = new JsonLogger();

describe("GitHubBootstrapTracker", () => {
  let server: MockGitHubServer;
  const previousToken = process.env.GH_TOKEN;

  beforeEach(async () => {
    server = new MockGitHubServer();
    await server.start();
    server.seedIssue({
      number: 7,
      title: "Bootstrap task",
      body: "Do the thing",
      labels: ["symphony:ready"],
    });
    process.env.GH_TOKEN = "test-token";
  });

  afterEach(async () => {
    if (previousToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = previousToken;
    }
    await server.stop();
  });

  it("claims, releases, and completes issues through the GitHub API", async () => {
    const tracker = new GitHubBootstrapTracker(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: server.baseUrl,
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        successComment: "done",
      },
      logger,
    );

    await tracker.ensureLabels();
    const eligible = await tracker.fetchEligibleIssues();
    expect(eligible).toHaveLength(1);

    const claimed = await tracker.claimIssue(7);
    expect(claimed?.labels).toContain("symphony:running");

    await tracker.releaseIssue(7, "retry later");
    expect(server.getIssue(7).labels.map((label) => label.name)).toContain(
      "symphony:ready",
    );

    const runSession: RunSession = {
      id: "sociotechnica-org/symphony-ts#7/attempt-1",
      issue: (await tracker.claimIssue(7))!,
      workspace: {
        key: "sociotechnica-org_symphony-ts_7",
        path: "/tmp/workspaces/7",
        branchName: "symphony/7",
        createdNow: true,
      },
      prompt: "prompt",
      attempt: {
        sequence: 1,
      },
    };
    const runResult: RunResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    await tracker.completeRun(runSession, runResult);
    const issue = server.getIssue(7);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain("done");
  });

  it("fails completion when no pull request exists for the run branch", async () => {
    const tracker = new GitHubBootstrapTracker(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: server.baseUrl,
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        successComment: "done",
      },
      logger,
    );

    const claimed = (await tracker.claimIssue(7))!;

    await expect(
      tracker.completeRun(
        {
          id: "sociotechnica-org/symphony-ts#7/attempt-1",
          issue: claimed,
          workspace: {
            key: "sociotechnica-org_symphony-ts_7",
            path: "/tmp/workspaces/7",
            branchName: "symphony/7",
            createdNow: true,
          },
          prompt: "prompt",
          attempt: {
            sequence: 1,
          },
        },
        {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow(/no pull request/i);
  });

  it("ensures labels only once across concurrent calls", async () => {
    const tracker = new GitHubBootstrapTracker(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: server.baseUrl,
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        successComment: "done",
      },
      logger,
    );

    await Promise.all([tracker.ensureLabels(), tracker.ensureLabels()]);

    expect(server.countRequests("POST labels")).toBe(3);
  });

  it("preserves labels added after claim when completing an issue", async () => {
    const tracker = new GitHubBootstrapTracker(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: server.baseUrl,
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        successComment: "done",
      },
      logger,
    );

    const claimed = (await tracker.claimIssue(7))!;
    server.setIssueLabels(7, [...claimed.labels, "external:keep"]);
    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });

    await tracker.completeRun(
      {
        id: "sociotechnica-org/symphony-ts#7/attempt-1",
        issue: claimed,
        workspace: {
          key: "sociotechnica-org_symphony-ts_7",
          path: "/tmp/workspaces/7",
          branchName: "symphony/7",
          createdNow: true,
        },
        prompt: "prompt",
        attempt: {
          sequence: 1,
        },
      },
      {
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    );

    expect(server.getIssue(7).labels.map((label) => label.name)).toContain(
      "external:keep",
    );
  });
});
