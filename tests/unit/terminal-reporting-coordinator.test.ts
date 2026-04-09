import { describe, expect, it, vi } from "vitest";
import { runTerminalIssueReporting } from "../../src/orchestrator/terminal-reporting-coordinator.js";
import { createIssue } from "../support/pull-request.js";
import {
  createTestConfig,
  createTestState,
  NullLogger,
} from "../support/orchestrator-coordinator-test-helpers.js";

const terminalReportingMocks = vi.hoisted(() => ({
  reconcileTerminalIssueReporting: vi.fn(),
}));

vi.mock("../../src/observability/terminal-reporting.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/terminal-reporting.js")
  >("../../src/observability/terminal-reporting.js");
  return {
    ...actual,
    reconcileTerminalIssueReporting:
      terminalReportingMocks.reconcileTerminalIssueReporting,
  };
});

describe("terminal reporting coordinator", () => {
  it("queues a retry when publication remains blocked", async () => {
    const config = createTestConfig("/tmp/terminal-reporting");
    const state = createTestState(config);
    const issue = createIssue(61);
    const upsertTerminalReportingStatus = vi.fn();

    terminalReportingMocks.reconcileTerminalIssueReporting.mockResolvedValue({
      changed: true,
      receipt: {
        version: 1,
        issueNumber: issue.number,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        terminalOutcome: "failed",
        issueUpdatedAt: "2026-04-09T00:00:00.000Z",
        state: "blocked",
        summary: "Publication blocked",
        note: null,
        blockedStage: "publication",
        archiveRoot: null,
        reportGeneratedAt: "2026-04-09T00:00:00.000Z",
        reportJsonFile: null,
        reportMarkdownFile: null,
        publicationId: null,
        publicationRoot: null,
        publicationMetadataFile: null,
        publishedAt: null,
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
    });

    await runTerminalIssueReporting(
      {
        config,
        logger: new NullLogger(),
        state,
        branchName: (issueNumber) => `symphony/${issueNumber.toString()}`,
        persistStatusSnapshot: async () => {},
        upsertTerminalReportingStatus,
      },
      issue,
      {
        terminalOutcome: "failure",
        branchName: "symphony/61",
        observedAt: "2026-04-09T00:00:00.000Z",
        workspaceRetention: {
          reason: "failure",
          state: "terminal-retained",
          action: "retain",
        },
        summary: "Terminal state recorded",
      },
    );

    expect(upsertTerminalReportingStatus).toHaveBeenCalledOnce();
    expect(
      state.terminalIssueReporting.queuedIssueNumbers.has(issue.number),
    ).toBe(true);
    expect(
      state.terminalIssueReporting.retryAttemptCountByIssueNumber.get(
        issue.number,
      ),
    ).toBe(1);
  });
});
