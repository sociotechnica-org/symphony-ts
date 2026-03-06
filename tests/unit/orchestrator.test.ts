import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type {
  PullRequestLifecycle,
  ReviewFeedback,
} from "../../src/domain/pull-request.js";
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
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    reviewBotLogins: ["greptile[bot]"],
  },
  polling: {
    intervalMs: 10,
    maxConcurrentRuns: 2,
    retry: {
      maxAttempts: 2,
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
  async build({ issue, attempt, pullRequest }): Promise<string> {
    return JSON.stringify({
      issue: issue.identifier,
      attempt,
      pullRequest: pullRequest?.kind ?? null,
    });
  },
};

function createIssue(number: number, label = "symphony:ready"): RuntimeIssue {
  const timestamp = new Date().toISOString();
  return {
    id: String(number),
    identifier: `sociotechnica-org/symphony-ts#${number}`,
    number,
    title: `Issue ${number}`,
    description: `Description ${number}`,
    labels: [label],
    state: "open",
    url: `https://example.test/issues/${number}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function lifecycle(
  kind: PullRequestLifecycle["kind"],
  branchName: string,
  options?: {
    failingCheckNames?: readonly string[];
    pendingCheckNames?: readonly string[];
    actionableReviewFeedback?: readonly ReviewFeedback[];
    unresolvedThreadIds?: readonly string[];
  },
): PullRequestLifecycle {
  return {
    kind,
    branchName,
    pullRequest:
      kind === "missing"
        ? null
        : {
            number: 1,
            url: `https://example.test/pulls/${branchName}`,
            branchName,
            latestCommitAt: new Date().toISOString(),
          },
    checks: [],
    pendingCheckNames: options?.pendingCheckNames ?? [],
    failingCheckNames: options?.failingCheckNames ?? [],
    actionableReviewFeedback: options?.actionableReviewFeedback ?? [],
    unresolvedThreadIds: options?.unresolvedThreadIds ?? [],
    summary: `${kind} for ${branchName}`,
  };
}

class NullLogger implements Logger {
  readonly errors: string[] = [];

  info(_message: string, _data?: Record<string, unknown>): void {}

  error(message: string, _data?: Record<string, unknown>): void {
    this.errors.push(message);
  }
}

class SequencedTracker implements Tracker {
  readonly readyIssues = new Map<number, RuntimeIssue>();
  readonly runningIssues = new Map<number, RuntimeIssue>();
  readonly lifecycleSequences = new Map<number, PullRequestLifecycle[]>();
  readonly completed: number[] = [];
  readonly retried: Array<{ issueNumber: number; reason: string }> = [];
  readonly failed: Array<{ issueNumber: number; reason: string }> = [];
  readonly resolvedThreadBatches: readonly string[][] = [];
  ensureLabelsCalls = 0;

  constructor(options: {
    ready?: readonly RuntimeIssue[];
    running?: readonly RuntimeIssue[];
  }) {
    for (const issue of options.ready ?? []) {
      this.readyIssues.set(issue.number, issue);
    }
    for (const issue of options.running ?? []) {
      this.runningIssues.set(issue.number, issue);
    }
  }

  setLifecycleSequence(
    issueNumber: number,
    sequence: readonly PullRequestLifecycle[],
  ): void {
    this.lifecycleSequences.set(issueNumber, [...sequence]);
  }

  async ensureLabels(): Promise<void> {
    this.ensureLabelsCalls += 1;
  }

  async fetchReadyIssues(): Promise<readonly RuntimeIssue[]> {
    return [...this.readyIssues.values()];
  }

  async fetchRunningIssues(): Promise<readonly RuntimeIssue[]> {
    return [...this.runningIssues.values()];
  }

