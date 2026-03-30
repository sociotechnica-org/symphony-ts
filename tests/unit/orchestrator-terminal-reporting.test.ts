import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PromptBuilder,
  ResolvedConfig,
} from "../../src/domain/workflow.js";
import { deriveRuntimeInstancePaths } from "../../src/domain/workflow.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import type { Logger } from "../../src/observability/logger.js";
import {
  createRunnerTransportMetadata,
  type Runner,
} from "../../src/runner/service.js";
import type { Tracker } from "../../src/tracker/service.js";
import type { WorkspaceManager } from "../../src/workspace/service.js";

const terminalReportingMocks = vi.hoisted(() => {
  return {
    listTerminalIssues: vi.fn(),
    readTerminalIssue: vi.fn(),
    reconcileTerminalIssueReporting: vi.fn(),
  };
});

vi.mock("../../src/observability/terminal-reporting.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/observability/terminal-reporting.js")
  >("../../src/observability/terminal-reporting.js");
  return {
    ...actual,
    listTerminalIssues: terminalReportingMocks.listTerminalIssues,
    readTerminalIssue: terminalReportingMocks.readTerminalIssue,
    reconcileTerminalIssueReporting:
      terminalReportingMocks.reconcileTerminalIssueReporting,
  };
});

const promptBuilder: PromptBuilder = {
  async build(): Promise<string> {
    return "prompt";
  },
  async buildContinuation(): Promise<string> {
    return "prompt";
  },
};

class NullLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class IdleTracker implements Tracker {
  subject(): string {
    return "test/tracker";
  }

  isHumanReviewFeedback(): boolean {
    return true;
  }

  async ensureLabels(): Promise<void> {}

  async fetchReadyIssues() {
    return [];
  }

  async fetchRunningIssues() {
    return [];
  }

  async fetchFailedIssues() {
    return [];
  }

  async getIssue(): Promise<never> {
    throw new Error("not used");
  }

  async claimIssue(): Promise<null> {
    return null;
  }

  async inspectIssueHandoff(): Promise<never> {
    throw new Error("not used");
  }

  async reconcileSuccessfulRun(): Promise<never> {
    throw new Error("not used");
  }

  async executeLanding(): Promise<never> {
    throw new Error("not used");
  }

  async recordRetry(): Promise<void> {}

  async completeIssue(): Promise<void> {}

  async markIssueFailed(): Promise<void> {}
}

class IdleWorkspaceManager implements WorkspaceManager {
  async prepareWorkspace(): Promise<never> {
    throw new Error("not used");
  }

  async cleanupWorkspace(): Promise<never> {
    throw new Error("not used");
  }

  async cleanupWorkspaceForIssue(): Promise<never> {
    throw new Error("not used");
  }
}

class IdleRunner implements Runner {
  describeSession() {
    return {
      provider: "test-runner",
      model: null,
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: null,
      logPointers: [],
    } as const;
  }

  async run(): Promise<never> {
    throw new Error("not used");
  }
}

