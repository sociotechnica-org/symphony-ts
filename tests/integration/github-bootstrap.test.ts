import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { MockGitHubServer } from "../support/mock-github-server.js";

const logger = new JsonLogger();

function createTracker(server: MockGitHubServer): GitHubBootstrapTracker {
  return new GitHubBootstrapTracker(
    {
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: server.baseUrl,
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile[bot]", "bugbot[bot]"],
    },
    logger,
  );
}

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

  it("claims issues, keeps retries in running state, and only closes when the PR is ready", async () => {
    const tracker = createTracker(server);

    await tracker.ensureLabels();
    const ready = await tracker.fetchReadyIssues();
    expect(ready).toHaveLength(1);
    expect(await tracker.fetchRunningIssues()).toHaveLength(0);

    const claimed = await tracker.claimIssue(7);
    expect(claimed?.labels).toContain("symphony:running");
    expect(await tracker.fetchReadyIssues()).toHaveLength(0);
    expect(await tracker.fetchRunningIssues()).toHaveLength(1);

    await tracker.recordRetry(7, "retry later");
    expect(server.getIssue(7).labels.map((label) => label.name)).toContain(
      "symphony:running",
    );
    expect(server.getIssue(7).comments).toContain(
      "Retry scheduled by Symphony: retry later",
    );

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    expect(
      (await tracker.inspectPullRequestLifecycle(7, "symphony/7")).kind,
    ).toBe("ready");

    await tracker.completeIssue(7);
    const issue = server.getIssue(7);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain("done");
  });

  it("reports a missing lifecycle when no PR exists for the branch", async () => {
    const tracker = createTracker(server);
    const lifecycle = await tracker.inspectPullRequestLifecycle(
      7,
      "symphony/7",
    );

    expect(lifecycle.kind).toBe("missing");
    expect(lifecycle.summary).toMatch(/no open pull request/i);
  });

  it("reports awaiting-review while checks are pending", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "in_progress" },
    ]);

    const lifecycle = await tracker.inspectPullRequestLifecycle(
      7,
      "symphony/7",
    );

    expect(lifecycle.kind).toBe("awaiting-review");
    expect(lifecycle.pendingCheckNames).toEqual(["CI"]);
  });

  it("detects actionable review feedback and resolves addressed review threads", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "failure" },
    ]);
    const threadId = server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "greptile[bot]",
      body: "Please fix this",
      path: "src/index.ts",
      line: 12,
    });
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "bugbot[bot]",
      body: "Another actionable issue",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const lifecycle = await tracker.inspectPullRequestLifecycle(
      7,
      "symphony/7",
    );

    expect(lifecycle.kind).toBe("needs-follow-up");
    expect(lifecycle.failingCheckNames).toEqual(["CI"]);
    expect(lifecycle.unresolvedThreadIds).toEqual([threadId]);
    expect(lifecycle.actionableReviewFeedback).toHaveLength(2);

    await tracker.resolveReviewThreads(lifecycle.unresolvedThreadIds);
    expect(server.isReviewThreadResolved(threadId)).toBe(true);

    server.recordBranchPush(
      "symphony/7",
      new Date(Date.now() + 2_000).toISOString(),
    );
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    const refreshed = await tracker.inspectPullRequestLifecycle(
      7,
      "symphony/7",
    );
    expect(refreshed.kind).toBe("ready");
  });

  it("preserves labels added after claim when completing an issue", async () => {
    const tracker = createTracker(server);
    const claimed = (await tracker.claimIssue(7))!;

    server.setIssueLabels(7, [...claimed.labels, "external:keep"]);
    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    await tracker.completeIssue(7);

    expect(server.getIssue(7).labels.map((label) => label.name)).toContain(
      "external:keep",
    );
  });
});
