import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerAbortedError } from "../../src/domain/errors.js";
import type { HandoffLifecycle } from "../../src/domain/handoff.js";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RunResult, RunSession } from "../../src/domain/run.js";
import type { PreparedWorkspace } from "../../src/domain/workspace.js";
import type {
  PromptBuilder,
  ResolvedConfig,
} from "../../src/domain/workflow.js";
import { LocalIssueLeaseManager } from "../../src/orchestrator/issue-lease.js";
import type { LivenessProbe } from "../../src/orchestrator/liveness-probe.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import {
  deriveFactoryRuntimeRoot,
  readIssueArtifactAttempt,
  readIssueArtifactSession,
  type IssueArtifactObservation,
  type IssueArtifactStore,
  readIssueArtifactSummary,
} from "../../src/observability/issue-artifacts.js";
import {
  deriveStatusFilePath,
  readFactoryStatusSnapshot,
} from "../../src/observability/status.js";
import type { Logger } from "../../src/observability/logger.js";
import type { Runner } from "../../src/runner/service.js";
import type { Tracker } from "../../src/tracker/service.js";
import type { WorkspaceManager } from "../../src/workspace/service.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "../support/git.js";
import {
  createIssue,
  createLifecycle as lifecycle,
} from "../support/pull-request.js";

function createRunnerSessionDescription() {
  return {
    provider: "test-runner",
    model: null,
    backendSessionId: null,
    latestTurnNumber: null,
    logPointers: [],
  } as const;
}

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

function createObservableStalledProbe(): LivenessProbe {
  return {
    async capture(options) {
      return {
        logSizeBytes: 1,
        workspaceDiffHash: null,
        prHeadSha: options.prHeadSha,
        hasActionableFeedback: options.hasActionableFeedback,
        capturedAt: Date.now(),
      };
    },
  };
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
      maxFollowUpAttempts: 2,
      backoffMs: 0,
    },
  },
  workspace: {
    root: path.join(
      "/tmp",
      `symphony-orchestrator-test-${process.pid}`,
      "workspaces",
    ),
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
    maxTurns: 3,
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
  async buildContinuation({
    issue,
    turnNumber,
    maxTurns,
    pullRequest,
  }): Promise<string> {
    return JSON.stringify({
      issue: issue.identifier,
      turnNumber,
      maxTurns,
      pullRequest: pullRequest?.kind ?? null,
      mode: "continuation",
    });
  },
};

class NullLogger implements Logger {
  readonly errors: string[] = [];
  readonly warnings: Array<{
    message: string;
    data?: Record<string, unknown>;
  }> = [];

  info(_message: string, _data?: Record<string, unknown>): void {}

  warn(message: string, data?: Record<string, unknown>): void {
    if (data === undefined) {
      this.warnings.push({ message });
      return;
    }
    this.warnings.push({ message, data });
  }

  error(message: string, _data?: Record<string, unknown>): void {
    this.errors.push(message);
  }
}

class SequencedTracker implements Tracker {
  readonly readyIssues = new Map<number, RuntimeIssue>();
  readonly runningIssues = new Map<number, RuntimeIssue>();
  readonly failedIssues = new Map<number, RuntimeIssue>();
  readonly lifecycleSequences = new Map<number, HandoffLifecycle[]>();
  readonly completed: number[] = [];
  readonly retried: Array<{ issueNumber: number; reason: string }> = [];
  readonly failed: Array<{ issueNumber: number; reason: string }> = [];
  readonly resolvedThreadBatches: string[][] = [];
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

  subject(): string {
    return "test/tracker";
  }

  isHumanReviewFeedback(authorLogin: string | null): boolean {
    return authorLogin !== null && authorLogin !== "greptile[bot]";
  }

