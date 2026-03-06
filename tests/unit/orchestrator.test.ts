import { describe, expect, it } from "vitest";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RunResult, RunSession } from "../../src/domain/run.js";
import type { PreparedWorkspace } from "../../src/domain/workspace.js";
import type {
  PromptBuilder,
  ResolvedConfig,
} from "../../src/domain/workflow.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import type { Logger } from "../../src/observability/logger.js";
import type { Runner } from "../../src/runner/service.js";
import type { Tracker } from "../../src/tracker/service.js";
import type { WorkspaceManager } from "../../src/workspace/service.js";

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const baseConfig: ResolvedConfig = {
  workflowPath: "/tmp/WORKFLOW.md",
  tracker: {
    kind: "github-bootstrap",
    repo: "sociotechnica-org/symphony-ts",
    apiUrl: "https://example.test",
    readyLabel: "symphony:ready",
    runningLabel: "symphony:running",
    failedLabel: "symphony:failed",
    successComment: "done",
  },
  polling: {
    intervalMs: 10,
    maxConcurrentRuns: 2,
    retry: {
      maxAttempts: 1,
      backoffMs: 0,
    },
  },
  workspace: {
    root: "/tmp/workspaces",
    repoUrl: "/tmp/remote.git",
    branchPrefix: "symphony/",
    cleanupOnSuccess: false,
  },
  hooks: {
    afterCreate: [],
  },
  agent: {
    command: "test-agent",
    promptTransport: "stdin",
    timeoutMs: 1_000,
    env: {},
  },
};

const staticPromptBuilder: PromptBuilder = {
  async build({ issue }): Promise<string> {
    return `Issue ${issue.identifier}`;
  },
};

function createIssue(number: number): RuntimeIssue {
  const timestamp = new Date().toISOString();
  return {
    id: String(number),
    identifier: `sociotechnica-org/symphony-ts#${number}`,
    number,
    title: `Issue ${number}`,
    description: `Description ${number}`,
    labels: ["symphony:ready"],
    state: "open",
    url: `https://example.test/issues/${number}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class NullLogger implements Logger {
  info(): void {}

  error(): void {}
}

class StaticTracker implements Tracker {
  readonly #issues: readonly RuntimeIssue[];
  readonly completed: number[] = [];

  constructor(issues: readonly RuntimeIssue[]) {
    this.#issues = issues;
  }

  async ensureLabels(): Promise<void> {}

  async fetchEligibleIssues(): Promise<readonly RuntimeIssue[]> {
    return this.#issues;
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    return this.#issues.find((issue) => issue.number === issueNumber)!;
  }

  async claimIssue(issueNumber: number): Promise<RuntimeIssue | null> {
    return await this.getIssue(issueNumber);
  }

  async completeRun(session: RunSession): Promise<void> {
    this.completed.push(session.issue.number);
  }

  async releaseIssue(): Promise<void> {}

  async markIssueFailed(): Promise<void> {}
}

class StaticWorkspaceManager implements WorkspaceManager {
  async prepareWorkspace({
    issue,
  }: {
    readonly issue: RuntimeIssue;
  }): Promise<PreparedWorkspace> {
    return {
      key: `sociotechnica-org_symphony-ts_${issue.number}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      path: `/tmp/workspaces/${issue.number}`,
      branchName: `symphony/${issue.number}`,
      createdNow: true,
    };
  }

  async cleanupWorkspace(): Promise<void> {}
}

class ConcurrencyRunner implements Runner {
  readonly #startBarrier = createDeferred<void>();
  readonly #finishBarrier = createDeferred<void>();
  readonly startedIssues: number[] = [];
  maxActive = 0;
  #active = 0;

  async waitForTwoStarts(): Promise<void> {
    await this.#startBarrier.promise;
  }

  finish(): void {
    this.#finishBarrier.resolve();
  }

  async run(session: RunSession): Promise<RunResult> {
    this.startedIssues.push(session.issue.number);
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    if (this.startedIssues.length >= 2) {
      this.#startBarrier.resolve();
    }
    await this.#finishBarrier.promise;
    this.#active -= 1;
    const finishedAt = new Date().toISOString();
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: finishedAt,
      finishedAt,
    };
  }
}

describe("BootstrapOrchestrator", () => {
  it("starts up to maxConcurrentRuns issues in parallel", async () => {
    const tracker = new StaticTracker([
      createIssue(1),
      createIssue(2),
      createIssue(3),
    ]);
    const workspace = new StaticWorkspaceManager();
    const runner = new ConcurrencyRunner();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      workspace,
      runner,
      new NullLogger(),
    );

    const runOnce = orchestrator.runOnce();
    await runner.waitForTwoStarts();

    expect(runner.maxActive).toBe(2);
    expect(runner.startedIssues).toEqual([1, 2]);

    runner.finish();
    await runOnce;

    expect(tracker.completed).toEqual([1, 2]);
  });
});
