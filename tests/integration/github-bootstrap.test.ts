import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    await tracker.claimIssue(7);
    await tracker.completeIssue(7, "done");
    const issue = server.getIssue(7);
    expect(issue.state).toBe("closed");
    expect(issue.comments).toContain("done");
  });
});