  setLifecycleSequence(
    issueNumber: number,
    sequence: readonly HandoffLifecycle[],
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

  async fetchFailedIssues(): Promise<readonly RuntimeIssue[]> {
    return [...this.failedIssues.values()];
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

  async inspectIssueHandoff(branchName: string): Promise<HandoffLifecycle> {
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
    lifecycle: HandoffLifecycle | null,
  ): Promise<HandoffLifecycle> {
    if (lifecycle !== null && lifecycle.unresolvedThreadIds.length > 0) {
      this.resolvedThreadBatches.push([...lifecycle.unresolvedThreadIds]);
    }
    if (lifecycle === null) {
      const issueNumber = Number(branchName.split("/").at(-1));
      const sequence = this.lifecycleSequences.get(issueNumber);
      if (sequence?.[0]?.kind === "missing-target") {
        sequence.shift();
      }
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
    this.failedIssues.set(
      issueNumber,
      createIssue(issueNumber, "symphony:failed"),
    );
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

class FailOnceMarkIssueFailedTracker extends SequencedTracker {
  markIssueFailedCalls = 0;

  override async markIssueFailed(
    issueNumber: number,
    reason: string,
  ): Promise<void> {
    this.markIssueFailedCalls += 1;
    if (this.markIssueFailedCalls === 1) {
      throw new Error("mark failed transient");
    }
    await super.markIssueFailed(issueNumber, reason);
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

  describeSession() {
    return createRunnerSessionDescription();
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

  describeSession() {
    return createRunnerSessionDescription();
  }

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

class RecordingIssueArtifactStore implements IssueArtifactStore {
  readonly observations: IssueArtifactObservation[] = [];

  async recordObservation(
    observation: IssueArtifactObservation,
  ): Promise<void> {
    this.observations.push(observation);
  }
}

class PerIssueBlockingArtifactStore implements IssueArtifactStore {
  readonly #blockedIssueNumber: number;
  readonly #release = createDeferred<void>();

  constructor(blockedIssueNumber: number) {
    this.#blockedIssueNumber = blockedIssueNumber;
  }

  release(): void {
    this.#release.resolve();
  }

  async recordObservation(
    observation: IssueArtifactObservation,
  ): Promise<void> {
    if (
      observation.issue.issueNumber === this.#blockedIssueNumber &&
      observation.issue.currentOutcome === "running" &&
      observation.issue.latestSessionId !== null
    ) {
      await this.#release.promise;
    }
  }
}

class BlockingRecordingRunner implements Runner {
  readonly startedIssues: number[] = [];
  readonly issueStarted = new Map<
    number,
    ReturnType<typeof createDeferred<void>>
  >();
  readonly #finish = createDeferred<void>();

  constructor(issueNumbers: readonly number[]) {
    for (const issueNumber of issueNumbers) {
      this.issueStarted.set(issueNumber, createDeferred<void>());
    }
  }

  describeSession() {
    return createRunnerSessionDescription();
  }

  release(): void {
    this.#finish.resolve();
  }

  async waitForIssue(issueNumber: number): Promise<void> {
    await this.issueStarted.get(issueNumber)?.promise;
  }

  async run(session: RunSession): Promise<RunResult> {
    this.startedIssues.push(session.issue.number);
    this.issueStarted.get(session.issue.number)?.resolve();
    await this.#finish.promise;
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
  beforeEach(async () => {
    await fs.rm(deriveFactoryRuntimeRoot(baseConfig.workspace.root), {
      recursive: true,
      force: true,
    });
  });

  afterEach(async () => {
    await fs.rm(deriveFactoryRuntimeRoot(baseConfig.workspace.root), {
      recursive: true,
      force: true,
    });
  });

  it("starts up to maxConcurrentRuns ready issues in parallel", async () => {
    const tempRoot = await createTempDir("symphony-parallel-test-");
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(1), createIssue(2), createIssue(3)],
      });
      tracker.setLifecycleSequence(1, [
        lifecycle("missing-target", "symphony/1"),
        lifecycle("handoff-ready", "symphony/1"),
      ]);
      tracker.setLifecycleSequence(2, [
        lifecycle("missing-target", "symphony/2"),
        lifecycle("handoff-ready", "symphony/2"),
      ]);
      tracker.setLifecycleSequence(3, [
        lifecycle("missing-target", "symphony/3"),
        lifecycle("handoff-ready", "symphony/3"),
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

      expect(
        [...tracker.completed].sort((left, right) => left - right),
      ).toEqual([1, 2]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps polling after a transient poll-level failure", async () => {
    const tempRoot = await createTempDir("symphony-loop-test-");
    try {
      const tracker = new FlakyTracker({
        ready: [createIssue(1)],
      });
      tracker.setLifecycleSequence(1, [
        lifecycle("missing-target", "symphony/1"),
        lifecycle("handoff-ready", "symphony/1"),
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

      expect(logger.errors).toContain("Poll cycle failed");
      expect(tracker.completed).toEqual([1]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("waits when a running PR only has pending checks", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(7, "symphony:running")],
    });
    tracker.setLifecycleSequence(7, [
      lifecycle("awaiting-system-checks", "symphony/7", {
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
        describeSession() {
          return createRunnerSessionDescription();
        },
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

  it("waits when a running PR is clean but still awaiting landing", async () => {
    const tempRoot = await createTempDir("symphony-await-landing-wait-test-");
    try {
      const tracker = new SequencedTracker({
        running: [createIssue(47, "symphony:running")],
      });
      tracker.setLifecycleSequence(47, [
        lifecycle("awaiting-landing", "symphony/47"),
      ]);
      let runnerCalls = 0;
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
          describeSession() {
            return createRunnerSessionDescription();
          },
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

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(tempRoot),
      );
      expect(snapshot.lastAction?.kind).toBe("awaiting-landing");
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-landing");

      const summary = await readIssueArtifactSummary(tempRoot, 47);
      expect(summary.currentOutcome).toBe("awaiting-landing");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("waits at a valid plan-review handoff without retrying or failing", async () => {
    const tempRoot = await createTempDir("symphony-plan-review-wait-test-");
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(32)],
      });
      tracker.setLifecycleSequence(32, [
        lifecycle("missing-target", "symphony/32"),
        lifecycle("awaiting-human-handoff", "symphony/32"),
      ]);
      const runner = new RecordingRunner();
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

      await orchestrator.runOnce();

      expect(runner.attempts).toEqual([1]);
      expect(tracker.failed).toEqual([]);
      expect(tracker.retried).toEqual([]);

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(tempRoot),
      );
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-human-handoff");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the running source when a running issue has no PR yet", async () => {
    const tempRoot = await createTempDir("symphony-running-source-test-");
    try {
      const tracker = new SequencedTracker({
        running: [createIssue(79, "symphony:running")],
      });
      tracker.setLifecycleSequence(79, [
        lifecycle("missing-target", "symphony/79"),
        lifecycle("awaiting-system-checks", "symphony/79", {
          pendingCheckNames: ["CI"],
        }),
      ]);
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
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(tempRoot),
      );
      expect(snapshot.activeIssues).toHaveLength(1);
      expect(snapshot.activeIssues[0]?.source).toBe("running");
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-system-checks");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips a running issue that is already leased by another local worker", async () => {
    const tempRoot = await createTempDir("symphony-lease-test-");
    try {
      const tracker = new SequencedTracker({
        running: [createIssue(70, "symphony:running")],
      });
      tracker.setLifecycleSequence(70, [
        lifecycle("actionable-follow-up", "symphony/70", {
          failingCheckNames: ["CI"],
        }),
      ]);
      let runnerCalls = 0;
      const lockDir = path.join(tempRoot, ".symphony-locks", "70");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
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
          describeSession() {
            return createRunnerSessionDescription();
          },
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
      expect(tracker.failed).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reclaims a stale issue lease from a dead worker", async () => {
    const tempRoot = await createTempDir("symphony-stale-lease-test-");
    try {
      const tracker = new SequencedTracker({
        running: [createIssue(71, "symphony:running")],
      });
      tracker.setLifecycleSequence(71, [
        lifecycle("handoff-ready", "symphony/71"),
      ]);
      const lockDir = path.join(tempRoot, ".symphony-locks", "71");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");

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
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(tracker.completed).toEqual([71]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps processing other work when one running-issue reconciliation fails", async () => {
    const tempRoot = await createTempDir("symphony-reconcile-failure-test-");
    const tracker = new SequencedTracker({
      ready: [createIssue(78)],
      running: [createIssue(77, "symphony:running")],
    });
    tracker.setLifecycleSequence(77, [
      lifecycle("handoff-ready", "symphony/77"),
    ]);
    tracker.setLifecycleSequence(78, [
      lifecycle("missing-target", "symphony/78"),
      lifecycle("handoff-ready", "symphony/78"),
    ]);
    const logger = new NullLogger();
    const originalReconcile = LocalIssueLeaseManager.prototype.reconcile;
    const reconcileSpy = vi
      .spyOn(LocalIssueLeaseManager.prototype, "reconcile")
      .mockImplementation(async function mockReconcile(
        this: LocalIssueLeaseManager,
        issueNumber,
      ) {
        if (issueNumber === 77) {
          throw new Error("simulated reconcile failure");
        }
        return await originalReconcile.call(this, issueNumber);
      });

    try {
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
        new RecordingRunner(),
        logger,
      );

      await orchestrator.runOnce();
    } finally {
      reconcileSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    expect(tracker.completed).toEqual(expect.arrayContaining([77, 78]));
    expect(logger.errors).toContain(
      "Failed to reconcile running issue ownership",
    );
    expect(logger.errors).not.toContain("Poll cycle failed");
  });

  it("prunes stale active issues that no longer appear in tracker state", async () => {
    const tempRoot = await createTempDir("symphony-status-prune-test-");
    try {
      const issue = createIssue(72, "symphony:running");
      const tracker = new SequencedTracker({
        running: [issue],
      });
      tracker.setLifecycleSequence(72, [
        lifecycle("awaiting-system-checks", "symphony/72"),
      ]);
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
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      tracker.runningIssues.clear();

      await orchestrator.runOnce();

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(tempRoot),
      );
      expect(snapshot.activeIssues).toHaveLength(0);
      expect(snapshot.counts.running).toBe(0);
      expect(snapshot.factoryState).toBe("idle");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps an existing issue lease when pid probing returns EPERM", async () => {
    const tempRoot = await createTempDir("symphony-stale-lease-eperm-test-");
    const tracker = new SequencedTracker({
      running: [createIssue(72, "symphony:running")],
    });
    tracker.setLifecycleSequence(72, [
      lifecycle("handoff-ready", "symphony/72"),
    ]);
    const lockDir = path.join(tempRoot, ".symphony-locks", "72");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "pid"), "4242\n", "utf8");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
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
      new RecordingRunner(),
      new NullLogger(),
    );

    try {
      await orchestrator.runOnce();
    } finally {
      killSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    expect(tracker.completed).toEqual([]);
    expect(tracker.failed).toEqual([]);
  });

  it("completes a running PR only after the tracker later reports it merged", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(71, "symphony:running")],
    });
    tracker.setLifecycleSequence(71, [
      lifecycle("awaiting-landing", "symphony/71"),
      lifecycle("handoff-ready", "symphony/71"),
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
        describeSession() {
          return createRunnerSessionDescription();
        },
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
      lifecycle("actionable-follow-up", "symphony/8", {
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
      lifecycle("handoff-ready", "symphony/8"),
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
    tracker.setLifecycleSequence(81, [
      lifecycle("handoff-ready", "symphony/81"),
    ]);
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
        describeSession() {
          return createRunnerSessionDescription();
        },
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
      lifecycle("missing-target", "symphony/9"),
      lifecycle("awaiting-system-checks", "symphony/9", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("awaiting-system-checks", "symphony/9", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("actionable-follow-up", "symphony/9", {
        failingCheckNames: ["CI"],
      }),
      lifecycle("handoff-ready", "symphony/9"),
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

  it("marks a running issue failed after capped successful follow-up reruns", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(73, "symphony:running")],
    });
    tracker.setLifecycleSequence(73, [
      lifecycle("actionable-follow-up", "symphony/73", {
        actionableReviewFeedback: [
          {
            id: "feedback-1",
            kind: "review-thread",
            threadId: "thread-1",
            authorLogin: "greptile[bot]",
            body: "Still broken",
            createdAt: new Date().toISOString(),
            url: "https://example.test/thread/1",
            path: "src/index.ts",
            line: 1,
          },
        ],
        unresolvedThreadIds: ["thread-1"],
      }),
      lifecycle("actionable-follow-up", "symphony/73", {
        actionableReviewFeedback: [
          {
            id: "feedback-2",
            kind: "review-thread",
            threadId: "thread-2",
            authorLogin: "greptile[bot]",
            body: "Still broken",
            createdAt: new Date().toISOString(),
            url: "https://example.test/thread/2",
            path: "src/index.ts",
            line: 2,
          },
        ],
        unresolvedThreadIds: ["thread-2"],
      }),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      new RecordingRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(tracker.failed).toEqual([
      {
        issueNumber: 73,
        reason: "actionable-follow-up for symphony/73",
      },
    ]);
  });

  it("does not consume the follow-up failure budget while waiting for review", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(74)],
    });
    tracker.setLifecycleSequence(74, [
      lifecycle("missing-target", "symphony/74"),
      lifecycle("awaiting-system-checks", "symphony/74", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("actionable-follow-up", "symphony/74", {
        failingCheckNames: ["CI"],
        actionableReviewFeedback: [
          {
            id: "feedback-1",
            kind: "review-thread",
            threadId: "thread-1",
            authorLogin: "greptile[bot]",
            body: "Fix this",
            createdAt: new Date().toISOString(),
            url: "https://example.test/thread/1",
            path: "src/index.ts",
            line: 1,
          },
        ],
        unresolvedThreadIds: ["thread-1"],
      }),
      lifecycle("actionable-follow-up", "symphony/74", {
        failingCheckNames: ["CI"],
        actionableReviewFeedback: [
          {
            id: "feedback-2",
            kind: "review-thread",
            threadId: "thread-2",
            authorLogin: "greptile[bot]",
            body: "Still broken",
            createdAt: new Date().toISOString(),
            url: "https://example.test/thread/2",
            path: "src/index.ts",
            line: 2,
          },
        ],
        unresolvedThreadIds: ["thread-2"],
      }),
      lifecycle("handoff-ready", "symphony/74"),
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

    expect(runner.attempts).toEqual([1, 2, 2]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([74]);
  });

  it("passes null for the first prompt attempt and the numeric attempt for retries", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(13)],
    });
    tracker.setLifecycleSequence(13, [
      lifecycle("missing-target", "symphony/13"),
      lifecycle("awaiting-system-checks", "symphony/13", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("actionable-follow-up", "symphony/13", {
        failingCheckNames: ["CI"],
      }),
      lifecycle("handoff-ready", "symphony/13"),
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
        pullRequest: "actionable-follow-up",
      }),
    ]);
  });

  it("does not requeue a retrying issue before its backoff window expires", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(10)],
    });
    tracker.setLifecycleSequence(10, [
      lifecycle("missing-target", "symphony/10"),
    ]);
    const runnerCalls: number[] = [];
    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
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
            maxFollowUpAttempts: 2,
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

  it("preserves attempt session fields when a failed run becomes terminal", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(77)],
    });
    tracker.setLifecycleSequence(77, [
      lifecycle("missing-target", "symphony/77"),
    ]);
    const runnerPid = 4321;
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 1,
            maxFollowUpAttempts: 1,
            backoffMs: 0,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(_session, options): Promise<RunResult> {
          const timestamp = "2026-03-09T16:30:00.000Z";
          await options?.onSpawn?.({
            pid: runnerPid,
            spawnedAt: timestamp,
          });
          return {
            exitCode: 17,
            stdout: "",
            stderr: "simulated failure",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();

    const artifactSummary = await readIssueArtifactSummary(
      baseConfig.workspace.root,
      77,
    );

    expect(tracker.failed).toEqual([
      {
        issueNumber: 77,
        reason: "Runner exited with 17\nsimulated failure",
      },
    ]);
    expect(artifactSummary.currentOutcome).toBe("failed");
    expect(artifactSummary.latestAttemptNumber).toBe(1);
    expect(artifactSummary.latestSessionId).not.toBeNull();

    const attempt = await readIssueArtifactAttempt(
      baseConfig.workspace.root,
      77,
      1,
    );
    const session = await readIssueArtifactSession(
      baseConfig.workspace.root,
      77,
      artifactSummary.latestSessionId!,
    );
    expect(attempt.outcome).toBe("failed");
    expect(attempt.sessionId).toBe(artifactSummary.latestSessionId);
    expect(attempt.startedAt).toBe(session.startedAt);
    expect(attempt.finishedAt).toBe("2026-03-09T16:30:00.000Z");
    expect(attempt.runnerPid).toBe(runnerPid);
  });

  it("preserves a captured runner pid when a spawned run fails without session context", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(82)],
    });
    tracker.setLifecycleSequence(82, [
      lifecycle("missing-target", "symphony/82"),
    ]);
    const runnerPid = 8765;
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 1,
            maxFollowUpAttempts: 1,
            backoffMs: 0,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(_session, options): Promise<RunResult> {
          await options?.onSpawn?.({
            pid: runnerPid,
            spawnedAt: "2026-03-09T16:35:00.000Z",
          });
          throw new Error("runner crashed after spawn");
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(tracker.failed).toEqual([
      {
        issueNumber: 82,
        reason: "Error: runner crashed after spawn",
      },
    ]);

    const attempt = await readIssueArtifactAttempt(
      baseConfig.workspace.root,
      82,
      1,
    );
    expect(attempt.outcome).toBe("failed");
    expect(attempt.sessionId).not.toBeNull();
    expect(attempt.runnerPid).toBe(runnerPid);
  });

  it("records an explicit attempt-failed issue state before retry scheduling", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(78)],
    });
    tracker.setLifecycleSequence(78, [
      lifecycle("missing-target", "symphony/78"),
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 2,
            maxFollowUpAttempts: 2,
            backoffMs: 0,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunResult> {
          const timestamp = "2026-03-09T16:45:00.000Z";
          return {
            exitCode: 17,
            stdout: "",
            stderr: "simulated failure",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      },
      new NullLogger(),
      artifactStore,
    );

    await orchestrator.runOnce();

    expect(
      artifactStore.observations.find(
        (observation) =>
          observation.issue.issueNumber === 78 &&
          observation.issue.currentOutcome === "attempt-failed",
      ),
    ).toBeDefined();
    expect(
      artifactStore.observations.find(
        (observation) =>
          observation.issue.issueNumber === 78 &&
          observation.issue.currentOutcome === "retry-scheduled",
      ),
    ).toBeDefined();
  });

  it("describes a session once per observation when writing session artifacts", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(81)],
    });
    tracker.setLifecycleSequence(81, [
      lifecycle("missing-target", "symphony/81"),
    ]);
    let describeSessionCalls = 0;
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          describeSessionCalls += 1;
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunResult> {
          const timestamp = "2026-03-09T17:00:00.000Z";
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(describeSessionCalls).toBe(3);
  });

  it("does not block one issue's artifact writes behind another issue's queue", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(79), createIssue(80)],
    });
    tracker.setLifecycleSequence(79, [
      lifecycle("missing-target", "symphony/79"),
      lifecycle("handoff-ready", "symphony/79"),
    ]);
    tracker.setLifecycleSequence(80, [
      lifecycle("missing-target", "symphony/80"),
      lifecycle("handoff-ready", "symphony/80"),
    ]);
    const artifactStore = new PerIssueBlockingArtifactStore(79);
    const runner = new BlockingRecordingRunner([79, 80]);
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
      artifactStore,
    );

