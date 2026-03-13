import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { formatPlanReadyComment } from "../../src/tracker/plan-review-comment.js";
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

  it("claims issues, keeps retries in running state, and only closes when the PR is merged", async () => {
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
      "awaiting-landing-command",
    );

    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });
    expect((await tracker.inspectIssueHandoff("symphony/7")).kind).toBe(
      "awaiting-landing",
    );

    const awaitingLanding = await tracker.inspectIssueHandoff("symphony/7");
    expect(awaitingLanding.kind).toBe("awaiting-landing");
    await tracker.executeLanding(awaitingLanding.pullRequest!);
    expect((await tracker.inspectIssueHandoff("symphony/7")).kind).toBe(
      "handoff-ready",
    );

    await tracker.completeIssue(7);
    const issue = server.getIssue(7);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain("done");
  });

  it("reports a missing lifecycle when no PR exists for the branch", async () => {
    const tracker = createTracker(server);
    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("missing-target");
    expect(lifecycle.summary).toMatch(/no open pull request/i);
  });

  it("reports awaiting-human-handoff when the latest issue handoff is plan-ready", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: formatPlanReadyComment({
        repo: "sociotechnica-org/symphony-ts",
        planPath: "docs/plans/007-bootstrap-task/plan.md",
        branchName: "symphony/7",
        summaryLines: ["Ready for human review."],
      }),
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-human-handoff");
    expect(lifecycle.summary).toMatch(/waiting for human plan review/i);
  });

  it("reports awaiting-human-handoff for the legacy plan-ready wording", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan ready for review.\n\nWaiting for human review.",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-human-handoff");
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

    const first = await tracker.inspectIssueHandoff("symphony/7");
    const second = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("missing-target");
    expect(first.summary).toMatch(/no open pull request/i);
    expect(second.kind).toBe("missing-target");
    expect(second.summary).toMatch(/no open pull request/i);
    expect(
      server
        .getIssue(7)
        .comments.some(
          (body) =>
            body.includes("Plan review acknowledged: approved") &&
            body.includes("Review comment id: 2"),
        ),
    ).toBe(true);
    expect(
      server
        .getIssue(7)
        .comments.filter((body) =>
          body.startsWith("Plan review acknowledged: approved"),
        ),
    ).toHaveLength(1);
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

    expect(lifecycle.kind).toBe("awaiting-human-handoff");
    expect(lifecycle.summary).toMatch(/waiting for human plan review/i);
  });

  it("reuses cached plan-review observations while the issue is unchanged", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
    });

    const first = await tracker.inspectIssueHandoff("symphony/7");
    const second = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("awaiting-human-handoff");
    expect(second.kind).toBe("awaiting-human-handoff");
    expect(server.countRequests("GET issues/7")).toBe(2);
    expect(server.countRequests("GET issues/7/comments")).toBe(1);
  });

  it("reuses cached null plan-review observations while the issue is unchanged", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
      createdAt: "2026-03-07T10:00:00.000Z",
    });
    server.addIssueComment({
      issueNumber: 7,
      authorLogin: "jessmartin",
      body: "Plan review: changes-requested\n\nRequired changes\n- Split the issue.",
      createdAt: "2026-03-07T10:05:00.000Z",
    });

    const first = await tracker.inspectIssueHandoff("symphony/7");
    const second = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("missing-target");
    expect(second.kind).toBe("missing-target");
    expect(server.countRequests("GET issues/7")).toBe(2);
    expect(server.countRequests("GET issues/7/comments")).toBe(2);
    expect(
      server
        .getIssue(7)
        .comments.filter((body) =>
          body.startsWith("Plan review acknowledged: changes-requested"),
        ),
    ).toHaveLength(1);
  });

  it("acknowledges waived plan review decisions once", async () => {
    const tracker = createTracker(server);

    server.addIssueComment({
      issueNumber: 7,
      body: "Plan status: plan-ready\n\nWaiting for human review.",
      createdAt: "2026-03-07T10:00:00.000Z",
    });
    server.addIssueComment({
      issueNumber: 7,
      authorLogin: "jessmartin",
      body: "Plan review: waived\n\nSummary\n- Proceed without waiting.",
      createdAt: "2026-03-07T10:05:00.000Z",
    });

    const first = await tracker.inspectIssueHandoff("symphony/7");
    const second = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("missing-target");
    expect(second.kind).toBe("missing-target");
    expect(
      server
        .getIssue(7)
        .comments.filter((body) =>
          body.startsWith("Plan review acknowledged: waived"),
        ),
    ).toHaveLength(1);
  });

  it("reports awaiting-system-checks while checks are pending", async () => {
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

    expect(lifecycle.kind).toBe("awaiting-system-checks");
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

    expect(lifecycle.kind).toBe("awaiting-system-checks");
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

    expect(lifecycle.kind).toBe("awaiting-landing-command");
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

    expect(lifecycle.kind).toBe("awaiting-landing-command");
    expect(lifecycle.failingCheckNames).toEqual([]);
  });

  it("stabilizes a no-check PR in the tracker before reporting it as awaiting landing", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });

    const first = await tracker.inspectIssueHandoff("symphony/7");

    expect(first.kind).toBe("awaiting-system-checks");
    expect(first.summary).toMatch(/waiting for pr checks to appear/i);

    const second = await tracker.inspectIssueHandoff("symphony/7");
    expect(second.kind).toBe("awaiting-landing-command");
    expect(second.summary).toMatch(/awaiting a human \/land command/i);
  });

  it("ignores /land comments from non-member humans", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "outside-user",
      authorAssociation: "CONTRIBUTOR",
      body: "/land",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-landing-command");
    expect(lifecycle.summary).toMatch(/awaiting a human \/land command/i);
  });

  it("reports handoff-ready after the same pull request is merged", async () => {
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

    const openLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    expect(openLifecycle.kind).toBe("awaiting-landing-command");
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });
    await expect(
      tracker.executeLanding({
        number: 1,
        url: `${server.baseUrl}/pulls/1`,
        branchName: "symphony/7",
        headSha: openLifecycle.pullRequest?.headSha ?? null,
        latestCommitAt: openLifecycle.pullRequest?.latestCommitAt ?? null,
      }),
    ).resolves.toMatchObject({ kind: "requested" });

    const mergedLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    expect(mergedLifecycle.kind).toBe("handoff-ready");
    expect(mergedLifecycle.summary).toMatch(/has merged/i);
  });

  it("lands successfully on a squash-only repository", async () => {
    const tracker = createTracker(server);
    server.setRepositoryMergeConfig({
      allowMergeCommit: false,
      allowSquashMerge: true,
      allowRebaseMerge: false,
    });

    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    expect(approvedLifecycle.kind).toBe("awaiting-landing");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({ kind: "requested" });

    const mergedLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    expect(mergedLifecycle.kind).toBe("handoff-ready");
  });

  it("rejects landing when the approved head SHA is stale", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    expect(["awaiting-landing", "awaiting-landing-command"]).toContain(
      approvedLifecycle.kind,
    );

    server.recordBranchPush("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "stale-approved-head",
      lifecycleKind: "awaiting-landing-command",
    });

    const refreshed = await tracker.inspectIssueHandoff("symphony/7");
    expect(refreshed.kind).toBe("awaiting-system-checks");
  });

  it("refuses landing when unresolved non-outdated review threads remain", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });
    server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "reviewer",
      body: "Please address this before merge",
      path: "src/index.ts",
      line: 10,
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "review-threads-unresolved",
      lifecycleKind: "awaiting-human-review",
    });

    const refreshed = await tracker.inspectIssueHandoff("symphony/7");
    expect(refreshed.kind).toBe("awaiting-human-review");
  });

  it("refuses landing when an unresolved review thread has no author login", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });
    server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: null,
      body: "Deleted user feedback still needs resolution",
      path: "src/index.ts",
      line: 10,
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "review-threads-unresolved",
      lifecycleKind: "awaiting-human-review",
    });
  });

  it("treats bot-authored review threads as actionable bot feedback instead of human unresolved threads", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });
    server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "greptile[bot]",
      body: "Needs a follow-up commit",
      path: "src/index.ts",
      line: 10,
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "actionable-review-feedback",
      lifecycleKind: "rework-required",
    });
  });

  it("refuses landing when required checks are not terminal green", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: "awaiting-system-checks",
    });
  });

  it("treats failed required checks as rework-required during landing", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: "rework-required",
    });
  });

  it("refuses landing when the pull request is not mergeable", async () => {
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
    server.setPullRequestMergeGate("symphony/7", {
      mergeable: false,
      mergeableState: "blocked",
    });
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
    });
  });

  it("reports merged when the pull request is already merged before landing executes", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "jessmartin",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      body: "/land",
    });

    const approvedLifecycle = await tracker.inspectIssueHandoff("symphony/7");
    server.mergePullRequest("symphony/7", new Date().toISOString());

    await expect(
      tracker.executeLanding(approvedLifecycle.pullRequest!),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "merged",
    });
  });

  it("targets the latest open pull request when the same branch is reopened", async () => {
    const tracker = createTracker(server);

    await server.recordPullRequest({
      title: "Initial PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    server.mergePullRequest("symphony/7", "2020-01-01T00:00:00.000Z");

    await server.recordPullRequest({
      title: "Reopened PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    server.addPullRequestReviewThread({
      head: "symphony/7",
      authorLogin: "greptile[bot]",
      body: "Needs a follow-up commit",
      path: "src/example.ts",
      line: 12,
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("rework-required");
    expect(lifecycle.pullRequest?.url).toMatch(/\/pulls\/2$/);
    expect(lifecycle.actionableReviewFeedback).toHaveLength(1);
  });

  it("ignores a merged PR that was already completed on the issue", async () => {
    const tracker = createTracker(server);
    const mergedAt = "2026-03-11T12:05:27Z";

    server.setIssueLabels(7, ["symphony:running"]);
    await server.recordPullRequest({
      title: "PR for issue 7",
      body: "",
      head: "symphony/7",
      base: "main",
    });
    server.setPullRequestCheckRuns("symphony/7", [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    server.mergePullRequest("symphony/7", mergedAt);
    server.addIssueComment({
      issueNumber: 7,
      body: "done",
      createdAt: "2026-03-11T12:05:28Z",
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");
    const secondLifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("missing-target");
    expect(lifecycle.summary).toMatch(/no open pull request/i);
    expect(secondLifecycle.kind).toBe("missing-target");
    expect(server.countRequests("GET issues/7")).toBe(3);
    expect(server.countRequests("GET issues/7/comments")).toBe(2);
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

    expect(lifecycle.kind).toBe("rework-required");
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
    expect(refreshed.kind).toBe("awaiting-landing-command");
  });

  it("ignores non-actionable bot summary comments when deriving PR lifecycle", async () => {
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
    server.addPullRequestComment({
      head: "symphony/7",
      authorLogin: "greptile[bot]",
      body: "<h3>Greptile Summary</h3>\n\nThis PR is safe to merge.",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const lifecycle = await tracker.inspectIssueHandoff("symphony/7");

    expect(lifecycle.kind).toBe("awaiting-landing-command");
    expect(lifecycle.actionableReviewFeedback).toHaveLength(0);
    expect(lifecycle.summary).toMatch(/awaiting a human \/land command/i);
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

    expect(lifecycle.kind).toBe("rework-required");
    expect(lifecycle.unresolvedThreadIds).toEqual([botThreadId]);
    expect(lifecycle.actionableReviewFeedback).toHaveLength(2);

    const refreshed = await tracker.reconcileSuccessfulRun(
      "symphony/7",
      lifecycle,
    );

    expect(server.isReviewThreadResolved(botThreadId)).toBe(true);
    expect(server.isReviewThreadResolved(humanThreadId)).toBe(false);
    expect(refreshed.kind).toBe("awaiting-human-review");
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
    expect(first.kind).toBe("awaiting-system-checks");

    await tracker.completeIssue(7);

    const second = await tracker.inspectIssueHandoff("symphony/8");
    expect(second.kind).toBe("awaiting-landing-command");
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
    expect(first.kind).toBe("awaiting-system-checks");

    await tracker.claimIssue(7);

    const second = await tracker.inspectIssueHandoff("symphony/8");
    expect(second.kind).toBe("awaiting-landing-command");
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