  async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    return (this.readyIssues.get(issueNumber) ??
      this.runningIssues.get(issueNumber))!;
  }

  async claimIssue(issueNumber: number): Promise<RuntimeIssue | null> {
    const issue = this.readyIssues.get(issueNumber);
    if (!issue) {
      return null;
    }
    this.readyIssues.delete(issueNumber);
    const claimed = { ...issue, labels: ["symphony:running"] };
    this.runningIssues.set(issueNumber, claimed);
    return claimed;
  }

  async inspectIssueHandoff(branchName: string): Promise<PullRequestLifecycle> {
    const issueNumber = Number(branchName.split("/").at(-1));
    if (Number.isNaN(issueNumber)) {
      throw new Error(`Invalid branch name ${branchName}`);
    }
    const sequence = this.lifecycleSequences.get(issueNumber);
    if (!sequence || sequence.length === 0) {
      throw new Error(`No lifecycle configured for issue ${issueNumber}`);
    }
    if (sequence.length === 1) {
      return sequence[0]!;
    }
    return sequence.shift()!;
  }

  async reconcileSuccessfulRun(
    branchName: string,
    lifecycle: PullRequestLifecycle | null,
  ): Promise<PullRequestLifecycle> {
    if (lifecycle !== null && lifecycle.unresolvedThreadIds.length > 0) {
      (this.resolvedThreadBatches as string[][]).push([
        ...lifecycle.unresolvedThreadIds,
      ]);
    }
    return await this.inspectIssueHandoff(branchName);
  }

  async recordRetry(issueNumber: number, reason: string): Promise<void> {
    this.retried.push({ issueNumber, reason });
  }

  async completeIssue(issueNumber: number): Promise<void> {
    this.completed.push(issueNumber);
    this.readyIssues.delete(issueNumber);
    this.runningIssues.delete(issueNumber);
  }

  async markIssueFailed(issueNumber: number, reason: string): Promise<void> {
    this.failed.push({ issueNumber, reason });
    this.readyIssues.delete(issueNumber);
    this.runningIssues.delete(issueNumber);
  }
}

class FlakyTracker extends SequencedTracker {
  override async ensureLabels(): Promise<void> {
    await super.ensureLabels();
    if (this.ensureLabelsCalls === 1) {
      throw new Error("transient label failure");
    }
  }
}

class RetryRecordingFailingTracker extends SequencedTracker {
  retryCalls = 0;

  override async recordRetry(
    issueNumber: number,
    reason: string,
  ): Promise<void> {
    this.retryCalls += 1;
    await super.recordRetry(issueNumber, reason);
    throw new Error("retry bookkeeping failed");
  }
}

class StaticWorkspaceManager implements WorkspaceManager {
  readonly prepared: string[] = [];

  async prepareWorkspace({
    issue,
  }: {
    readonly issue: RuntimeIssue;
  }): Promise<PreparedWorkspace> {
    this.prepared.push(`/tmp/workspaces/${issue.number}`);
    return {
      key: `sociotechnica-org_symphony-ts_${issue.number}`,
      path: `/tmp/workspaces/${issue.number}`,
      branchName: `symphony/${issue.number}`,
      createdNow: true,
    };
  }

  async cleanupWorkspace(_workspace: PreparedWorkspace): Promise<void> {}

  async cleanupWorkspaceForIssue({
    issue,
  }: {
    readonly issue: RuntimeIssue;
  }): Promise<void> {
    await this.cleanupWorkspace({
      key: `sociotechnica-org_symphony-ts_${issue.number}`,
      path: `/tmp/workspaces/${issue.number}`,
      branchName: `symphony/${issue.number}`,
      createdNow: false,
    });
  }
}

class CleanupFailingWorkspaceManager extends StaticWorkspaceManager {
  readonly cleaned: string[] = [];

  override async cleanupWorkspace(workspace: PreparedWorkspace): Promise<void> {
    this.cleaned.push(workspace.path);
    throw new Error("rm failed");
  }
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

class RecordingRunner implements Runner {
  readonly sessionIds: string[] = [];
  readonly attempts: number[] = [];
  readonly prompts: string[] = [];

  async run(session: RunSession): Promise<RunResult> {
    this.sessionIds.push(session.id);
    this.attempts.push(session.attempt.sequence);
    this.prompts.push(session.prompt);
    const timestamp = new Date().toISOString();
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: timestamp,
      finishedAt: timestamp,
    };
  }
}