    const runOnce = orchestrator.runOnce();

    await runner.waitForIssue(80);
    expect(runner.startedIssues).toContain(80);
    expect(runner.startedIssues).not.toContain(79);

    artifactStore.release();
    await runner.waitForIssue(79);
    runner.release();
    await runOnce;
  });

  it("does not invoke the unexpected failure path when retry bookkeeping fails", async () => {
    const tracker = new RetryRecordingFailingTracker({
      ready: [createIssue(11)],
    });
    tracker.setLifecycleSequence(11, [
      lifecycle("missing-target", "symphony/11"),
    ]);
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
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

  it("does not reset retry state when marking an issue failed throws", async () => {
    const tracker = new FailOnceMarkIssueFailedTracker({
      ready: [createIssue(75)],
    });
    tracker.setLifecycleSequence(75, [
      lifecycle("missing-target", "symphony/75"),
    ]);
    const runnerCalls: number[] = [];
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 2,
            maxFollowUpAttempts: 2,
            backoffMs: 0,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
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
      },
      logger,
    );

    await orchestrator.runOnce();
    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(runnerCalls).toEqual([1, 2, 2]);
    expect(tracker.retried).toHaveLength(1);
    expect(tracker.markIssueFailedCalls).toBe(2);
    expect(tracker.failed).toEqual([
      {
        issueNumber: 75,
        reason: "Runner exited with 17\nsimulated failure",
      },
    ]);
    expect(logger.errors).toContain("Failure handling failed");
  });

  it("cancels an active run on shutdown and leaves the issue queued for retry", async () => {
    const tempRoot = await createTempDir("symphony-shutdown-test-");
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(76)],
      });
      tracker.setLifecycleSequence(76, [
        lifecycle("missing-target", "symphony/76"),
      ]);
      const started = createDeferred<void>();
      const orchestrator = new BootstrapOrchestrator(
        {
          ...baseConfig,
          polling: {
            ...baseConfig.polling,
            intervalMs: 1,
          },
          workspace: {
            ...baseConfig.workspace,
            root: tempRoot,
          },
        },
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(_session, options): Promise<RunResult> {
            started.resolve();
            return await new Promise<RunResult>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => {
                  reject(
                    new RunnerAbortedError("Runner cancelled by shutdown"),
                  );
                },
                { once: true },
              );
            });
          },
        },
        new NullLogger(),
      );
      const controller = new AbortController();
      const loop = orchestrator.runLoop(controller.signal);

      await started.promise;
      controller.abort();
      await loop;

      expect(tracker.retried).toEqual([
        {
          issueNumber: 76,
          reason: "Runner cancelled by shutdown",
        },
      ]);
      expect(tracker.failed).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("generates unique run session ids across orchestrator instances", async () => {
    const issue = createIssue(12);
    const firstTracker = new SequencedTracker({ ready: [issue] });
    const secondTracker = new SequencedTracker({ ready: [issue] });
    firstTracker.setLifecycleSequence(12, [
      lifecycle("missing-target", "symphony/12"),
      lifecycle("handoff-ready", "symphony/12"),
    ]);
    secondTracker.setLifecycleSequence(12, [
      lifecycle("missing-target", "symphony/12"),
      lifecycle("handoff-ready", "symphony/12"),
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

describe("BootstrapOrchestrator watchdog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("symphony-watchdog-test-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("aborts a stalled runner when watchdog detects no progress", async () => {
    const issue = createIssue(99);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(99, [
      lifecycle("missing-target", "symphony/99"),
      lifecycle("handoff-ready", "symphony/99"),
    ]);

    const runStarted = createDeferred<void>();
    let runAborted = false;

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        runStarted.resolve();
        // Simulate a runner that stalls indefinitely until aborted
        return new Promise<RunResult>((resolve, reject) => {
          const handleAbort = (): void => {
            runAborted = true;
            reject(new RunnerAbortedError("Aborted"));
          };
          if (options?.signal?.aborted) {
            handleAbort();
            return;
          }
          options?.signal?.addEventListener("abort", handleAbort, {
            once: true,
          });
        });
      },
    };

    const staticProbe = createObservableStalledProbe();

    const watchdogConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, root: tmpDir },
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 0,
          stallThresholdMs: 0, // immediate stall detection for testing
          maxRecoveryAttempts: 1,
        },
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      stalledRunner,
      new NullLogger(),
      undefined,
      staticProbe,
    );

    // Start runOnce in background — it will start the runner and then check watchdog
    const runOncePromise = orchestrator.runOnce();

    // Wait for the runner to start
    await runStarted.promise;

    // The runOnce should eventually abort the stalled runner via watchdog
    // and handle the resulting error
    await runOncePromise;

    expect(runAborted).toBe(true);
  });

  it("does not recover beyond maxRecoveryAttempts across retries", async () => {
    const issue = createIssue(88);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(88, [
      lifecycle("missing-target", "symphony/88"),
      lifecycle("handoff-ready", "symphony/88"),
    ]);

    let abortCount = 0;

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        return new Promise<RunResult>((resolve, reject) => {
          const handleAbort = (): void => {
            abortCount += 1;
            reject(new RunnerAbortedError("Aborted"));
          };
          if (options?.signal?.aborted) {
            handleAbort();
            return;
          }
          options?.signal?.addEventListener("abort", handleAbort, {
            once: true,
          });
        });
      },
    };

    const watchdogConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, root: tmpDir },
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 0,
          stallThresholdMs: 0,
          maxRecoveryAttempts: 1,
        },
      },
    };

    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      stalledRunner,
      logger,
      undefined,
      createObservableStalledProbe(),
    );

    // First runOnce — should use the only recovery budget and schedule a retry.
    await orchestrator.runOnce();
    expect(abortCount).toBe(1);

    // Second runOnce resumes the same issue from retry state. The watchdog should
    // abort terminally instead of resetting the recovery budget.
    await orchestrator.runOnce();

    expect(abortCount).toBe(2);
    expect(tracker.retried).toHaveLength(1);
    expect(tracker.failed).toEqual([
      {
        issueNumber: 88,
        reason: "Aborted",
      },
    ]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(tmpDir),
    );
    expect(snapshot.lastAction?.kind).toBe("issue-failed");
  });

  it("aborts a stalled runner even when recovery is exhausted", async () => {
    const issue = createIssue(66);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(66, [
      lifecycle("missing-target", "symphony/66"),
      lifecycle("handoff-ready", "symphony/66"),
    ]);

    let abortCount = 0;
    const abortSnapshot = createDeferred<{
      kind: string | null;
      issueNumber: number | null;
      summary: string | null;
    }>();

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        return new Promise<RunResult>((_resolve, reject) => {
          const handleAbort = (): void => {
            abortCount += 1;
            void readFactoryStatusSnapshot(deriveStatusFilePath(tmpDir))
              .then((snapshot) => {
                abortSnapshot.resolve({
                  kind: snapshot.lastAction?.kind ?? null,
                  issueNumber: snapshot.lastAction?.issueNumber ?? null,
                  summary: snapshot.lastAction?.summary ?? null,
                });
              })
              .catch(() => {
                abortSnapshot.resolve({
                  kind: null,
                  issueNumber: null,
                  summary: null,
                });
              });
            reject(new RunnerAbortedError("Aborted"));
          };
          if (options?.signal?.aborted) {
            handleAbort();
            return;
          }
          options?.signal?.addEventListener("abort", handleAbort, {
            once: true,
          });
        });
      },
    };

    const watchdogConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, root: tmpDir },
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 0,
          stallThresholdMs: 0,
          maxRecoveryAttempts: 0,
        },
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      stalledRunner,
      new NullLogger(),
      undefined,
      createObservableStalledProbe(),
    );

    await orchestrator.runOnce();

    expect(abortCount).toBe(1);
    await expect(abortSnapshot.promise).resolves.toMatchObject({
      kind: "watchdog-recovery-exhausted",
      issueNumber: 66,
    });
    await expect(abortSnapshot.promise).resolves.toMatchObject({
      summary: expect.stringContaining("recovery limit reached"),
    });
  });

  it("stops the watchdog when the runner throws before completion", async () => {
    const issue = createIssue(77);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(77, [
      lifecycle("missing-target", "symphony/77"),
    ]);

    const watchdogConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, root: tmpDir },
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 0,
          stallThresholdMs: 0,
          maxRecoveryAttempts: 1,
        },
      },
    };

    const logger = new NullLogger();
    const { NullLivenessProbe } =
      await import("../../src/orchestrator/liveness-probe.js");

    const failingRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run() {
        throw new Error("runner crashed");
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      failingRunner,
      logger,
      undefined,
      new NullLivenessProbe(),
    );

    await orchestrator.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(tmpDir),
    );
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery");
    expect(
      tracker.retried.some(({ reason }) => reason.includes("Stall detected")),
    ).toBe(false);
  });

  it("warns when watchdog is enabled without a liveness probe", async () => {
    const issue = createIssue(55);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(55, [
      lifecycle("handoff-ready", "symphony/55"),
    ]);

    const watchdogConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, root: tmpDir },
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 0,
          stallThresholdMs: 0,
          maxRecoveryAttempts: 1,
        },
      },
    };

    const logger = new NullLogger();
    const successfulRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run() {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      successfulRunner,
      logger,
    );

    await orchestrator.runOnce();

    expect(logger.warnings).toContainEqual({
      message:
        "Watchdog is enabled but no liveness probe was provided; stall detection is disabled",
      data: { issueNumber: 55 },
    });
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(tmpDir),
    );
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery");
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery-exhausted");
  });
});
