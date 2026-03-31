import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFactoryHaltRecord,
  writeFactoryHaltRecord,
} from "../../src/domain/factory-halt.js";
import {
  RunnerAbortedError,
  RunnerShutdownError,
} from "../../src/domain/errors.js";
import type { HandoffLifecycle } from "../../src/domain/handoff.js";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RunSession } from "../../src/domain/run.js";
import type { PreparedWorkspace } from "../../src/domain/workspace.js";
import {
  createConfiguredWorkspaceSource,
  getPreparedWorkspacePath,
} from "../../src/domain/workspace.js";
import type {
  PromptBuilder,
  ResolvedConfig,
  WatchdogConfig,
} from "../../src/domain/workflow.js";
import { deriveRuntimeInstancePaths } from "../../src/domain/workflow.js";
import { LocalIssueLeaseManager } from "../../src/orchestrator/issue-lease.js";
import {
  NullLivenessProbe,
  type LivenessProbe,
} from "../../src/orchestrator/liveness-probe.js";
import { BootstrapOrchestrator } from "../../src/orchestrator/service.js";
import {
  deriveFactoryRuntimeRoot,
  readIssueArtifactAttempt,
  readIssueArtifactEvents,
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
import type {
  LiveRunnerSession,
  Runner,
  RunnerExecutionResult,
  RunnerTurnResult,
} from "../../src/runner/service.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import type { Tracker } from "../../src/tracker/service.js";
import type { LandingExecutionResult } from "../../src/tracker/service.js";
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
      // Keep logSizeBytes fixed at 1 so the first watchdog poll observes a
      // null -> 1 log transition, then all later polls stall on unchanged
      // liveness. That exercises recovery paths without runner-side progress.
      return {
        logSizeBytes: 1,
        workspaceDiffHash: null,
        prHeadSha: options.prHeadSha,
        runStartedAt: options.runStartedAt,
        runnerPhase: options.runnerPhase,
        runnerHeartbeatAt: options.runnerHeartbeatAt,
        runnerActionAt: options.runnerActionAt,
        hasActionableFeedback: options.hasActionableFeedback,
        capturedAt: Date.now(),
      };
    },
  };
}

function createRunnerVisibilityProbe(): LivenessProbe {
  return {
    async capture(options) {
      return {
        logSizeBytes: null,
        workspaceDiffHash: null,
        prHeadSha: options.prHeadSha,
        runStartedAt: options.runStartedAt,
        runnerPhase: options.runnerPhase,
        runnerHeartbeatAt: options.runnerHeartbeatAt,
        runnerActionAt: options.runnerActionAt,
        hasActionableFeedback: options.hasActionableFeedback,
        capturedAt: Date.now(),
      };
    },
  };
}

function createWatchdogConfig(
  overrides: Partial<WatchdogConfig>,
): WatchdogConfig {
  const stallThresholdMs = overrides.stallThresholdMs ?? 0;
  return {
    enabled: true,
    checkIntervalMs: 0,
    stallThresholdMs,
    executionStallThresholdMs:
      overrides.executionStallThresholdMs ?? stallThresholdMs,
    prFollowThroughStallThresholdMs:
      overrides.prFollowThroughStallThresholdMs ?? stallThresholdMs,
    maxRecoveryAttempts: 1,
    ...overrides,
  };
}

function createAdvancingLogProbe(): LivenessProbe {
  let logSizeBytes = 0;
  return {
    async capture(options) {
      logSizeBytes += 1;
      return {
        logSizeBytes,
        workspaceDiffHash: "workspace-diff-1",
        prHeadSha: options.prHeadSha,
        runStartedAt: options.runStartedAt,
        runnerPhase: options.runnerPhase,
        runnerHeartbeatAt: options.runnerHeartbeatAt,
        runnerActionAt: options.runnerActionAt,
        hasActionableFeedback: options.hasActionableFeedback,
        capturedAt: Date.now(),
      };
    },
  };
}

const BASE_INSTANCE_ROOT = path.join(
  "/tmp",
  `symphony-orchestrator-test-${process.pid}`,
);

function deriveTestInstance(root: string) {
  return deriveRuntimeInstancePaths({
    workflowPath: path.join(root, "WORKFLOW.md"),
    workspaceRoot: root,
  });
}