describe("BootstrapOrchestrator", () => {
  it("starts up to maxConcurrentRuns ready issues in parallel", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "symphony-parallel-test-"),
    );
    const tracker = new SequencedTracker({
      ready: [createIssue(1), createIssue(2), createIssue(3)],
    });
    tracker.setLifecycleSequence(1, [
      lifecycle("missing", "symphony/1"),
      lifecycle("ready", "symphony/1"),
    ]);
    tracker.setLifecycleSequence(2, [
      lifecycle("missing", "symphony/2"),
      lifecycle("ready", "symphony/2"),
    ]);
    tracker.setLifecycleSequence(3, [
      lifecycle("missing", "symphony/3"),
      lifecycle("ready", "symphony/3"),
    ]);
    const runner = new ConcurrencyRunner();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          root: tempRoot,
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    const runOnce = orchestrator.runOnce();
    await runner.waitForTwoStarts();

    expect(runner.maxActive).toBe(2);
    expect(
      [...runner.startedIssues].sort((left, right) => left - right),
    ).toEqual([1, 2]);

    runner.finish();
    await runOnce;

    expect(tracker.completed).toEqual([1, 2]);
  });

  it("keeps polling after a transient poll-level failure", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "symphony-loop-test-"),
    );
    const tracker = new FlakyTracker({
      ready: [createIssue(1)],
    });
    tracker.setLifecycleSequence(1, [
      lifecycle("missing", "symphony/1"),
      lifecycle("ready", "symphony/1"),
    ]);
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: { ...baseConfig.polling, intervalMs: 1 },
        workspace: {
          ...baseConfig.workspace,
          root: tempRoot,
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      new RecordingRunner(),
      logger,
    );
    const controller = new AbortController();
    const loop = orchestrator.runLoop(controller.signal);

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const check = () => {
        if (tracker.completed.length === 1) {
          controller.abort();
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          controller.abort();
          reject(
            new Error("Timed out waiting for the orchestrator to recover"),
          );
          return;
        }
        setTimeout(check, 1);
      };
      check();
    });

    await loop;
    await fs.rm(tempRoot, { recursive: true, force: true });

    expect(logger.errors).toContain("Poll cycle failed");
    expect(tracker.completed).toEqual([1]);
  });

  it("waits when a running PR only has pending checks", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(7, "symphony:running")],
    });
    tracker.setLifecycleSequence(7, [
      lifecycle("awaiting-review", "symphony/7", {
        pendingCheckNames: ["CI"],
      }),
    ]);
    let runnerCalls = 0;
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        async run(): Promise<RunResult> {
          runnerCalls += 1;
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(runnerCalls).toBe(0);
    expect(tracker.completed).toEqual([]);
    expect(tracker.retried).toEqual([]);
  });

  it("skips a running issue that is already leased by another local worker", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "symphony-lease-test-"),
    );
    const tracker = new SequencedTracker({
      running: [createIssue(70, "symphony:running")],
    });
    tracker.setLifecycleSequence(70, [
      lifecycle("needs-follow-up", "symphony/70", {
        failingCheckNames: ["CI"],
      }),
    ]);
    let runnerCalls = 0;
    await fs.mkdir(path.join(tempRoot, ".symphony-locks", "70"), {
      recursive: true,
    });
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          root: tempRoot,
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        async run(): Promise<RunResult> {
          runnerCalls += 1;
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await fs.rm(tempRoot, { recursive: true, force: true });

    expect(runnerCalls).toBe(0);
    expect(tracker.completed).toEqual([]);
    expect(tracker.failed).toEqual([]);
  });

  it("completes a running PR when the tracker later reports it ready", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(71, "symphony:running")],
    });
    tracker.setLifecycleSequence(71, [
      lifecycle("awaiting-review", "symphony/71"),
      lifecycle("ready", "symphony/71"),
    ]);
    const workspace = new CleanupFailingWorkspaceManager();
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          cleanupOnSuccess: true,
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      {
        async run(): Promise<RunResult> {
          throw new Error("runner should not be called");
        },
      },
      logger,
    );

    await orchestrator.runOnce();
    expect(tracker.completed).toEqual([]);

    await orchestrator.runOnce();

    expect(tracker.completed).toEqual([71]);
    expect(workspace.cleaned).toEqual(["/tmp/workspaces/71"]);
    expect(logger.errors).toContain("Workspace cleanup failed");
  });

  it("reruns a running PR when CI or review feedback is actionable and resolves review threads", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(8, "symphony:running")],
    });
    tracker.setLifecycleSequence(8, [
      lifecycle("needs-follow-up", "symphony/8", {
        failingCheckNames: ["CI"],
        unresolvedThreadIds: ["thread-1"],
        actionableReviewFeedback: [
          {
            id: "comment-1",
            kind: "review-thread",
            threadId: "thread-1",
            authorLogin: "greptile[bot]",
            body: "Fix this",
            createdAt: new Date().toISOString(),
            url: "https://example.test/thread/1",
            path: "src/index.ts",
            line: 10,
          },
        ],
      }),
      lifecycle("ready", "symphony/8"),
    ]);
    const runner = new RecordingRunner();
    const workspace = new CleanupFailingWorkspaceManager();
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          cleanupOnSuccess: true,
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      runner,
      logger,
    );

    await orchestrator.runOnce();

    expect(runner.attempts).toEqual([1]);
    expect(tracker.resolvedThreadBatches).toEqual([["thread-1"]]);
    expect(tracker.completed).toEqual([8]);
    expect(workspace.cleaned).toEqual(["/tmp/workspaces/8"]);
    expect(logger.errors).toContain("Workspace cleanup failed");
  });

  it("cleans up the workspace when a running PR becomes ready without rerunning the agent", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(81, "symphony:running")],
    });
    tracker.setLifecycleSequence(81, [lifecycle("ready", "symphony/81")]);
    const workspace = new CleanupFailingWorkspaceManager();
    let runnerCalls = 0;
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          cleanupOnSuccess: true,
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      {
        async run(): Promise<RunResult> {
          runnerCalls += 1;
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(runnerCalls).toBe(0);
    expect(tracker.completed).toEqual([81]);
    expect(workspace.prepared).toEqual([]);
    expect(workspace.cleaned).toEqual(["/tmp/workspaces/81"]);
  });

  it("keeps the next run attempt when PR follow-up work appears after the initial PR open", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(9)],
    });
    tracker.setLifecycleSequence(9, [
      lifecycle("missing", "symphony/9"),
      lifecycle("awaiting-review", "symphony/9", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("awaiting-review", "symphony/9", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("needs-follow-up", "symphony/9", {
        failingCheckNames: ["CI"],
      }),
      lifecycle("ready", "symphony/9"),
    ]);
    const runner = new RecordingRunner();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(runner.attempts).toEqual([1, 2]);
    expect(tracker.completed).toEqual([9]);
  });

  it("passes null for the first prompt attempt and the numeric attempt for retries", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(13)],
    });
    tracker.setLifecycleSequence(13, [
      lifecycle("missing", "symphony/13"),
      lifecycle("awaiting-review", "symphony/13", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("needs-follow-up", "symphony/13", {
        failingCheckNames: ["CI"],
      }),
      lifecycle("ready", "symphony/13"),
    ]);
    const runner = new RecordingRunner();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(runner.attempts).toEqual([1, 2]);
    expect(runner.prompts).toEqual([
      JSON.stringify({
        issue: "sociotechnica-org/symphony-ts#13",
        attempt: null,
        pullRequest: null,
      }),
      JSON.stringify({
        issue: "sociotechnica-org/symphony-ts#13",
        attempt: 2,
        pullRequest: "needs-follow-up",
      }),
    ]);
  });

  it("does not requeue a retrying issue before its backoff window expires", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(10)],
    });
    tracker.setLifecycleSequence(10, [lifecycle("missing", "symphony/10")]);
    const runnerCalls: number[] = [];
    const runner: Runner = {
      async run(session): Promise<RunResult> {
        runnerCalls.push(session.attempt.sequence);
        const timestamp = new Date().toISOString();
        return {
          exitCode: 17,
          stdout: "",
          stderr: "simulated failure",
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    };
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 2,
            backoffMs: 60_000,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(runnerCalls).toEqual([1]);
    expect(tracker.retried).toHaveLength(1);
    expect(tracker.failed).toEqual([]);
  });

  it("does not invoke the unexpected failure path when retry bookkeeping fails", async () => {
    const tracker = new RetryRecordingFailingTracker({
      ready: [createIssue(11)],
    });
    tracker.setLifecycleSequence(11, [lifecycle("missing", "symphony/11")]);
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        async run(): Promise<RunResult> {
          const timestamp = new Date().toISOString();
          return {
            exitCode: 17,
            stdout: "",
            stderr: "simulated failure",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      },
      logger,
    );

    await orchestrator.runOnce();

    expect(tracker.retryCalls).toBe(1);
    expect(tracker.retried).toHaveLength(1);
    expect(logger.errors).toContain("Issue run failed");
    expect(logger.errors).toContain("Failure handling failed");
  });

  it("generates unique run session ids across orchestrator instances", async () => {
    const issue = createIssue(12);
    const firstTracker = new SequencedTracker({ ready: [issue] });
    const secondTracker = new SequencedTracker({ ready: [issue] });
    firstTracker.setLifecycleSequence(12, [
      lifecycle("missing", "symphony/12"),
      lifecycle("ready", "symphony/12"),
    ]);
    secondTracker.setLifecycleSequence(12, [
      lifecycle("missing", "symphony/12"),
      lifecycle("ready", "symphony/12"),
    ]);
    const runner = new RecordingRunner();

    const first = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      firstTracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );
    const second = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      secondTracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await first.runOnce();
    await second.runOnce();

    expect(runner.sessionIds).toHaveLength(2);
    expect(runner.sessionIds[0]).toMatch(
      /^sociotechnica-org\/symphony-ts#12\/attempt-1-/,
    );
    expect(runner.sessionIds[1]).toMatch(
      /^sociotechnica-org\/symphony-ts#12\/attempt-1-/,
    );
    expect(new Set(runner.sessionIds).size).toBe(2);
  });
});
