import path from "node:path";
import type { RuntimeIssue } from "../../src/domain/issue.js";
import type { RunSession } from "../../src/domain/run.js";
import type { PreparedWorkspace } from "../../src/domain/workspace.js";
import {
  deriveRuntimeInstancePaths,
  type ResolvedConfig,
  type SshWorkerHostConfig,
} from "../../src/domain/workflow.js";
import type { Logger } from "../../src/observability/logger.js";
import { createOrchestratorState } from "../../src/orchestrator/state.js";
import {
  createRunnerTransportMetadata,
  type RunnerSessionDescription,
  type RunnerVisibilitySnapshot,
} from "../../src/runner/service.js";

export class NullLogger implements Logger {
  info(): void {}

  warn(): void {}

  error(): void {}
}

export function createWorkerHost(name = "host-a"): SshWorkerHostConfig {
  return {
    name,
    sshDestination: `${name}.example.test`,
    sshExecutable: "ssh",
    sshOptions: [],
    workspaceRoot: `/srv/${name}`,
  };
}

export function createTestConfig(
  root: string,
  options: {
    readonly intervalMs?: number;
    readonly maxConcurrentRuns?: number;
    readonly retryBackoffMs?: number;
    readonly maxTurns?: number;
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
      respectBlockedRelationships: false,
      successComment: "done",
      reviewBotLogins: ["greptile[bot]"],
    },
    polling: {
      intervalMs: options.intervalMs ?? 10,
      maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
      retry: {
        maxAttempts: 2,
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
      maxTurns: options.maxTurns ?? 3,
      env: {},
    },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 16,
      issueReports: {
        archiveRoot: null,
      },
    },
  };
}

export function createTestState(
  config: ResolvedConfig,
  workerHosts: readonly SshWorkerHostConfig[] = [],
) {
  return createOrchestratorState(config.polling.intervalMs, workerHosts);
}

export function createPreparedWorkspace(
  issue: RuntimeIssue,
  options: {
    readonly branchName?: string;
    readonly workerHostName?: string | null;
  } = {},
): PreparedWorkspace {
  const branchName =
    options.branchName ?? `symphony/${issue.number.toString()}`;
  const workerHostName = options.workerHostName ?? null;
  return {
    key: `workspace-${issue.number.toString()}`,
    branchName,
    createdNow: true,
    source: {
      kind: "configured-repo",
      repoUrl: "/tmp/remote.git",
    },
    target:
      workerHostName === null
        ? {
            kind: "local",
            path: `/tmp/workspace-${issue.number.toString()}`,
          }
        : {
            kind: "remote",
            host: workerHostName,
            workspaceId: `workspace-${issue.number.toString()}`,
            pathHint: `/srv/${workerHostName}/workspace-${issue.number.toString()}`,
          },
  };
}

export function createRunSession(
  issue: RuntimeIssue,
  workspace: PreparedWorkspace,
  attempt: number,
  prompt = "prompt",
): RunSession {
  return {
    id: `${issue.identifier}/attempt-${attempt.toString()}-test`,
    issue,
    workspace,
    prompt,
    startedAt: "2026-04-09T00:00:00.000Z",
    attempt: {
      sequence: attempt,
    },
  };
}

export function createRunnerSessionDescription(): RunnerSessionDescription {
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
  };
}

export function createRunnerVisibility(
  description: RunnerSessionDescription,
): RunnerVisibilitySnapshot {
  return {
    state: "starting",
    phase: "boot",
    session: description,
    lastHeartbeatAt: "2026-04-09T00:00:00.000Z",
    lastActionAt: "2026-04-09T00:00:00.000Z",
    lastActionSummary: "Runner session created",
    waitingReason: null,
    stdoutSummary: null,
    stderrSummary: null,
    errorSummary: null,
    cancelledAt: null,
    timedOutAt: null,
  };
}
