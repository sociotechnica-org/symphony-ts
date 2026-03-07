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

    expect((await tracker.inspectIssueHandoff("symphony/7")).kind).toBe(
      "ready",
    );

    await tracker.completeIssue(7);
    const issue = server.getIssue(7);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain("done");
  });

  it("reports a missing lifecycle when no PR exists for the branch", async () => {
    const tracker = createTracker(server);
    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("missing");
    expect(lifecycle.summary).toMatch(/no open pull request/i);
  });

  it("reports awaiting-plan-review when the latest issue handoff is plan-ready", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-plan-review");
    expect(lifecycle.summary).toMatch(/waiting for human plan review/i);
  });

  it("resumes from missing once a plan review is approved", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
      createdAt: "2026-03-07T10:00:00.000Z",
    });
    server.addIssueComment({
      issueNumber: 7,
      authorLogin: "jessmartin",
      body: "Plan review: approved\n\nSummary\n- Approved.",
      createdAt: "2026-03-07T10:05:00.000Z",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("missing");
    expect(lifecycle.summary).toMatch(/no open pull request/i);
  });

  it("reads plan-review signals beyond the first page of issue comments", async () => {
    const tracker = createTracker(server);

    for (let index = 0; index < 120; index += 1) {
      server.addIssueComment({
        issueNumber: 7,
        body: `noise ${index.toString()}`,
        createdAt: new Date(Date.UTC(2026, 2, 7, 10, 0, index)).toISOString(),
      });
    }
    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
      createdAt: "2026-03-07T10:05:00.000Z",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-plan-review");
    expect(lifecycle.summary).toMatch(/waiting for human plan review/i);
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

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-review");
    expect(lifecycle.pendingCheckNames).toEqual(["CI"]);
  });

  it("treats requested commit statuses as pending handoff state", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestStatuses("symphony/7", [
      { context: "Bugbot", state: "requested" },
    ]);

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-review");
    expect(lifecycle.pendingCheckNames).toEqual(["Bugbot"]);
  });

  it("treats stale check conclusions as non-actionable", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "stale" },
    ]);

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("ready");
    expect(lifecycle.failingCheckNames).toEqual([]);
  });

  it("treats cancelled and action_required conclusions as non-actionable", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "Deploy", status: "completed", conclusion: "action_required" },
      { name: "CI", status: "completed", conclusion: "cancelled" },
    ]);

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("ready");
    expect(lifecycle.failingCheckNames).toEqual([]);
  });

  it("stabilizes a no-check PR in the tracker before reporting it ready", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });

    const first = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("awaiting-review");
    expect(first.summary).toMatch(/waiting for pr checks to appear/i);

    const second = await tracker.inspectIssueHandoff("symphony/7");
    expect(second.kind).toBe("ready");
    expect(second.summary).toMatch(/merge-ready/i);
  });

  it("deduplicates concurrent ensureLabels calls", async () => {
    const tracker = createTracker(server);

    await Promise.all([
      tracker.ensureLabels(),
      tracker.ensureLabels(),
      tracker.ensureLabels(),
    ]);

    expect(server.countRequests("POST labels")).toBe(3);
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

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("needs-follow-up");
    expect(lifecycle.failingCheckNames).toEqual(["CI"]);
    expect(lifecycle.unresolvedThreadIds).toEqual([threadId]);
    expect(lifecycle.actionableReviewFeedback).toHaveLength(2);

    server.recordBranchPush(
      "symphony/7",
      new Date(Date.now() + 2_000).toISOString(),
    );
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);

    const refreshed = await tracker.reconcileSuccessfulRun(
      "symphony/7",
      lifecycle,
    );
    expect(server.isReviewThreadResolved(threadId)).toBe(true);
    expect(refreshed.kind).toBe("ready");
  });

  it("does not auto-resolve human review threads after a follow-up push", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    const botThreadId = server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "greptile[bot]",
      body: "Bot feedback",
      path: "src/index.ts",
      line: 12,
    });
    const humanThreadId = server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "jessmartin",
      body: "Human feedback",
      path: "src/index.ts",
      line: 14,
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("needs-follow-up");
    expect(lifecycle.unresolvedThreadIds).toEqual([botThreadId]);
    expect(lifecycle.actionableReviewFeedback).toHaveLength(2);

    const refreshed = await tracker.reconcileSuccessfulRun(
      "symphony/7",
      lifecycle,
    );

    expect(server.isReviewThreadResolved(botThreadId)).toBe(true);
    expect(server.isReviewThreadResolved(humanThreadId)).toBe(false);
    expect(refreshed.kind).toBe("awaiting-review");
    expect(refreshed.actionableReviewFeedback).toHaveLength(1);
    expect(refreshed.actionableReviewFeedback[0]?.authorLogin).toBe(
      "jessmartin",
    );
    expect(refreshed.unresolvedThreadIds).toEqual([]);
  });

  it("preserves no-check stabilization for other branches when an issue completes", async () => {
    const tracker = createTracker(server);

    server.seedIssue({
      number: 8,
      title: "Second task",
      body: "Do another thing",
      labels: ["symphony:running"],
    });

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    await server.recordPullRequest({
      title: "PR for issue 8",
      body: "",
      head: "symphony/8",
      base: "main",
    });

    const first = await tracker.inspectIssueHandoff("symphony/8");
    expect(first.kind).toBe("awaiting-review");

    await tracker.completeIssue(7);

    const second = await tracker.inspectIssueHandoff("symphony/8");
    expect(second.kind).toBe("ready");
  });

  it("preserves no-check stabilization for other branches when another issue is claimed", async () => {
    const tracker = createTracker(server);

    server.seedIssue({
      number: 8,
      title: "Second task",
      body: "Do another thing",
      labels: ["symphony:ready"],
    });

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    await server.recordPullRequest({
      title: "PR for issue 8",
      body: "",
      head: "symphony/8",
      base: "main",
    });

    const first = await tracker.inspectIssueHandoff("symphony/8");
    expect(first.kind).toBe("awaiting-review");

    await tracker.claimIssue(7);

    const second = await tracker.inspectIssueHandoff("symphony/8");
    expect(second.kind).toBe("ready");
  });

  it("deduplicates two concurrent ensureLabels calls", async () => {
    const tracker = createTracker(server);

    await Promise.all([tracker.ensureLabels(), tracker.ensureLabels()]);

    expect(server.countRequests("POST labels")).toBe(3);
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