function createConfig(
  root: string,
  options: {
    readonly intervalMs?: number;
    readonly retryBackoffMs?: number;
  } = {},
): ResolvedConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    instance: deriveRuntimeInstancePaths({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workspaceRoot: root,
    }),
    tracker: {
      kind: "github-bootstrap",
      repo: "sociotechnica-org/symphony-ts",
      apiUrl: "https://example.test",
      readyLabel: "symphony:ready",
      runningLabel: "symphony:running",
      failedLabel: "symphony:failed",
      successComment: "done",
      reviewBotLogins: ["greptile[bot]"],
    },
    polling: {
      intervalMs: options.intervalMs ?? 10,
      maxConcurrentRuns: 1,
      retry: {
        maxAttempts: 1,
        backoffMs: options.retryBackoffMs ?? 0,
      },
    },
    workspace: {
      root,
      repoUrl: "/tmp/remote.git",
      branchPrefix: "symphony/",
      retention: {
        onSuccess: "retain",
        onFailure: "retain",
      },
    },
    hooks: {
      afterCreate: [],
    },
    agent: {
      runner: {
        kind: "generic-command",
      },
      command: "test-agent",
      promptTransport: "stdin",
      timeoutMs: 1_000,
      maxTurns: 3,
      env: {},
    },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1000,
      renderIntervalMs: 16,
      issueReports: {
        archiveRoot: null,
      },
    },
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("BootstrapOrchestrator terminal issue reporting reconciliation", () => {
  it("scans the terminal issue backlog only once across poll cycles", async () => {
    const root = await fs.mkdtemp(
      path.join("/tmp", "symphony-terminal-reporting-runonce-"),
    );
    tempRoots.push(root);
    terminalReportingMocks.listTerminalIssues.mockResolvedValue([]);

    const orchestrator = new BootstrapOrchestrator(
      createConfig(root),
      promptBuilder,
      new IdleTracker(),
      new IdleWorkspaceManager(),
      new IdleRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(terminalReportingMocks.listTerminalIssues).toHaveBeenCalledTimes(1);
  });

  it("retries queued terminal reporting work without rescanning the full backlog", async () => {
    const root = await fs.mkdtemp(
      path.join("/tmp", "symphony-terminal-reporting-queue-"),
    );
    tempRoots.push(root);
    const issue = {
      issueNumber: 44,
      issueIdentifier: "sociotechnica-org/symphony-ts#44",
      title: "Retry blocked terminal report publication",
      currentOutcome: "failed" as const,
      lastUpdatedAt: "2026-03-30T00:00:00.000Z",
    };
    terminalReportingMocks.listTerminalIssues.mockResolvedValue([issue]);
    terminalReportingMocks.readTerminalIssue.mockResolvedValue(issue);
    terminalReportingMocks.reconcileTerminalIssueReporting.mockResolvedValue({
      changed: true,
      receipt: {
        version: 1,
        issueNumber: 44,
        issueIdentifier: issue.issueIdentifier,
        issueTitle: issue.title,
        terminalOutcome: "failed",
        issueUpdatedAt: issue.lastUpdatedAt,
        state: "blocked",
        summary: "Terminal issue report publication is blocked.",
        note: "Archive root does not exist.",
        blockedStage: "publication",
        archiveRoot: null,
        reportGeneratedAt: null,
        reportJsonFile: null,
        reportMarkdownFile: null,
        publicationId: null,
        publicationRoot: null,
        publicationMetadataFile: null,
        publishedAt: null,
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    });

    const orchestrator = new BootstrapOrchestrator(
      createConfig(root),
      promptBuilder,
      new IdleTracker(),
      new IdleWorkspaceManager(),
      new IdleRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.runOnce();

    expect(terminalReportingMocks.listTerminalIssues).toHaveBeenCalledTimes(1);
    expect(terminalReportingMocks.readTerminalIssue).toHaveBeenCalledTimes(2);
    expect(
      terminalReportingMocks.reconcileTerminalIssueReporting,
    ).toHaveBeenCalledTimes(2);
  });

  it("backs off blocked terminal reporting retries between poll cycles", async () => {
    const root = await fs.mkdtemp(
      path.join("/tmp", "symphony-terminal-reporting-backoff-"),
    );
    tempRoots.push(root);
    const issue = {
      issueNumber: 45,
      issueIdentifier: "sociotechnica-org/symphony-ts#45",
      title: "Throttle blocked terminal report publication retries",
      currentOutcome: "failed" as const,
      lastUpdatedAt: "2026-03-30T00:00:00.000Z",
    };
    terminalReportingMocks.listTerminalIssues.mockResolvedValue([issue]);
    terminalReportingMocks.readTerminalIssue.mockResolvedValue(issue);
    terminalReportingMocks.reconcileTerminalIssueReporting.mockResolvedValue({
      changed: true,
      receipt: {
        version: 1,
        issueNumber: 45,
        issueIdentifier: issue.issueIdentifier,
        issueTitle: issue.title,
        terminalOutcome: "failed",
        issueUpdatedAt: issue.lastUpdatedAt,
        state: "blocked",
        summary: "Terminal issue report publication is blocked.",
        note: "Archive root does not exist.",
        blockedStage: "publication",
        archiveRoot: null,
        reportGeneratedAt: null,
        reportJsonFile: null,
        reportMarkdownFile: null,
        publicationId: null,
        publicationRoot: null,
        publicationMetadataFile: null,
        publishedAt: null,
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    });

    const orchestrator = new BootstrapOrchestrator(
      createConfig(root),
      promptBuilder,
      new IdleTracker(),
      new IdleWorkspaceManager(),
      new IdleRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(
      terminalReportingMocks.reconcileTerminalIssueReporting,
    ).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.runOnce();

    expect(
      terminalReportingMocks.reconcileTerminalIssueReporting,
    ).toHaveBeenCalledTimes(2);
  });
});
