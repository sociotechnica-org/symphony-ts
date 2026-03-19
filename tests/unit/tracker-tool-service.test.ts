import { describe, expect, it } from "vitest";
import type { HandoffLifecycle } from "../../src/domain/handoff.js";
import type { PullRequestHandle } from "../../src/domain/handoff.js";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RunSession } from "../../src/domain/run.js";
import { createConfiguredWorkspaceSource } from "../../src/domain/workspace.js";
import { createTrackerToolService } from "../../src/tracker/tool-service.js";
import type {
  LandingExecutionResult,
  Tracker,
} from "../../src/tracker/service.js";

function createIssue(): RuntimeIssue {
  return {
    id: "issue-1",
    identifier: "sociotechnica-org/symphony-ts#186",
    number: 186,
    title: "Dynamic tools",
    description:
      "Summary line\n\n```ts\nconst secret = true;\n```\n\n<!-- hidden -->More context",
    labels: ["symphony:running"],
    state: "open",
    url: "https://example.test/issues/186",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
  };
}

function createLifecycle(): HandoffLifecycle {
  return {
    kind: "awaiting-human-review",
    branchName: "symphony/186",
    pullRequest: {
      number: 44,
      url: "https://example.test/pulls/44",
      branchName: "symphony/186",
      headSha: "abc123",
      latestCommitAt: "2026-03-19T00:00:00.000Z",
    },
    checks: [],
    pendingCheckNames: ["build"],
    failingCheckNames: [],
    actionableReviewFeedback: [
      {
        id: "feedback-1",
        kind: "issue-comment",
        threadId: null,
        authorLogin: "review-bot",
        body: "Please revisit `dangerous()` and remove the raw markdown.",
        createdAt: "2026-03-19T00:00:00.000Z",
        url: "https://example.test/comments/1",
        path: "src/example.ts",
        line: 12,
      },
    ],
    unresolvedThreadIds: [],
    summary: "PR is waiting for human review.",
  };
}

function createRunSession(): RunSession {
  return {
    id: "session-1",
    issue: createIssue(),
    workspace: {
      key: "sociotechnica-org_symphony-ts_186",
      branchName: "symphony/186",
      createdNow: false,
      source: createConfiguredWorkspaceSource(process.cwd()),
      target: {
        kind: "local",
        path: process.cwd(),
      },
    },
    prompt: "prompt",
    startedAt: "2026-03-19T00:00:00.000Z",
    attempt: {
      sequence: 1,
    },
  };
}

class StubTracker implements Tracker {
  readonly #issue: RuntimeIssue;
  readonly #lifecycle: HandoffLifecycle;

  constructor(issue: RuntimeIssue, lifecycle: HandoffLifecycle) {
    this.#issue = issue;
    this.#lifecycle = lifecycle;
  }

  subject(): string {
    return "stub";
  }

  isHumanReviewFeedback(_authorLogin: string | null): boolean {
    return false;
  }

  async ensureLabels(): Promise<void> {}

  async fetchReadyIssues(): Promise<readonly RuntimeIssue[]> {
    return [];
  }

  async fetchRunningIssues(): Promise<readonly RuntimeIssue[]> {
    return [];
  }

  async fetchFailedIssues(): Promise<readonly RuntimeIssue[]> {
    return [];
  }

  async getIssue(_issueNumber: number): Promise<RuntimeIssue> {
    return this.#issue;
  }

  async claimIssue(_issueNumber: number): Promise<RuntimeIssue | null> {
    return null;
  }

  async inspectIssueHandoff(_branchName: string): Promise<HandoffLifecycle> {
    return this.#lifecycle;
  }

  async reconcileSuccessfulRun(
    _branchName: string,
    _lifecycle: HandoffLifecycle | null,
  ): Promise<HandoffLifecycle> {
    return this.#lifecycle;
  }

  async executeLanding(
    _pullRequest: PullRequestHandle,
  ): Promise<LandingExecutionResult> {
    return {
      kind: "requested",
      summary: "requested",
    };
  }

  async recordRetry(
    _issueNumber: number,
    _reason: string,
  ): Promise<void> {}

  async completeIssue(_issueNumber: number): Promise<void> {}

  async markIssueFailed(
    _issueNumber: number,
    _reason: string,
  ): Promise<void> {}
}

describe("tracker tool service", () => {
  it("returns sanitized current issue and PR context", async () => {
    const tracker = new StubTracker(createIssue(), createLifecycle());
    const service = createTrackerToolService(tracker, {
      kind: "github",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://api.github.example.test",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      reviewBotLogins: [],
      successComment: "done",
    });

    const result = await service.readCurrentContext(createRunSession());

    expect(result.branchName).toBe("symphony/186");
    expect(result.issue.summary).toContain("Summary line");
    expect(result.issue.summary).not.toContain("```");
    expect(result.issue.summary).not.toContain("<!--");
    expect(result.pullRequest).toMatchObject({
      kind: "awaiting-human-review",
      summary: "PR is waiting for human review.",
      pullRequest: expect.objectContaining({
        number: 44,
      }),
      actionableReviewFeedback: [
        expect.objectContaining({
          summary: expect.stringContaining("Please revisit dangerous()"),
        }),
      ],
    });
  });
});
