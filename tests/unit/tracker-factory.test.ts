import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { createTracker } from "../../src/tracker/factory.js";
import { GitHubBootstrapTracker } from "../../src/tracker/github-bootstrap.js";
import { GitHubTracker } from "../../src/tracker/github.js";

const logger = new JsonLogger();

describe("tracker factory", () => {
  it("constructs the maintained GitHub tracker for tracker.kind github", () => {
    const tracker = createTracker(
      {
        kind: "github",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: "https://api.github.com",
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        respectBlockedRelationships: false,
        successComment: "done",
        reviewBotLogins: [],
      },
      logger,
    );

    expect(tracker).toBeInstanceOf(GitHubTracker);
    expect(tracker).not.toBeInstanceOf(GitHubBootstrapTracker);
  });

  it("preserves the bootstrap compatibility tracker for tracker.kind github-bootstrap", () => {
    const tracker = createTracker(
      {
        kind: "github-bootstrap",
        repo: "sociotechnica-org/symphony-ts",
        apiUrl: "https://api.github.com",
        readyLabel: "symphony:ready",
        runningLabel: "symphony:running",
        failedLabel: "symphony:failed",
        respectBlockedRelationships: false,
        successComment: "done",
        reviewBotLogins: [],
      },
      logger,
    );

    expect(tracker).toBeInstanceOf(GitHubBootstrapTracker);
  });
});