function withLocalInstanceRoot(
  config: ResolvedConfig,
  root: string,
): ResolvedConfig {
  const instance = deriveTestInstance(root);
  return {
    ...config,
    workflowPath: path.join(root, "WORKFLOW.md"),
    instance,
    workspace: {
      ...config.workspace,
      root,
    },
  };
}

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(root, {
        recursive: true,
        force: true,
      });
      return;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" ||
        attempt === 4
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const baseConfig: ResolvedConfig = {
  workflowPath: path.join(BASE_INSTANCE_ROOT, "WORKFLOW.md"),
  instance: deriveTestInstance(BASE_INSTANCE_ROOT),
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
    root: BASE_INSTANCE_ROOT,
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

function createRemoteConfig(
  workspaceRoot: string,
  workerHostNames: readonly string[] = ["builder-a"],
): ResolvedConfig {
  const workerHosts = {
    "builder-a": {
      name: "builder-a",
      sshDestination: "builder-a@example.test",
      sshExecutable: "ssh",
      sshOptions: [],
      workspaceRoot: "/srv/symphony/a",
    },
    "builder-b": {
      name: "builder-b",
      sshDestination: "builder-b@example.test",
      sshExecutable: "ssh",
      sshOptions: [],
      workspaceRoot: "/srv/symphony/b",
    },
  } as const;

  return {
    ...withLocalInstanceRoot(baseConfig, workspaceRoot),
    workspace: {
      ...baseConfig.workspace,
      root: workspaceRoot,
      workerHosts,
    },
    agent: {
      ...baseConfig.agent,
      runner: {
        kind: "codex",
        remoteExecution: {
          kind: "ssh",
          workerHostNames,
          workerHosts: workerHostNames.map((workerHostName) => {
            return workerHosts[workerHostName as keyof typeof workerHosts];
          }),
        },
      },
    },
  };
}

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
  readonly landingRequests: number[] = [];
  readonly retried: Array<{ issueNumber: number; reason: string }> = [];
  readonly failed: Array<{ issueNumber: number; reason: string }> = [];
  readonly resolvedThreadBatches: string[][] = [];
  inspectIssueHandoffCalls = 0;
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
    this.inspectIssueHandoffCalls += 1;
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

  async executeLanding(
    pullRequest: NonNullable<HandoffLifecycle["pullRequest"]>,
  ): Promise<LandingExecutionResult> {
    this.landingRequests.push(pullRequest.number);
    return {
      kind: "requested",
      summary: `Landing requested for ${pullRequest.url}.`,
    };
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

class ClosedIssueTracker extends SequencedTracker {
  override async getIssue(issueNumber: number): Promise<RuntimeIssue> {
    if (this.completed.includes(issueNumber)) {
      return {
        ...createIssue(issueNumber, "symphony:running"),
        labels: [],
        state: "closed",
        closedAt: "2026-03-11T12:06:00.000Z",
      };
    }
    return await super.getIssue(issueNumber);
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

class FailOnceLandingTracker extends SequencedTracker {
  landingFailuresRemaining = 1;

  override async executeLanding(
    pullRequest: NonNullable<HandoffLifecycle["pullRequest"]>,
  ): Promise<LandingExecutionResult> {
    this.landingRequests.push(pullRequest.number);
    if (this.landingFailuresRemaining > 0) {
      this.landingFailuresRemaining -= 1;
      throw new Error("merge temporarily blocked");
    }
    return {
      kind: "requested",
      summary: `Landing requested for ${pullRequest.url}.`,
    };
  }
}

class BlockedLandingTracker extends SequencedTracker {
  override async executeLanding(
    pullRequest: NonNullable<HandoffLifecycle["pullRequest"]>,
  ): Promise<LandingExecutionResult> {
    this.landingRequests.push(pullRequest.number);
    return {
      kind: "blocked",
      reason: "review-threads-unresolved",
      lifecycleKind: "awaiting-human-review",
      summary: `Landing blocked for ${pullRequest.url} because unresolved non-outdated review threads remain.`,
    };
  }
}

class StaleApprovedHeadLandingTracker extends SequencedTracker {
  override async executeLanding(
    pullRequest: NonNullable<HandoffLifecycle["pullRequest"]>,
  ): Promise<LandingExecutionResult> {
    this.landingRequests.push(pullRequest.number);
    return {
      kind: "blocked",
      reason: "stale-approved-head",
      lifecycleKind: "awaiting-landing-command",
      summary: `Landing blocked for ${pullRequest.url} because the approved head is stale.`,
    };
  }
}

class AlreadyMergedLandingTracker extends SequencedTracker {
  override async executeLanding(
    pullRequest: NonNullable<HandoffLifecycle["pullRequest"]>,
  ): Promise<LandingExecutionResult> {
    this.landingRequests.push(pullRequest.number);
    return {
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "merged",
      summary: `Landing blocked for ${pullRequest.url} because it is already merged.`,
    };
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
      branchName: `symphony/${issue.number}`,
      createdNow: true,
      source: createConfiguredWorkspaceSource("/tmp/repo.git"),
      target: {
        kind: "local",
        path: `/tmp/workspaces/${issue.number}`,
      },
    };
  }

  async cleanupWorkspace(
    _workspace: PreparedWorkspace,
  ): Promise<{ kind: "deleted"; workspacePath: string }> {
    const workspacePath = getPreparedWorkspacePath(_workspace);
    if (workspacePath === null) {
      throw new Error("expected local workspace path");
    }
    return {
      kind: "deleted",
      workspacePath,
    };
  }

  async cleanupWorkspaceForIssue({
    issue,
  }: {
    readonly issue: RuntimeIssue;
  }): Promise<{ kind: "deleted"; workspacePath: string }> {
    return await this.cleanupWorkspace({
      key: `sociotechnica-org_symphony-ts_${issue.number}`,
      branchName: `symphony/${issue.number}`,
      createdNow: false,
      source: createConfiguredWorkspaceSource("/tmp/repo.git"),
      target: {
        kind: "local",
        path: `/tmp/workspaces/${issue.number}`,
      },
    });
  }
}

class CleanupFailingWorkspaceManager extends StaticWorkspaceManager {
  readonly cleaned: string[] = [];

  override async cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<{ kind: "deleted"; workspacePath: string }> {
    const workspacePath = getPreparedWorkspacePath(workspace);
    if (workspacePath === null) {
      throw new Error("expected local workspace path");
    }
    this.cleaned.push(workspacePath);
    throw new Error("rm failed");
  }
}

class TrackingWorkspaceManager extends StaticWorkspaceManager {
  readonly cleaned: string[] = [];

  override async cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<{ kind: "deleted"; workspacePath: string }> {
    const workspacePath = getPreparedWorkspacePath(workspace);
    if (workspacePath === null) {
      throw new Error("expected local workspace path");
    }
    this.cleaned.push(workspacePath);
    return {
      kind: "deleted",
      workspacePath,
    };
  }
}

class PrepareFailingWorkspaceManager extends TrackingWorkspaceManager {
  override async prepareWorkspace({
    issue,
  }: {
    readonly issue: RuntimeIssue;
  }): Promise<PreparedWorkspace> {
    this.prepared.push(`/tmp/workspaces/${issue.number}`);
    throw new Error("workspace prepare crashed");
  }
}

const failingPromptBuilder: PromptBuilder = {
  ...staticPromptBuilder,
  async build(): Promise<string> {
    throw new Error("prompt build crashed");
  },
};

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

  async run(session: RunSession): Promise<RunnerExecutionResult> {
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

  async run(session: RunSession): Promise<RunnerExecutionResult> {
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

class StartSessionRejectingRunner extends RecordingRunner {
  async startSession(): Promise<never> {
    throw new Error("failed to start live session");
  }
}

class SecondTurnFailingLiveRunner implements Runner {
  describeSession() {
    return createRunnerSessionDescription();
  }

  async run(): Promise<RunnerExecutionResult> {
    throw new Error("runner.run should not be called");
  }

  async startSession(): Promise<LiveRunnerSession> {
    let latestTurnNumber: number | null = null;
    const backendSessionId = "codex-session-77";
    return {
      describe() {
        return {
          ...createRunnerSessionDescription(),
          backendSessionId,
          latestTurnNumber,
        };
      },
      async runTurn(turn): Promise<RunnerTurnResult> {
        latestTurnNumber = turn.turnNumber;
        const timestamp = formatTurnTimestamp(30, turn.turnNumber);
        return {
          exitCode: turn.turnNumber === 2 ? 17 : 0,
          stdout: "",
          stderr: turn.turnNumber === 2 ? "simulated failure" : "",
          startedAt: timestamp,
          finishedAt: timestamp,
          session: {
            ...createRunnerSessionDescription(),
            backendSessionId,
            latestTurnNumber,
          },
        };
      },
      async close(): Promise<void> {},
    };
  }
}

class RecordingLiveSessionRunner implements Runner {
  describeSession() {
    return createRunnerSessionDescription();
  }

  async run(): Promise<RunnerExecutionResult> {
    throw new Error("runner.run should not be called");
  }

  async startSession(): Promise<LiveRunnerSession> {
    let latestTurnNumber: number | null = null;
    const backendSessionId = "codex-session-77";
    return {
      describe() {
        return {
          ...createRunnerSessionDescription(),
          backendSessionId,
          latestTurnNumber,
        };
      },
      async runTurn(turn): Promise<RunnerTurnResult> {
        latestTurnNumber = turn.turnNumber;
        const timestamp = formatTurnTimestamp(40, turn.turnNumber);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: timestamp,
          finishedAt: timestamp,
          session: {
            ...createRunnerSessionDescription(),
            backendSessionId,
            latestTurnNumber,
          },
        };
      },
      async close(): Promise<void> {},
    };
  }
}

class StaleSignalThenOrdinaryFailureLiveRunner implements Runner {
  describeSession() {
    return createRunnerSessionDescription();
  }

  async run(): Promise<RunnerExecutionResult> {
    throw new Error("runner.run should not be called");
  }

  async startSession(): Promise<LiveRunnerSession> {
    let latestTurnNumber: number | null = null;
    const backendSessionId = "codex-session-stale-signal";
    return {
      describe() {
        return {
          ...createRunnerSessionDescription(),
          backendSessionId,
          latestTurnNumber,
        };
      },
      async runTurn(turn, options): Promise<RunnerTurnResult> {
        latestTurnNumber = turn.turnNumber;
        const timestamp = formatTurnTimestamp(45, turn.turnNumber);
        if (turn.turnNumber === 1) {
          options?.onUpdate?.({
            event: "account/rateLimits/updated",
            timestamp,
            payload: {
              params: {
                rateLimits: {
                  limitId: "core",
                  primary: {
                    used: 100,
                    limit: 100,
                    resetInMs: 60_000,
                  },
                },
              },
            },
          });
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            startedAt: timestamp,
            finishedAt: timestamp,
            session: {
              ...createRunnerSessionDescription(),
              backendSessionId,
              latestTurnNumber,
            },
          };
        }
        return {
          exitCode: 17,
          stdout: "",
          stderr: "temporary sandbox crash",
          startedAt: timestamp,
          finishedAt: timestamp,
          session: {
            ...createRunnerSessionDescription(),
            backendSessionId,
            latestTurnNumber,
          },
        };
      },
      async close(): Promise<void> {},
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

function formatTurnTimestamp(baseMinute: number, turnNumber: number): string {
  const minute = (baseMinute + turnNumber) % 60;
  const hour = 16 + Math.floor((baseMinute + turnNumber) / 60);
  return `2026-03-09T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00.000Z`;
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

  async run(session: RunSession): Promise<RunnerExecutionResult> {
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
    await fs.rm(deriveFactoryRuntimeRoot(baseConfig.instance), {
      recursive: true,
      force: true,
    });
  });

  afterEach(async () => {
    await fs.rm(deriveFactoryRuntimeRoot(baseConfig.instance), {
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
        withLocalInstanceRoot(baseConfig, tempRoot),
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
      await removeTempRoot(tempRoot);
    }
  });

  it("starts the highest-priority ready issue first when capacity is constrained", async () => {
    const tempRoot = await createTempDir("symphony-ready-priority-test-");
    try {
      const lowPriorityIssue = {
        ...createIssue(1),
        title: "Low priority",
        queuePriority: { rank: 2, label: "P2" },
      };
      const highestPriorityIssue = {
        ...createIssue(2),
        title: "Highest priority",
        queuePriority: { rank: 0, label: "P0" },
      };
      const fallbackIssue = {
        ...createIssue(3),
        title: "Fallback issue",
      };
      const tracker = new SequencedTracker({
        ready: [lowPriorityIssue, fallbackIssue, highestPriorityIssue],
      });
      tracker.setLifecycleSequence(2, [
        lifecycle("missing-target", "symphony/2"),
        lifecycle("handoff-ready", "symphony/2"),
      ]);

      const runnerIssues: number[] = [];
      const runner: Runner = {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(session): Promise<RunnerExecutionResult> {
          runnerIssues.push(session.issue.number);
          const timestamp = new Date().toISOString();
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      };

      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              maxConcurrentRuns: 1,
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        runner,
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(runnerIssues).toEqual([2]);
      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.readyQueue).toEqual([
        {
          issueNumber: 2,
          issueIdentifier: "sociotechnica-org/symphony-ts#2",
          title: "Highest priority",
          queuePriorityRank: 0,
          queuePriorityLabel: "P0",
        },
        {
          issueNumber: 1,
          issueIdentifier: "sociotechnica-org/symphony-ts#1",
          title: "Low priority",
          queuePriorityRank: 2,
          queuePriorityLabel: "P2",
        },
        {
          issueNumber: 3,
          issueIdentifier: "sociotechnica-org/symphony-ts#3",
          title: "Fallback issue",
          queuePriorityRank: null,
          queuePriorityLabel: null,
        },
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps running-issue precedence ahead of higher-priority ready work", async () => {
    const tempRoot = await createTempDir("symphony-running-precedence-test-");
    try {
      const runningIssue = createIssue(10, "symphony:running");
      const readyIssue = {
        ...createIssue(11),
        title: "Urgent ready issue",
        queuePriority: { rank: 0, label: "P0" },
      };
      const tracker = new SequencedTracker({
        ready: [readyIssue],
        running: [runningIssue],
      });
      tracker.setLifecycleSequence(10, [
        lifecycle("awaiting-human-review", "symphony/10"),
      ]);

      const runnerIssues: number[] = [];
      const runner: Runner = {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(session): Promise<RunnerExecutionResult> {
          runnerIssues.push(session.issue.number);
          const timestamp = new Date().toISOString();
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            startedAt: timestamp,
            finishedAt: timestamp,
          };
        },
      };

      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              maxConcurrentRuns: 1,
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        runner,
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(runnerIssues).toEqual([]);
      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.activeIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            issueNumber: 10,
            status: "awaiting-human-review",
          }),
        ]),
      );
      expect(snapshot.readyQueue).toEqual([
        {
          issueNumber: 11,
          issueIdentifier: "sociotechnica-org/symphony-ts#11",
          title: "Urgent ready issue",
          queuePriorityRank: 0,
          queuePriorityLabel: "P0",
        },
      ]);
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
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: { ...baseConfig.polling, intervalMs: 1 },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        logger,
      );
      const controller = new AbortController();
      const loop = orchestrator.runLoop(controller.signal);

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
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
      await removeTempRoot(tempRoot);
    }
  });

  it("projects degraded observability in the live snapshot until a current status snapshot is published", async () => {
    const tempRoot = await createTempDir(
      "symphony-startup-publication-posture-test-",
    );
    try {
      const tracker = new SequencedTracker({
        ready: [],
        running: [],
      });
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        new NullLogger(),
      );

      expect(orchestrator.snapshot().recoveryPosture.summary.family).toBe(
        "degraded-observability",
      );

      await orchestrator.runOnce();

      expect(orchestrator.snapshot().recoveryPosture.summary.family).not.toBe(
        "degraded-observability",
      );
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
        async run(): Promise<RunnerExecutionResult> {
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
        lifecycle("awaiting-landing-command", "symphony/47"),
      ]);
      let runnerCalls = 0;
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(): Promise<RunnerExecutionResult> {
            runnerCalls += 1;
            throw new Error("runner should not be called");
          },
        },
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(runnerCalls).toBe(0);
      expect(tracker.landingRequests).toEqual([]);
      expect(tracker.completed).toEqual([]);
      expect(tracker.retried).toEqual([]);

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.lastAction?.kind).toBe("awaiting-landing-command");
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-landing-command");

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        47,
      );
      expect(summary.currentOutcome).toBe("awaiting-landing-command");
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
        withLocalInstanceRoot(baseConfig, tempRoot),
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
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-human-handoff");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves approved pre-PR lifecycle context in the next prompt after plan review", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(34)],
    });
    tracker.setLifecycleSequence(34, [
      lifecycle("missing-target", "symphony/34"),
      lifecycle("missing-target", "symphony/34", {
        summary:
          "Plan review approved for symphony/34; resume implementation before opening a pull request.",
      }),
      lifecycle("handoff-ready", "symphony/34"),
    ]);

    const runner = new RecordingRunner();
    const lifecyclePromptBuilder: PromptBuilder = {
      async build({ issue, attempt, pullRequest }): Promise<string> {
        return JSON.stringify({
          issue: issue.identifier,
          attempt,
          lifecycleKind: pullRequest?.kind ?? null,
          lifecycleSummary: pullRequest?.summary ?? null,
          pullRequestNumber: pullRequest?.pullRequest?.number ?? null,
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
          lifecycleKind: pullRequest?.kind ?? null,
          lifecycleSummary: pullRequest?.summary ?? null,
          mode: "continuation",
        });
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      lifecyclePromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(runner.prompts).toEqual([
      JSON.stringify({
        issue: "sociotechnica-org/symphony-ts#34",
        attempt: null,
        lifecycleKind: "missing-target",
        lifecycleSummary: "No open pull request found for symphony/34",
        pullRequestNumber: null,
      }),
      JSON.stringify({
        issue: "sociotechnica-org/symphony-ts#34",
        turnNumber: 2,
        maxTurns: 3,
        lifecycleKind: "missing-target",
        lifecycleSummary:
          "Plan review approved for symphony/34; resume implementation before opening a pull request.",
        mode: "continuation",
      }),
    ]);
  });

  it("warns when continuation turns fall back to cold-start subprocesses", async () => {
    const tempRoot = await createTempDir("symphony-cold-start-warning-test-");
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(33)],
      });
      tracker.setLifecycleSequence(33, [
        lifecycle("missing-target", "symphony/33"),
        lifecycle("rework-required", "symphony/33"),
        lifecycle("handoff-ready", "symphony/33"),
      ]);
      const logger = new NullLogger();
      const runner = new RecordingRunner();
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        runner,
        logger,
      );

      await orchestrator.runOnce();

      expect(runner.prompts).toHaveLength(2);
      expect(logger.warnings).toContainEqual({
        message:
          "Runner does not support live continuation sessions; continuation turns will cold-start new subprocesses",
        data: expect.objectContaining({
          issueNumber: 33,
          maxTurns: 3,
        }),
      });
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
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.activeIssues).toHaveLength(1);
      expect(snapshot.activeIssues[0]?.source).toBe("running");
      expect(snapshot.activeIssues[0]?.status).toBe("awaiting-system-checks");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps an unmatched live run visible in the TUI snapshot during cleanup", async () => {
    const tempRoot = await createTempDir("symphony-tui-snapshot-test-");
    try {
      const issue = createIssue(245);
      const tracker = new SequencedTracker({ ready: [issue] });
      tracker.setLifecycleSequence(245, [
        lifecycle("handoff-ready", "symphony/245"),
      ]);
      const closeStarted = createDeferred<void>();
      const allowClose = createDeferred<void>();
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(): Promise<RunnerExecutionResult> {
            throw new Error(
              "run should not be called when startSession is used",
            );
          },
          async startSession(): Promise<LiveRunnerSession> {
            const sessionDescription = {
              ...createRunnerSessionDescription(),
              backendSessionId: "backend-session-245",
            };
            return {
              describe() {
                return sessionDescription;
              },
              async runTurn(turn): Promise<RunnerTurnResult> {
                const timestamp = formatTurnTimestamp(50, turn.turnNumber);
                return {
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                  startedAt: timestamp,
                  finishedAt: timestamp,
                  session: sessionDescription,
                };
              },
              async close(): Promise<void> {
                closeStarted.resolve();
                await allowClose.promise;
              },
            };
          },
        },
        new NullLogger(),
      );

      const runOncePromise = orchestrator.runOnce();
      await closeStarted.promise;

      const snapshot = orchestrator.snapshot();
      expect(snapshot.liveRunCount).toBe(1);
      expect(snapshot.tickets).toHaveLength(1);
      expect(snapshot.tickets[0]).toMatchObject({
        issueNumber: 245,
        identifier: "sociotechnica-org/symphony-ts#245",
        status: "running",
      });
      expect(snapshot.tickets[0]?.liveRun).not.toBeNull();

      allowClose.resolve();
      await runOncePromise;
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
        lifecycle("rework-required", "symphony/70", {
          failingCheckNames: ["CI"],
        }),
      ]);
      let runnerCalls = 0;
      const lockDir = path.join(tempRoot, ".symphony-locks", "70");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(): Promise<RunnerExecutionResult> {
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
        withLocalInstanceRoot(baseConfig, tempRoot),
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

  it("clears recovered shutdown leases during startup reconciliation", async () => {
    const tempRoot = await createTempDir(
      "symphony-shutdown-reconcile-clear-test-",
    );
    try {
      const issue = createIssue(82, "symphony:running");
      const tracker = new SequencedTracker({
        running: [issue],
      });
      const lockDir = path.join(tempRoot, ".symphony-locks", "82");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 82,
            issueIdentifier: issue.identifier,
            branchName: "symphony/82",
            runSessionId: `${issue.identifier}/attempt-1/shutdown`,
            attempt: 1,
            ownerPid: 999999,
            runnerPid: null,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: null,
            shutdown: {
              state: "shutdown-terminated",
              requestedAt: new Date().toISOString(),
              gracefulDeadlineAt: new Date().toISOString(),
              terminatedAt: new Date().toISOString(),
              reasonSummary: "Runner exited during coordinated shutdown",
              updatedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              maxConcurrentRuns: 0,
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const leaseManager = new LocalIssueLeaseManager(
        tempRoot,
        new NullLogger(),
      );
      expect((await leaseManager.inspect(82)).kind).toBe("missing");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate reruns when inherited running work is already awaiting review", async () => {
    const tempRoot = await createTempDir("symphony-restart-suppressed-test-");
    try {
      const issue = createIssue(83, "symphony:running");
      const tracker = new SequencedTracker({
        running: [issue],
      });
      tracker.setLifecycleSequence(83, [
        lifecycle("awaiting-human-review", "symphony/83"),
      ]);
      const lockDir = path.join(tempRoot, ".symphony-locks", "83");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), "999999\n", "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 83,
            issueIdentifier: issue.identifier,
            branchName: "symphony/83",
            runSessionId: `${issue.identifier}/attempt-1/orphaned`,
            attempt: 1,
            ownerPid: 999999,
            runnerPid: null,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: null,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      const runner = new RecordingRunner();
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        runner,
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(runner.sessionIds).toEqual([]);
      expect(tracker.completed).toEqual([]);
      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.restartRecovery?.state).toBe("ready");
      expect(status.restartRecovery?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            issueNumber: 83,
            decision: "suppressed-terminal",
            lifecycleKind: "awaiting-human-review",
          }),
        ]),
      );
      expect(
        (
          await new LocalIssueLeaseManager(tempRoot, new NullLogger()).inspect(
            83,
          )
        ).kind,
      ).toBe("missing");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("repopulates host occupancy from adopted inherited remote runs", async () => {
    const tempRoot = await createTempDir("symphony-remote-restart-host-test-");
    try {
      const inheritedIssue = createIssue(84, "symphony:running");
      const readyIssue = createIssue(85);
      const tracker = new SequencedTracker({
        ready: [readyIssue],
        running: [inheritedIssue],
      });
      const lockDir = path.join(tempRoot, ".symphony-locks", "84");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
      await fs.writeFile(
        path.join(lockDir, "run.json"),
        JSON.stringify(
          {
            issueNumber: 84,
            issueIdentifier: inheritedIssue.identifier,
            branchName: "symphony/84",
            runSessionId: `${inheritedIssue.identifier}/attempt-1/remote`,
            attempt: 1,
            executionOwner: {
              factory: {
                host: "factory-host",
                instanceId: "factory-instance",
                pid: process.pid,
              },
              runSessionId: `${inheritedIssue.identifier}/attempt-1/remote`,
              transport: {
                kind: "remote-stdio-session",
                localProcess: null,
                remoteSessionId: "remote-session-84",
                remoteTaskId: null,
              },
              localControl: null,
              endpoint: {
                workspaceTargetKind: "remote",
                workspaceHost: "builder-a",
                workspacePath: null,
                workspaceId: "builder-a:sociotechnica-org_symphony-ts_84",
                provider: "codex",
                model: null,
                backendSessionId: "remote-session-84",
                backendThreadId: null,
              },
            },
            ownerPid: process.pid,
            runnerPid: null,
            runRecordedAt: new Date().toISOString(),
            runnerStartedAt: new Date().toISOString(),
            shutdown: null,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      const runner = new RecordingRunner();
      const orchestrator = new BootstrapOrchestrator(
        createRemoteConfig(tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        runner,
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(runner.sessionIds).toEqual([]);
      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.hostDispatch).toEqual({
        hosts: [
          {
            name: "builder-a",
            occupiedByIssueNumber: 84,
            preferredIssueNumbers: [84],
          },
        ],
      });
      expect(status.activeIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            issueNumber: 85,
            status: "queued",
            blockedReason: expect.stringContaining(
              "No remote worker host is currently available",
            ),
          }),
        ]),
      );
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
    const originalInspect = LocalIssueLeaseManager.prototype.inspect;
    const inspectSpy = vi
      .spyOn(LocalIssueLeaseManager.prototype, "inspect")
      .mockImplementation(async function mockInspect(
        this: LocalIssueLeaseManager,
        issueNumber,
      ) {
        if (issueNumber === 77) {
          throw new Error("simulated reconcile failure");
        }
        return await originalInspect.call(this, issueNumber);
      });

    try {
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        logger,
      );

      await orchestrator.runOnce();
    } finally {
      inspectSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    expect(tracker.completed).toEqual([78]);
    expect(logger.errors).toContain(
      "Failed to reconcile running issue ownership",
    );
    expect(logger.errors).not.toContain("Poll cycle failed");
  });

  it("releases reserved remote worker hosts when prompt building fails before run startup", async () => {
    const tempRoot = await createTempDir(
      "symphony-remote-prompt-failure-test-",
    );
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(86)],
      });
      const orchestrator = new BootstrapOrchestrator(
        createRemoteConfig(tempRoot),
        failingPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.hostDispatch).toEqual({
        hosts: [
          {
            name: "builder-a",
            occupiedByIssueNumber: null,
            preferredIssueNumbers: [86],
          },
        ],
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
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
        withLocalInstanceRoot(baseConfig, tempRoot),
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
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
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
      withLocalInstanceRoot(baseConfig, tempRoot),
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
          retention: {
            ...baseConfig.workspace.retention,
            onSuccess: "delete",
          },
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      logger,
    );

    await orchestrator.runOnce();
    expect(tracker.landingRequests).toEqual([1]);
    expect(tracker.completed).toEqual([]);

    await orchestrator.runOnce();

    expect(tracker.landingRequests).toEqual([1]);
    expect(tracker.completed).toEqual([71]);
    expect(workspace.cleaned).toEqual(["/tmp/workspaces/71"]);
    expect(logger.errors).toContain("Workspace cleanup failed");
  });

  it("does not repeat landing when the current PR head SHA is unavailable", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(72, "symphony:running")],
    });
    const awaitingLandingWithoutHead: HandoffLifecycle = {
      ...lifecycle("awaiting-landing", "symphony/72"),
      pullRequest: {
        number: 1,
        url: "https://example.test/pulls/symphony/72",
        branchName: "symphony/72",
        headSha: null,
        latestCommitAt: new Date().toISOString(),
      },
    };
    tracker.setLifecycleSequence(72, [
      awaitingLandingWithoutHead,
      awaitingLandingWithoutHead,
      awaitingLandingWithoutHead,
      lifecycle("handoff-ready", "symphony/72"),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    await orchestrator.runOnce();
    expect(tracker.landingRequests).toEqual([1]);
    expect(tracker.completed).toEqual([]);

    await orchestrator.runOnce();
    expect(tracker.landingRequests).toEqual([1]);
    expect(tracker.completed).toEqual([]);

    await orchestrator.runOnce();
    expect(tracker.landingRequests).toEqual([1]);
    expect(tracker.completed).toEqual([72]);
  });

  it("records a failed landing attempt when awaiting-landing has no pull request handle", async () => {
    const tempRoot = await createTempDir("symphony-null-landing-handle-test-");
    const tracker = new SequencedTracker({
      running: [createIssue(74, "symphony:running")],
    });
    tracker.setLifecycleSequence(74, [
      {
        ...lifecycle("awaiting-landing", "symphony/74"),
        pullRequest: null,
      },
      {
        ...lifecycle("awaiting-landing", "symphony/74"),
        pullRequest: null,
      },
    ]);
    const logger = new NullLogger();
    const orchestrator = new BootstrapOrchestrator(
      withLocalInstanceRoot(baseConfig, tempRoot),
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      logger,
    );

    try {
      await orchestrator.runOnce();

      expect(tracker.landingRequests).toEqual([]);
      expect(tracker.completed).toEqual([]);
      expect(logger.warnings).toContainEqual({
        message: "Landing execution failed",
        data: expect.objectContaining({
          issueNumber: 74,
          pullRequestNumber: null,
          error: "Error: Cannot execute landing without a pull request handle",
        }),
      });

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        74,
      );
      expect(summary.currentOutcome).toBe("attempt-failed");
      const events = await readIssueArtifactEvents(
        deriveTestInstance(tempRoot),
        74,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "landing-failed",
          details: expect.objectContaining({
            success: false,
            error:
              "Error: Cannot execute landing without a pull request handle",
            pullRequest: null,
            summary:
              "Landing request failed for sociotechnica-org/symphony-ts#74: Error: Cannot execute landing without a pull request handle",
            lifecycleKind: "attempt-failed",
          }),
        }),
      );

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.lastAction?.kind).toBe("landing-failed");

      await orchestrator.runOnce();
      expect(tracker.landingRequests).toEqual([]);
      expect(tracker.completed).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records a blocked landing attempt and retries the same head on a later poll", async () => {
    const tempRoot = await createTempDir("symphony-blocked-landing-test-");
    const tracker = new BlockedLandingTracker({
      running: [createIssue(75, "symphony:running")],
    });
    tracker.setLifecycleSequence(75, [
      lifecycle("awaiting-landing", "symphony/75"),
      lifecycle("awaiting-human-review", "symphony/75"),
      lifecycle("awaiting-landing", "symphony/75"),
      lifecycle("awaiting-human-review", "symphony/75"),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      withLocalInstanceRoot(baseConfig, tempRoot),
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    try {
      await orchestrator.runOnce();
      await orchestrator.runOnce();

      expect(tracker.landingRequests).toEqual([1, 1]);

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        75,
      );
      expect(summary.currentOutcome).toBe("awaiting-human-review");

      const events = await readIssueArtifactEvents(
        deriveTestInstance(tempRoot),
        75,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "landing-blocked",
          details: expect.objectContaining({
            reason: "review-threads-unresolved",
            lifecycleKind: "awaiting-human-review",
            success: false,
          }),
        }),
      );

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.lastAction?.kind).toBe("landing-blocked");
      expect(status.activeIssues[0]?.blockedReason).toMatch(
        /unresolved non-outdated review threads remain/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps blocked landing status aligned with the landing result lifecycle kind", async () => {
    const tempRoot = await createTempDir("symphony-stale-approved-head-test-");
    const tracker = new StaleApprovedHeadLandingTracker({
      running: [createIssue(76, "symphony:running")],
    });
    tracker.setLifecycleSequence(76, [
      lifecycle("awaiting-landing", "symphony/76"),
      lifecycle("awaiting-system-checks", "symphony/76"),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      withLocalInstanceRoot(baseConfig, tempRoot),
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    try {
      await orchestrator.runOnce();

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        76,
      );
      expect(summary.currentOutcome).toBe("awaiting-system-checks");

      const events = await readIssueArtifactEvents(
        deriveTestInstance(tempRoot),
        76,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "landing-blocked",
          details: expect.objectContaining({
            reason: "stale-approved-head",
            lifecycleKind: "awaiting-landing-command",
            success: false,
          }),
        }),
      );

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.lastAction?.kind).toBe("landing-blocked");
      expect(status.activeIssues[0]).toMatchObject({
        issueNumber: 76,
        status: "awaiting-landing-command",
        branchName: "symphony/76",
      });
      expect(status.activeIssues[0]?.summary).toMatch(
        /approved head is stale/i,
      );
      expect(status.activeIssues[0]?.blockedReason).toMatch(
        /approved head is stale/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records already-merged landing races with merged artifact semantics before refresh completes", async () => {
    const tempRoot = await createTempDir(
      "symphony-already-merged-landing-test-",
    );
    const tracker = new AlreadyMergedLandingTracker({
      running: [createIssue(77, "symphony:running")],
    });
    tracker.setLifecycleSequence(77, [
      lifecycle("awaiting-landing", "symphony/77"),
      lifecycle("handoff-ready", "symphony/77"),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      withLocalInstanceRoot(baseConfig, tempRoot),
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    try {
      await orchestrator.runOnce();

      expect(tracker.landingRequests).toEqual([1]);
      expect(tracker.completed).toEqual([77]);

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        77,
      );
      expect(summary.currentOutcome).toBe("succeeded");

      const events = await readIssueArtifactEvents(
        deriveTestInstance(tempRoot),
        77,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "landing-blocked",
          details: expect.objectContaining({
            reason: "pull-request-not-mergeable",
            lifecycleKind: "merged",
            success: false,
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "succeeded",
        }),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not retry landing on the same head after a failed merge request", async () => {
    const tempRoot = await createTempDir("symphony-failed-landing-test-");
    const tracker = new FailOnceLandingTracker({
      running: [createIssue(73, "symphony:running")],
    });
    tracker.setLifecycleSequence(73, [
      lifecycle("awaiting-landing", "symphony/73"),
      lifecycle("awaiting-landing", "symphony/73"),
      lifecycle("awaiting-landing", "symphony/73"),
    ]);
    const orchestrator = new BootstrapOrchestrator(
      withLocalInstanceRoot(baseConfig, tempRoot),
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
    );

    try {
      await orchestrator.runOnce();
      expect(tracker.landingRequests).toEqual([1]);
      expect(tracker.completed).toEqual([]);

      const summary = await readIssueArtifactSummary(
        deriveTestInstance(tempRoot),
        73,
      );
      expect(summary.currentOutcome).toBe("attempt-failed");
      const events = await readIssueArtifactEvents(
        deriveTestInstance(tempRoot),
        73,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "landing-failed",
          details: expect.objectContaining({
            success: false,
            error: "Error: merge temporarily blocked",
            summary:
              "Landing request failed for sociotechnica-org/symphony-ts#73: Error: merge temporarily blocked",
            lifecycleKind: "attempt-failed",
          }),
        }),
      );

      await orchestrator.runOnce();
      expect(tracker.landingRequests).toEqual([1]);
      expect(tracker.completed).toEqual([]);

      await orchestrator.runOnce();
      expect(tracker.landingRequests).toEqual([1]);
      expect(tracker.completed).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reruns a running PR when CI or review feedback is actionable and resolves review threads", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(8, "symphony:running")],
    });
    tracker.setLifecycleSequence(8, [
      lifecycle("rework-required", "symphony/8", {
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
          retention: {
            ...baseConfig.workspace.retention,
            onSuccess: "delete",
          },
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
          retention: {
            ...baseConfig.workspace.retention,
            onSuccess: "delete",
          },
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
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
      lifecycle("rework-required", "symphony/9", {
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

  it("keeps a running issue active across repeated successful rework loops", async () => {
    const tracker = new SequencedTracker({
      running: [createIssue(73, "symphony:running")],
    });
    tracker.setLifecycleSequence(73, [
      lifecycle("rework-required", "symphony/73", {
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
      lifecycle("rework-required", "symphony/73", {
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

    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([]);
  });

  it("keeps rework loops active after waiting for review and checks", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(74)],
    });
    tracker.setLifecycleSequence(74, [
      lifecycle("missing-target", "symphony/74"),
      lifecycle("awaiting-system-checks", "symphony/74", {
        pendingCheckNames: ["CI"],
      }),
      lifecycle("rework-required", "symphony/74", {
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
      lifecycle("rework-required", "symphony/74", {
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
      lifecycle("rework-required", "symphony/13", {
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
        pullRequest: "missing-target",
      }),
      JSON.stringify({
        issue: "sociotechnica-org/symphony-ts#13",
        attempt: 2,
        pullRequest: "rework-required",
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
      async run(session): Promise<RunnerExecutionResult> {
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
        async run(_session, options): Promise<RunnerExecutionResult> {
          const timestamp = "2026-03-09T16:30:00.000Z";
          await options?.onEvent?.({
            kind: "spawned",
            transport: createRunnerTransportMetadata("local-process", {
              localProcessPid: runnerPid,
              canTerminateLocalProcess: true,
            }),
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
      baseConfig.instance,
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

    const attempt = await readIssueArtifactAttempt(baseConfig.instance, 77, 1);
    const session = await readIssueArtifactSession(
      baseConfig.instance,
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
        async run(_session, options): Promise<RunnerExecutionResult> {
          await options?.onEvent?.({
            kind: "spawned",
            transport: createRunnerTransportMetadata("local-process", {
              localProcessPid: runnerPid,
              canTerminateLocalProcess: true,
            }),
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

    const attempt = await readIssueArtifactAttempt(baseConfig.instance, 82, 1);
    expect(attempt.outcome).toBe("failed");
    expect(attempt.sessionId).not.toBeNull();
    expect(attempt.runnerPid).toBe(runnerPid);
  });

  it("records live-session turn metadata when a continuation turn fails", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(77)],
    });
    tracker.setLifecycleSequence(77, [
      lifecycle("missing-target", "symphony/77"),
      lifecycle("rework-required", "symphony/77", {
        failingCheckNames: ["CI"],
      }),
    ]);
    const tempRoot = await createTempDir(
      "symphony-live-session-failure-artifact-test-",
    );

    try {
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              retry: {
                maxAttempts: 1,
                backoffMs: 0,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new SecondTurnFailingLiveRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(tracker.failed).toEqual([
        {
          issueNumber: 77,
          reason: "Runner exited with 17\nsimulated failure",
        },
      ]);

      const attempt = await readIssueArtifactAttempt(
        deriveTestInstance(tempRoot),
        77,
        1,
      );
      const session = await readIssueArtifactSession(
        deriveTestInstance(tempRoot),
        77,
        attempt.sessionId!,
      );
      expect(attempt.latestTurnNumber).toBe(2);
      expect(session.backendSessionId).toBe("codex-session-77");
      expect(session.latestTurnNumber).toBe(2);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not reuse a prior turn transient signal after a successful continuation turn", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(78)],
    });
    tracker.setLifecycleSequence(78, [
      lifecycle("missing-target", "symphony/78"),
      lifecycle("rework-required", "symphony/78", {
        failingCheckNames: ["CI"],
      }),
    ]);
    const tempRoot = await createTempDir(
      "symphony-live-session-stale-signal-test-",
    );

    try {
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              retry: {
                ...baseConfig.polling.retry,
                backoffMs: 1_000,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new StaleSignalThenOrdinaryFailureLiveRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(tracker.retried).toEqual([
        {
          issueNumber: 78,
          reason: "Runner exited with 17\ntemporary sandbox crash",
        },
      ]);
      const snapshot = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(snapshot.dispatchPressure).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves live-session turn metadata when max-turn exhaustion fails a missing-target lifecycle", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(88)],
    });
    tracker.setLifecycleSequence(88, [
      lifecycle("missing-target", "symphony/88"),
      lifecycle("missing-target", "symphony/88"),
      lifecycle("missing-target", "symphony/88"),
    ]);
    const tempRoot = await createTempDir(
      "symphony-missing-target-max-turn-artifact-test-",
    );

    try {
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              retry: {
                maxAttempts: 1,
                backoffMs: 0,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingLiveSessionRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(tracker.failed).toEqual([
        {
          issueNumber: 88,
          reason:
            "Reached agent.max_turns (3) with remaining missing-target work: missing-target for symphony/88",
        },
      ]);

      const attempt = await readIssueArtifactAttempt(
        deriveTestInstance(tempRoot),
        88,
        1,
      );
      const session = await readIssueArtifactSession(
        deriveTestInstance(tempRoot),
        88,
        attempt.sessionId!,
      );
      expect(attempt.latestTurnNumber).toBe(3);
      expect(session.backendSessionId).toBe("codex-session-77");
      expect(session.latestTurnNumber).toBe(3);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists live-session accounting observed during a turn into session artifacts", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(90)],
    });
    tracker.setLifecycleSequence(90, [
      lifecycle("handoff-ready", "symphony/90"),
    ]);
    const tempRoot = await createTempDir("symphony-live-accounting-artifact-");

    try {
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(baseConfig, tempRoot),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(): Promise<RunnerExecutionResult> {
            throw new Error("runner.run should not be called");
          },
          async startSession(): Promise<LiveRunnerSession> {
            let latestTurnNumber: number | null = null;
            return {
              describe() {
                return {
                  ...createRunnerSessionDescription(),
                  backendSessionId: "codex-session-90",
                  latestTurnNumber,
                };
              },
              async runTurn(turn, options): Promise<RunnerTurnResult> {
                latestTurnNumber = turn.turnNumber;
                options?.onUpdate?.({
                  event: "codex/event/token_count",
                  payload: {
                    input_tokens: 123,
                    output_tokens: 45,
                    total_tokens: 168,
                  },
                  timestamp: formatTurnTimestamp(50, turn.turnNumber),
                });
                const timestamp = formatTurnTimestamp(50, turn.turnNumber);
                return {
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                  startedAt: timestamp,
                  finishedAt: timestamp,
                  session: {
                    ...createRunnerSessionDescription(),
                    backendSessionId: "codex-session-90",
                    latestTurnNumber,
                  },
                };
              },
              async close(): Promise<void> {},
            };
          },
        },
        new NullLogger(),
      );

      await orchestrator.runOnce();

      expect(tracker.completed).toEqual([90]);

      const attempt = await readIssueArtifactAttempt(
        deriveTestInstance(tempRoot),
        90,
        1,
      );
      const session = await readIssueArtifactSession(
        deriveTestInstance(tempRoot),
        90,
        attempt.sessionId!,
      );
      expect(session.accounting).toEqual({
        status: "partial",
        inputTokens: 123,
        outputTokens: 45,
        totalTokens: 168,
        costUsd: null,
      });
      expect(orchestrator.snapshot().codexTotals).toEqual(
        expect.objectContaining({
          inputTokens: 123,
          outputTokens: 45,
          totalTokens: 168,
        }),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the raw missing-target summary when max_turns is one", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(89)],
    });
    tracker.setLifecycleSequence(89, [
      lifecycle("missing-target", "symphony/89"),
      lifecycle("missing-target", "symphony/89"),
    ]);

    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          maxTurns: 1,
        },
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 1,
            backoffMs: 0,
          },
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      new RecordingLiveSessionRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(tracker.failed).toEqual([
      {
        issueNumber: 89,
        reason: "missing-target for symphony/89",
      },
    ]);
  });

  it("keeps the raw rework-required summary when max_turns is one", async () => {
    const tempRoot = await createTempDir("symphony-single-turn-follow-up-");
    const tracker = new SequencedTracker({
      ready: [createIssue(90)],
    });
    try {
      tracker.setLifecycleSequence(90, [
        lifecycle("missing-target", "symphony/90"),
        lifecycle("rework-required", "symphony/90", {
          actionableReviewFeedback: [
            {
              id: "feedback-1",
              kind: "review-thread",
              threadId: "thread-1",
              authorLogin: "greptile[bot]",
              body: "Please tighten the remaining edge case",
              createdAt: "2026-03-12T00:00:00.000Z",
              url: "https://example.test/review/1",
              path: "src/orchestrator/service.ts",
              line: 123,
            },
          ],
        }),
      ]);

      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            agent: {
              ...baseConfig.agent,
              maxTurns: 1,
            },
            polling: {
              ...baseConfig.polling,
              retry: {
                maxAttempts: 1,
                backoffMs: 0,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingLiveSessionRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      const issueStatus = status.activeIssues.find(
        (issue) => issue.issueNumber === 90,
      );
      expect(issueStatus?.summary).toBe("rework-required for symphony/90");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps rework-required status summaries raw when max turns are reached", async () => {
    const tempRoot = await createTempDir("symphony-max-turn-follow-up-status-");
    const tracker = new SequencedTracker({
      ready: [createIssue(91)],
    });
    try {
      tracker.setLifecycleSequence(91, [
        lifecycle("missing-target", "symphony/91"),
        lifecycle("rework-required", "symphony/91", {
          actionableReviewFeedback: [
            {
              id: "feedback-1",
              kind: "review-thread",
              threadId: "thread-1",
              authorLogin: "greptile[bot]",
              body: "Please tighten the remaining edge case",
              createdAt: "2026-03-12T00:00:00.000Z",
              url: "https://example.test/review/1",
              path: "src/orchestrator/service.ts",
              line: 123,
            },
          ],
          unresolvedThreadIds: ["thread-1"],
        }),
        lifecycle("rework-required", "symphony/91", {
          actionableReviewFeedback: [
            {
              id: "feedback-2",
              kind: "review-thread",
              threadId: "thread-2",
              authorLogin: "greptile[bot]",
              body: "Please tighten the remaining edge case",
              createdAt: "2026-03-12T00:01:00.000Z",
              url: "https://example.test/review/2",
              path: "src/orchestrator/service.ts",
              line: 124,
            },
          ],
          unresolvedThreadIds: ["thread-2"],
        }),
      ]);

      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            agent: {
              ...baseConfig.agent,
              maxTurns: 3,
            },
            polling: {
              ...baseConfig.polling,
              retry: {
                maxAttempts: 1,
                backoffMs: 0,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        new RecordingLiveSessionRunner(),
        new NullLogger(),
      );

      await orchestrator.runOnce();

      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      const issueStatus = status.activeIssues.find(
        (issue) => issue.issueNumber === 91,
      );
      expect(issueStatus?.summary).toBe("rework-required for symphony/91");
      expect(tracker.failed).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
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
        async run(): Promise<RunnerExecutionResult> {
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

  it("suppresses retry scheduling when merged state is observed after a failed attempt", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(82)],
    });
    tracker.setLifecycleSequence(82, [
      lifecycle("handoff-ready", "symphony/82"),
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const runnerAttempts: number[] = [];
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 2,
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
        async run(session): Promise<RunnerExecutionResult> {
          runnerAttempts.push(session.attempt.sequence);
          const timestamp = "2026-03-13T08:43:30.000Z";
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

    expect(runnerAttempts).toEqual([1]);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([82]);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 82 &&
          observation.issue.currentOutcome === "attempt-failed",
      ),
    ).toBe(true);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 82 &&
          observation.issue.currentOutcome === "succeeded",
      ),
    ).toBe(true);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 82 &&
          observation.issue.currentOutcome === "retry-scheduled",
      ),
    ).toBe(false);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 82 &&
          observation.issue.currentOutcome === "failed",
      ),
    ).toBe(false);
  });

  it("persists mergedAt from the observed handoff lifecycle while reloading closedAt after completion", async () => {
    const tracker = new ClosedIssueTracker({
      ready: [createIssue(86)],
    });
    tracker.setLifecycleSequence(86, [
      {
        ...lifecycle("handoff-ready", "symphony/86"),
        pullRequest: {
          number: 1,
          url: "https://example.test/pulls/symphony/86",
          branchName: "symphony/86",
          headSha: "test-head-sha",
          latestCommitAt: "2026-03-11T12:05:00.000Z",
          mergedAt: "2026-03-11T12:05:27.000Z",
        },
      },
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("runner should not be called");
        },
      },
      new NullLogger(),
      artifactStore,
    );

    await orchestrator.runOnce();

    expect(tracker.completed).toEqual([86]);
    expect(tracker.inspectIssueHandoffCalls).toBe(1);
    expect(
      artifactStore.observations.find(
        (observation) =>
          observation.issue.issueNumber === 86 &&
          observation.issue.currentOutcome === "succeeded" &&
          observation.issue.mergedAt === "2026-03-11T12:05:27.000Z" &&
          observation.issue.closedAt === "2026-03-11T12:06:00.000Z",
      ),
    ).toBeDefined();
  });

  it("cleans up the issue workspace when merged reconciliation wins after an unexpected failure without a session", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(85)],
    });
    tracker.setLifecycleSequence(85, [
      lifecycle("handoff-ready", "symphony/85"),
    ]);
    const workspace = new PrepareFailingWorkspaceManager();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        workspace: {
          ...baseConfig.workspace,
          retention: {
            ...baseConfig.workspace.retention,
            onSuccess: "delete",
          },
        },
      },
      staticPromptBuilder,
      tracker,
      workspace,
      new RecordingRunner(),
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(tracker.completed).toEqual([85]);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(workspace.cleaned).toEqual(["/tmp/workspaces/85"]);
  });

  it("suppresses terminal failed publication when merged state is observed before exhaustion handling", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(83)],
    });
    tracker.setLifecycleSequence(83, [
      lifecycle("handoff-ready", "symphony/83"),
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const orchestrator = new BootstrapOrchestrator(
      {
        ...baseConfig,
        polling: {
          ...baseConfig.polling,
          retry: {
            maxAttempts: 1,
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
        async run(): Promise<RunnerExecutionResult> {
          const timestamp = "2026-03-13T08:44:00.000Z";
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

    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([83]);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 83 &&
          observation.issue.currentOutcome === "failed",
      ),
    ).toBe(false);
    expect(
      artifactStore.observations.some(
        (observation) =>
          observation.issue.issueNumber === 83 &&
          observation.issue.currentOutcome === "succeeded",
      ),
    ).toBe(true);
  });

  it("drops an already-queued retry once the next poll observes merged terminal state", async () => {
    const tempRoot = await createTempDir("symphony-post-merge-retry-");
    try {
      const tracker = new SequencedTracker({
        ready: [createIssue(84)],
      });
      tracker.setLifecycleSequence(84, [
        lifecycle("missing-target", "symphony/84"),
        lifecycle("handoff-ready", "symphony/84"),
      ]);
      const artifactStore = new RecordingIssueArtifactStore();
      const runnerAttempts: number[] = [];
      const orchestrator = new BootstrapOrchestrator(
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              retry: {
                maxAttempts: 2,
                backoffMs: 0,
              },
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(session): Promise<RunnerExecutionResult> {
            runnerAttempts.push(session.attempt.sequence);
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
        new NullLogger(),
        artifactStore,
      );

      await orchestrator.runOnce();
      expect(tracker.retried).toEqual([
        {
          issueNumber: 84,
          reason: "Runner exited with 17\nsimulated failure",
        },
      ]);

      await orchestrator.runOnce();

      expect(runnerAttempts).toEqual([1]);
      expect(tracker.completed).toEqual([84]);
      expect(tracker.failed).toEqual([]);
      const status = await readFactoryStatusSnapshot(
        deriveStatusFilePath(deriveTestInstance(tempRoot)),
      );
      expect(status.counts.retries).toBe(0);
      expect(status.activeIssues).toHaveLength(0);
      expect(
        artifactStore.observations.some(
          (observation) =>
            observation.issue.issueNumber === 84 &&
            observation.issue.currentOutcome === "succeeded",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
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
        async run(): Promise<RunnerExecutionResult> {
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

    expect(describeSessionCalls).toBe(2);
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
        async run(): Promise<RunnerExecutionResult> {
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
        async run(session): Promise<RunnerExecutionResult> {
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

  it("persists intentional shutdown without scheduling a retry", async () => {
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
        withLocalInstanceRoot(
          {
            ...baseConfig,
            polling: {
              ...baseConfig.polling,
              intervalMs: 1,
            },
          },
          tempRoot,
        ),
        staticPromptBuilder,
        tracker,
        new StaticWorkspaceManager(),
        {
          describeSession() {
            return createRunnerSessionDescription();
          },
          async run(_session, options): Promise<RunnerExecutionResult> {
            started.resolve();
            return await new Promise<RunnerExecutionResult>(
              (_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    reject(
                      new RunnerShutdownError(
                        "Runner cancelled by shutdown",
                        "graceful",
                      ),
                    );
                  },
                  { once: true },
                );
              },
            );
          },
        },
        new NullLogger(),
      );
      const controller = new AbortController();
      const loop = orchestrator.runLoop(controller.signal);

      await started.promise;
      controller.abort();
      await loop;

      const leaseManager = new LocalIssueLeaseManager(
        tempRoot,
        new NullLogger(),
      );
      const snapshot = await leaseManager.inspect(76);

      expect(tracker.retried).toEqual([]);
      expect(tracker.failed).toEqual([]);
      expect(snapshot.kind).toBe("shutdown-terminated");
      expect(snapshot.record?.shutdown?.state).toBe("shutdown-terminated");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records a shutdown-requested artifact event before shutdown termination", async () => {
    const issue = createIssue(77);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(77, [
      lifecycle("missing-target", "symphony/77"),
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const started = createDeferred<void>();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(_session, options): Promise<RunnerExecutionResult> {
          started.resolve();
          return await new Promise<RunnerExecutionResult>(
            (_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => {
                  reject(
                    new RunnerShutdownError(
                      "Runner cancelled by shutdown",
                      "graceful",
                    ),
                  );
                },
                { once: true },
              );
            },
          );
        },
      },
      new NullLogger(),
      artifactStore,
    );
    const controller = new AbortController();
    const loop = orchestrator.runLoop(controller.signal);

    await started.promise;
    controller.abort();
    await loop;

    const shutdownEventKinds = artifactStore.observations.flatMap(
      (observation) => observation.events?.map((event) => event.kind) ?? [],
    );

    expect(shutdownEventKinds).toContain("shutdown-requested");
    expect(shutdownEventKinds).toContain("shutdown-terminated");
    expect(shutdownEventKinds.indexOf("shutdown-requested")).toBeLessThan(
      shutdownEventKinds.indexOf("shutdown-terminated"),
    );
  });

  it("uses live session metadata when shutdown fires before the first turn completes", async () => {
    const issue = createIssue(78);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(78, [
      lifecycle("missing-target", "symphony/78"),
    ]);
    const artifactStore = new RecordingIssueArtifactStore();
    const started = createDeferred<void>();
    const orchestrator = new BootstrapOrchestrator(
      baseConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      {
        describeSession() {
          return createRunnerSessionDescription();
        },
        async run(): Promise<RunnerExecutionResult> {
          throw new Error("run should not be called when startSession is used");
        },
        async startSession(): Promise<LiveRunnerSession> {
          const sessionDescription = {
            ...createRunnerSessionDescription(),
            backendSessionId: "backend-session-78",
            backendThreadId: "thread-78",
            latestTurnNumber: 0,
          };
          return {
            describe() {
              return sessionDescription;
            },
            async runTurn(_turn, options): Promise<RunnerTurnResult> {
              started.resolve();
              return await new Promise<RunnerTurnResult>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    reject(
                      new RunnerShutdownError(
                        "Runner cancelled by shutdown",
                        "graceful",
                      ),
                    );
                  },
                  { once: true },
                );
              });
            },
            async close(): Promise<void> {},
          };
        },
      },
      new NullLogger(),
      artifactStore,
    );
    const controller = new AbortController();
    const loop = orchestrator.runLoop(controller.signal);

    await started.promise;
    controller.abort();
    await loop;

    const shutdownRequestedEvent = artifactStore.observations
      .flatMap((observation) => observation.events ?? [])
      .find((event) => event.kind === "shutdown-requested");

    expect(shutdownRequestedEvent?.details.backendSessionId).toBe(
      "backend-session-78",
    );
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

  it("completes the issue when a watchdog-aborted run races with a merged PR", async () => {
    const issue = createIssue(99);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(99, [
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
        return new Promise<RunnerExecutionResult>((resolve, reject) => {
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0, // immediate stall detection for testing
        }),
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
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([99]);
  });

  it("keeps a pre-write run alive while runner visibility keeps advancing", async () => {
    const issue = createIssue(91);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(91, [
      lifecycle("handoff-ready", "symphony/91"),
    ]);

    let runAborted = false;

    const progressRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        const startedAt = new Date().toISOString();
        for (let index = 0; index < 3; index += 1) {
          const observedAt = new Date(Date.now() + index + 1).toISOString();
          await options?.onEvent?.({
            kind: "visibility",
            visibility: {
              state: "running",
              phase: "turn-execution",
              session: createRunnerSessionDescription(),
              lastHeartbeatAt: observedAt,
              lastActionAt: observedAt,
              lastActionSummary: `Planning step ${(index + 1).toString()}`,
              waitingReason: null,
              stdoutSummary: null,
              stderrSummary: null,
              errorSummary: null,
              cancelledAt: null,
              timedOutAt: null,
            },
          });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              options?.signal?.removeEventListener("abort", handleAbort);
              resolve();
            }, 5);
            const handleAbort = (): void => {
              clearTimeout(timer);
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
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      },
    };

    const watchdogConfig = {
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 1,
          stallThresholdMs: 20,
        }),
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      progressRunner,
      new NullLogger(),
      undefined,
      createRunnerVisibilityProbe(),
    );

    await orchestrator.runOnce();

    expect(runAborted).toBe(false);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([91]);
  });

  it("keeps an early-write run alive while watchdog log growth keeps advancing", async () => {
    const issue = createIssue(94);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(94, [
      lifecycle("handoff-ready", "symphony/94"),
    ]);

    let runAborted = false;

    const slowRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        const startedAt = new Date().toISOString();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", handleAbort);
            resolve();
          }, 35);
          const handleAbort = (): void => {
            clearTimeout(timer);
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
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      },
    };

    const watchdogConfig = {
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 1,
          stallThresholdMs: 5,
        }),
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      slowRunner,
      new NullLogger(),
      undefined,
      createAdvancingLogProbe(),
    );

    await orchestrator.runOnce();

    expect(runAborted).toBe(false);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([94]);
  });

  it("keeps a quiet execution run alive when the execution threshold exceeds the legacy baseline", async () => {
    const issue = createIssue(95);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(95, [
      lifecycle("handoff-ready", "symphony/95"),
    ]);

    let runAborted = false;

    const quietRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        const startedAt = new Date().toISOString();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", handleAbort);
            resolve();
          }, 35);
          const handleAbort = (): void => {
            clearTimeout(timer);
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
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      },
    };

    const quietWorkspaceProbe: LivenessProbe = {
      async capture(options) {
        return {
          logSizeBytes: null,
          workspaceDiffHash: "diff-95",
          prHeadSha: options.prHeadSha,
          runStartedAt: options.runStartedAt,
          runnerPhase: options.runnerPhase,
          runnerHeartbeatAt: options.runnerHeartbeatAt,
          runnerActionAt: options.runnerActionAt,
          hasActionableFeedback: options.hasActionableFeedback,
          capturedAt: Date.now(),
        };
      },
    };

    const watchdogConfig = {
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 1,
          stallThresholdMs: 5,
          executionStallThresholdMs: 50,
          prFollowThroughStallThresholdMs: 5,
          maxRecoveryAttempts: 1,
        },
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      quietRunner,
      new NullLogger(),
      undefined,
      quietWorkspaceProbe,
    );

    await orchestrator.runOnce();

    expect(runAborted).toBe(false);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([95]);
  });

  it("keeps a quiet PR follow-through run alive when the PR threshold exceeds the legacy baseline", async () => {
    const issue = createIssue(96);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(96, [
      lifecycle("rework-required", "symphony/96"),
      lifecycle("handoff-ready", "symphony/96"),
    ]);

    let turnNumber = 0;
    let runAborted = false;

    const quietFollowThroughRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        turnNumber += 1;
        const startedAt = new Date().toISOString();
        if (turnNumber === 1) {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            startedAt,
            finishedAt: new Date().toISOString(),
          };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", handleAbort);
            resolve();
          }, 35);
          const handleAbort = (): void => {
            clearTimeout(timer);
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
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      },
    };

    const quietPrProbe: LivenessProbe = {
      async capture(options) {
        return {
          logSizeBytes: null,
          workspaceDiffHash: "diff-96",
          prHeadSha: options.prHeadSha,
          runStartedAt: options.runStartedAt,
          runnerPhase: options.runnerPhase,
          runnerHeartbeatAt: options.runnerHeartbeatAt,
          runnerActionAt: options.runnerActionAt,
          hasActionableFeedback: options.hasActionableFeedback,
          capturedAt: Date.now(),
        };
      },
    };

    const watchdogConfig = {
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: {
          enabled: true,
          checkIntervalMs: 1,
          stallThresholdMs: 5,
          executionStallThresholdMs: 5,
          prFollowThroughStallThresholdMs: 200,
          maxRecoveryAttempts: 1,
        },
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      quietFollowThroughRunner,
      new NullLogger(),
      undefined,
      quietPrProbe,
    );

    await orchestrator.runOnce();

    expect(turnNumber).toBe(2);
    expect(runAborted).toBe(false);
    expect(tracker.retried).toEqual([]);
    expect(tracker.failed).toEqual([]);
    expect(tracker.completed).toEqual([96]);
  });

  it("recovers a startup run that never advances beyond its start time", async () => {
    const issue = createIssue(92);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(92, [
      lifecycle("missing-target", "symphony/92"),
    ]);

    let abortCount = 0;

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        return await new Promise<RunnerExecutionResult>((_resolve, reject) => {
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0,
        }),
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
      new NullLivenessProbe(),
    );

    await orchestrator.runOnce();

    expect(abortCount).toBe(1);
    expect(tracker.retried).toHaveLength(1);
    expect(tracker.retried[0]?.reason).toContain("Stall detected (log-stall)");
    expect(tracker.retried[0]?.reason).not.toContain(
      "Runner cancelled by shutdown",
    );
  });

  it("keeps watchdog abort retries from inheriting turn-local rate-limit pressure", async () => {
    const issue = createIssue(93);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(93, [
      lifecycle("missing-target", "symphony/93"),
    ]);

    let abortCount = 0;

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        options?.onUpdate?.({
          event: "account/rateLimits/updated",
          timestamp: "2026-03-17T12:00:00.000Z",
          payload: {
            params: {
              rateLimits: {
                limitId: "core",
                primary: {
                  used: 100,
                  limit: 100,
                  resetInMs: 60_000,
                },
                secondary: null,
                credits: "$4.00",
              },
            },
          },
        });
        return await new Promise<RunnerExecutionResult>((_resolve, reject) => {
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

    const orchestrator = new BootstrapOrchestrator(
      {
        ...withLocalInstanceRoot(baseConfig, tmpDir),
        polling: {
          ...baseConfig.polling,
          watchdog: createWatchdogConfig({
            checkIntervalMs: 0,
            stallThresholdMs: 0,
          }),
        },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      stalledRunner,
      new NullLogger(),
      undefined,
      new NullLivenessProbe(),
    );

    await orchestrator.runOnce();

    expect(abortCount).toBe(1);
    expect(tracker.retried).toHaveLength(1);
    expect(tracker.retried[0]?.reason).toContain("Stall detected (log-stall)");
    expect(tracker.retried[0]?.reason).not.toContain("provider-rate-limit");
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.dispatchPressure).toBeNull();
  });

  it("does not recover beyond maxRecoveryAttempts across retries", async () => {
    const issue = createIssue(88);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(88, [
      // Keep this sequence on missing-target so the watchdog retry-budget test
      // stays focused on the terminal abort path. A handoff-ready entry here
      // would now be consumed by merged-during-failure reconciliation instead
      // of exercising retry exhaustion; that merged race is covered above.
      lifecycle("missing-target", "symphony/88"),
      lifecycle("missing-target", "symphony/88"),
    ]);

    let abortCount = 0;

    const stalledRunner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        return new Promise<RunnerExecutionResult>((resolve, reject) => {
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0,
        }),
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
        reason: expect.stringContaining("Stall detected (log-stall)"),
      },
    ]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.lastAction?.kind).toBe("issue-failed");
    expect(snapshot.lastAction?.summary).toContain(
      "Stall detected (log-stall)",
    );
    expect(snapshot.lastAction?.summary).toContain("since ");
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
        return new Promise<RunnerExecutionResult>((_resolve, reject) => {
          const handleAbort = (): void => {
            abortCount += 1;
            void readFactoryStatusSnapshot(
              deriveStatusFilePath(deriveTestInstance(tmpDir)),
            )
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0,
          maxRecoveryAttempts: 0,
        }),
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 50,
          stallThresholdMs: 0,
        }),
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
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery");
    expect(
      tracker.retried.some(({ reason }) => reason.includes("Stall detected")),
    ).toBe(false);
  });

  it("stops the watchdog when live session startup fails", async () => {
    const issue = createIssue(57);
    const tracker = new SequencedTracker({ ready: [issue] });
    tracker.setLifecycleSequence(57, [
      lifecycle("missing-target", "symphony/57"),
    ]);

    const watchdogConfig = {
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0,
        }),
      },
    };

    const logger = new NullLogger();
    const { NullLivenessProbe } =
      await import("../../src/orchestrator/liveness-probe.js");

    const orchestrator = new BootstrapOrchestrator(
      watchdogConfig,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      new StartSessionRejectingRunner(),
      logger,
      undefined,
      new NullLivenessProbe(),
    );

    await orchestrator.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
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
      ...withLocalInstanceRoot(baseConfig, tmpDir),
      polling: {
        ...baseConfig.polling,
        watchdog: createWatchdogConfig({
          checkIntervalMs: 0,
          stallThresholdMs: 0,
        }),
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
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery");
    expect(snapshot.lastAction?.kind).not.toBe("watchdog-recovery-exhausted");
  });

  it("pauses new ready-issue dispatch after a rate-limited runner failure", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(1), createIssue(2)],
    });
    tracker.setLifecycleSequence(1, [
      lifecycle("missing-target", "symphony/1"),
    ]);
    tracker.setLifecycleSequence(2, [
      lifecycle("missing-target", "symphony/2"),
    ]);

    let runnerCalls = 0;
    const runStartedAt = new Date().toISOString();
    const runFinishedAt = runStartedAt;
    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(session, options) {
        runnerCalls += 1;
        if (session.issue.number === 1) {
          options?.onUpdate?.({
            event: "account/rateLimits/updated",
            timestamp: runStartedAt,
            payload: {
              params: {
                rateLimits: {
                  limitId: "core",
                  primary: {
                    used: 100,
                    limit: 100,
                    resetInMs: 60_000,
                  },
                },
              },
            },
          });
          return {
            exitCode: 17,
            stdout: "",
            stderr: "HTTP 429 rate limit exceeded",
            startedAt: runStartedAt,
            finishedAt: runFinishedAt,
          };
        }
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: runStartedAt,
          finishedAt: runFinishedAt,
        };
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      {
        ...withLocalInstanceRoot(baseConfig, tmpDir),
        polling: {
          ...baseConfig.polling,
          maxConcurrentRuns: 1,
          retry: {
            ...baseConfig.polling.retry,
            backoffMs: 1_000,
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

    expect(runnerCalls).toBe(1);
    expect(tracker.retried).toEqual([
      {
        issueNumber: 1,
        reason:
          "provider-rate-limit: Runner exited with 17\nHTTP 429 rate limit exceeded",
      },
    ]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.dispatchPressure).toMatchObject({
      retryClass: "provider-rate-limit",
    });
    expect(tracker.readyIssues.has(2)).toBe(true);
  });

  it("blocks new ready dispatch while the factory is explicitly halted but still inspects running issues", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(11), createIssue(12)],
      running: [createIssue(13, "symphony:running")],
    });
    tracker.setLifecycleSequence(11, [
      lifecycle("missing-target", "symphony/11"),
    ]);
    tracker.setLifecycleSequence(12, [
      lifecycle("missing-target", "symphony/12"),
    ]);
    tracker.setLifecycleSequence(13, [
      lifecycle("handoff-ready", "symphony/13"),
    ]);

    let runnerCalls = 0;
    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run() {
        runnerCalls += 1;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: "2026-03-30T12:00:00.000Z",
          finishedAt: "2026-03-30T12:00:00.000Z",
        };
      },
    };

    const config = withLocalInstanceRoot(baseConfig, tmpDir);
    await writeFactoryHaltRecord(config.instance, {
      reason: "Prerequisite ticket failed; stop the line.",
      haltedAt: "2026-03-30T12:00:00.000Z",
      source: "factory-cli",
      actor: "operator",
    });

    const orchestrator = new BootstrapOrchestrator(
      config,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(runnerCalls).toBe(0);
    expect(tracker.completed).toEqual([13]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(config.instance),
    );
    expect(snapshot.factoryHalt).toEqual({
      state: "halted",
      reason: "Prerequisite ticket failed; stop the line.",
      haltedAt: "2026-03-30T12:00:00.000Z",
      source: "factory-cli",
      actor: "operator",
      detail: null,
    });
    expect(snapshot.readyQueue).toEqual([
      expect.objectContaining({ issueNumber: 11 }),
      expect.objectContaining({ issueNumber: 12 }),
    ]);
    expect(snapshot.lastAction).toEqual(
      expect.objectContaining({
        kind: "issue-completed",
        issueNumber: 13,
      }),
    );
  });

  it("preserves due retries while the factory is halted until an explicit resume", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(14)],
    });
    tracker.setLifecycleSequence(14, [
      lifecycle("missing-target", "symphony/14"),
      lifecycle("missing-target", "symphony/14"),
      lifecycle("missing-target", "symphony/14"),
      lifecycle("handoff-ready", "symphony/14"),
    ]);

    const runnerAttempts: number[] = [];
    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(session): Promise<RunnerExecutionResult> {
        runnerAttempts.push(session.attempt.sequence);
        const timestamp = new Date().toISOString();
        return {
          exitCode: session.attempt.sequence === 1 ? 17 : 0,
          stdout: "",
          stderr:
            session.attempt.sequence === 1 ? "temporary sandbox crash" : "",
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    };

    const config = withLocalInstanceRoot(baseConfig, tmpDir);
    const orchestrator = new BootstrapOrchestrator(
      config,
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();
    await writeFactoryHaltRecord(config.instance, {
      reason: "Stop the line while we inspect the retry cause.",
      haltedAt: "2026-03-30T12:05:00.000Z",
      source: "factory-cli",
      actor: "operator",
    });

    await orchestrator.runOnce();
    expect(runnerAttempts).toEqual([1]);

    await clearFactoryHaltRecord(config.instance);
    await orchestrator.runOnce();

    expect(runnerAttempts).toEqual([1, 2]);
    expect(tracker.completed).toEqual([14]);
  });

  it("keeps unrelated ready work dispatchable after an ordinary transient failure", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(3)],
    });
    tracker.setLifecycleSequence(3, [
      lifecycle("missing-target", "symphony/3"),
    ]);
    tracker.setLifecycleSequence(4, [lifecycle("handoff-ready", "symphony/4")]);

    const runnerIssues: number[] = [];
    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(session) {
        runnerIssues.push(session.issue.number);
        if (session.issue.number === 3) {
          return {
            exitCode: 17,
            stdout: "",
            stderr: "temporary sandbox crash",
            startedAt: "2026-03-17T12:00:00.000Z",
            finishedAt: "2026-03-17T12:00:00.000Z",
          };
        }
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: "2026-03-17T12:00:05.000Z",
          finishedAt: "2026-03-17T12:00:05.000Z",
        };
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      {
        ...withLocalInstanceRoot(baseConfig, tmpDir),
        polling: { ...baseConfig.polling, maxConcurrentRuns: 2 },
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();
    tracker.readyIssues.set(4, createIssue(4));
    await orchestrator.runOnce();

    expect(runnerIssues[0]).toBe(3);
    expect(runnerIssues.slice(1).sort((left, right) => left - right)).toEqual([
      3, 4,
    ]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.dispatchPressure).toBeNull();
  });

  it("clears dispatch pressure when merged reconciliation suppresses a pressure retry", async () => {
    const tracker = new SequencedTracker({
      ready: [createIssue(5)],
    });
    tracker.setLifecycleSequence(5, [lifecycle("handoff-ready", "symphony/5")]);

    const runner: Runner = {
      describeSession() {
        return createRunnerSessionDescription();
      },
      async run(_session, options) {
        options?.onUpdate?.({
          event: "turn/failed",
          timestamp: "2026-03-17T12:00:00.000Z",
          payload: {
            params: {
              error: {
                message: "Billing hard limit reached for this account",
              },
            },
          },
        });
        return {
          exitCode: 17,
          stdout: "",
          stderr: "Billing hard limit reached for this account",
          startedAt: "2026-03-17T12:00:00.000Z",
          finishedAt: "2026-03-17T12:00:00.000Z",
        };
      },
    };

    const orchestrator = new BootstrapOrchestrator(
      {
        ...withLocalInstanceRoot(baseConfig, tmpDir),
      },
      staticPromptBuilder,
      tracker,
      new StaticWorkspaceManager(),
      runner,
      new NullLogger(),
    );

    await orchestrator.runOnce();

    expect(tracker.retried).toEqual([]);
    expect(tracker.completed).toEqual([5]);
    const snapshot = await readFactoryStatusSnapshot(
      deriveStatusFilePath(deriveTestInstance(tmpDir)),
    );
    expect(snapshot.dispatchPressure).toBeNull();
  });
});
