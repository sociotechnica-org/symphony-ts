import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type {
  FactoryActiveIssueSnapshot,
  FactoryHostDispatchSnapshot,
  FactoryIssueStatus,
  FactoryReadyQueueIssueSnapshot,
  FactoryRestartRecoveryIssueSnapshot,
  FactoryRestartRecoveryState,
  FactoryState,
  FactoryStatusAction,
  FactoryStatusSnapshot,
  FactoryTerminalIssueSnapshot,
} from "../observability/status.js";
import type { FactoryRuntimeIdentity } from "../observability/runtime-identity.js";
import type { DispatchPressureStateSnapshot } from "../domain/transient-failure.js";
import type { RetryRuntimeState } from "./retry-state.js";
import { listQueuedRetries } from "./retry-state.js";
import type { HostDispatchRuntimeState } from "./host-dispatch-state.js";
import { listHostDispatchSnapshots } from "./host-dispatch-state.js";
import {
  noteTerminalCleanupPosture,
  projectRecoveryPosture,
  type RuntimeTerminalCleanupPosture,
  type RuntimeWatchdogPosture,
} from "./recovery-posture.js";
import type { WorkspaceRetentionOutcome } from "./workspace-retention.js";

export interface TrackerIssueCounts {
  readonly ready: number;
  readonly running: number;
  readonly failed: number;
}

type RuntimeActiveIssueState = FactoryActiveIssueSnapshot;

export interface RuntimeStatusState {
  readonly workerStartedAt: string;
  trackerCounts: TrackerIssueCounts;
  readonly activeIssues: Map<number, RuntimeActiveIssueState>;
  readyQueue: readonly FactoryReadyQueueIssueSnapshot[];
  readonly watchdogIssues: Map<number, RuntimeWatchdogPosture>;
  terminalIssues: readonly RuntimeTerminalCleanupPosture[];
  restartRecovery: {
    state: FactoryRestartRecoveryState;
    startedAt: string | null;
    completedAt: string | null;
    summary: string | null;
    issues: readonly FactoryRestartRecoveryIssueSnapshot[];
  };
  lastAction: FactoryStatusAction | null;
}

export function createRuntimeStatusState(): RuntimeStatusState {
  return {
    workerStartedAt: new Date().toISOString(),
    trackerCounts: {
      ready: 0,
      running: 0,
      failed: 0,
    },
    activeIssues: new Map<number, RuntimeActiveIssueState>(),
    readyQueue: [],
    watchdogIssues: new Map<number, RuntimeWatchdogPosture>(),
    terminalIssues: [],
    restartRecovery: {
      state: "idle",
      startedAt: null,
      completedAt: null,
      summary: null,
      issues: [],
    },
    lastAction: null,
  };
}

export function noteStatusAction(
  state: RuntimeStatusState,
  action: Omit<FactoryStatusAction, "at"> & { readonly at?: string },
): void {
  state.lastAction = {
    kind: action.kind,
    summary: action.summary,
    issueNumber: action.issueNumber,
    at: action.at ?? new Date().toISOString(),
  };
}

export function setTrackerIssueCounts(
  state: RuntimeStatusState,
  counts: TrackerIssueCounts,
): void {
  state.trackerCounts = {
    ready: counts.ready,
    running: counts.running,
    failed: counts.failed,
  };
}

export function adjustTrackerIssueCounts(
  state: RuntimeStatusState,
  change: Partial<Record<keyof TrackerIssueCounts, number>>,
): void {
  state.trackerCounts = {
    ready:
      change.ready === undefined
        ? state.trackerCounts.ready
        : Math.max(0, state.trackerCounts.ready + change.ready),
    running:
      change.running === undefined
        ? state.trackerCounts.running
        : Math.max(0, state.trackerCounts.running + change.running),
    failed:
      change.failed === undefined
        ? state.trackerCounts.failed
        : Math.max(0, state.trackerCounts.failed + change.failed),
  };
}

export function upsertActiveIssue(
  state: RuntimeStatusState,
  issue: RuntimeIssue,
  update: Partial<RuntimeActiveIssueState> & {
    readonly source: "ready" | "running";
    readonly runSequence: number;
    readonly branchName: string;
    readonly status: FactoryIssueStatus;
    readonly summary: string;
  },
): void {
  const existing = state.activeIssues.get(issue.number);
  const updatedAt = update.updatedAt ?? new Date().toISOString();
  state.activeIssues.set(issue.number, {
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    title: issue.title,
    source: update.source,
    runSequence: update.runSequence,
    status: update.status,
    summary: update.summary,
    workspacePath:
      update.workspacePath === undefined
        ? (existing?.workspacePath ?? null)
        : update.workspacePath,
    branchName: update.branchName,
    runSessionId:
      update.runSessionId === undefined
        ? (existing?.runSessionId ?? null)
        : update.runSessionId,
    executionOwner:
      update.executionOwner === undefined
        ? (existing?.executionOwner ?? null)
        : update.executionOwner,
    ownerPid:
      update.ownerPid === undefined
        ? (existing?.ownerPid ?? null)
        : update.ownerPid,
    runnerPid:
      update.runnerPid === undefined
        ? (existing?.runnerPid ?? null)
        : update.runnerPid,
    startedAt:
      update.startedAt === undefined
        ? (existing?.startedAt ?? null)
        : update.startedAt,
    updatedAt,
    pullRequest:
      update.pullRequest === undefined
        ? (existing?.pullRequest ?? null)
        : update.pullRequest,
    checks: update.checks ??
      existing?.checks ?? { pendingNames: [], failingNames: [] },
    review: update.review ??
      existing?.review ?? { actionableCount: 0, unresolvedThreadCount: 0 },
    blockedReason:
      update.blockedReason === undefined
        ? (existing?.blockedReason ?? null)
        : update.blockedReason,
    runnerAccounting:
      update.runnerAccounting === undefined
        ? existing?.runnerAccounting
        : update.runnerAccounting,
    runnerVisibility:
      update.runnerVisibility === undefined
        ? (existing?.runnerVisibility ?? null)
        : update.runnerVisibility,
  });
}

export function noteLifecycleForIssue(
  state: RuntimeStatusState,
  issue: RuntimeIssue,
  source: "ready" | "running",
  runSequence: number,
  branchName: string,
  lifecycle: HandoffLifecycle,
): void {
  upsertActiveIssue(state, issue, {
    source,
    runSequence,
    branchName,
    status:
      lifecycle.kind === "rework-required"
        ? "rework-required"
        : lifecycle.kind === "awaiting-human-handoff"
          ? "awaiting-human-handoff"
          : lifecycle.kind === "awaiting-human-review"
            ? "awaiting-human-review"
            : lifecycle.kind === "awaiting-system-checks"
              ? "awaiting-system-checks"
              : lifecycle.kind === "degraded-review-infrastructure"
                ? "degraded-review-infrastructure"
                : lifecycle.kind === "awaiting-landing-command"
                  ? "awaiting-landing-command"
                  : lifecycle.kind === "awaiting-landing"
                    ? "awaiting-landing"
                    : "queued",
    summary: lifecycle.summary,
    pullRequest:
      lifecycle.pullRequest === null
        ? null
        : {
            number: lifecycle.pullRequest.number,
            url: lifecycle.pullRequest.url,
            headSha: lifecycle.pullRequest.headSha,
            latestCommitAt: lifecycle.pullRequest.latestCommitAt,
          },
    checks: {
      pendingNames: lifecycle.pendingCheckNames,
      failingNames: lifecycle.failingCheckNames,
    },
    review: {
      actionableCount: lifecycle.actionableReviewFeedback.length,
      unresolvedThreadCount: lifecycle.unresolvedThreadIds.length,
    },
    blockedReason:
      lifecycle.kind === "awaiting-human-handoff" ||
      lifecycle.kind === "awaiting-human-review" ||
      lifecycle.kind === "awaiting-system-checks" ||
      lifecycle.kind === "degraded-review-infrastructure" ||
      lifecycle.kind === "awaiting-landing-command" ||
      lifecycle.kind === "awaiting-landing" ||
      lifecycle.kind === "rework-required"
        ? lifecycle.summary
        : null,
  });
}

export function clearActiveIssue(
  state: RuntimeStatusState,
  issueNumber: number,
): void {
  state.activeIssues.delete(issueNumber);
}

export function setReadyQueue(
  state: RuntimeStatusState,
  issues: readonly RuntimeIssue[],
): void {
  state.readyQueue = issues.map((issue) => ({
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    title: issue.title,
    queuePriorityRank: issue.queuePriority?.rank ?? null,
    queuePriorityLabel: issue.queuePriority?.label ?? null,
  }));
}

export function noteWatchdogIssue(
  state: RuntimeStatusState,
  update: RuntimeWatchdogPosture,
): void {
  state.watchdogIssues.set(update.issueNumber, update);
}

export function clearWatchdogIssue(
  state: RuntimeStatusState,
  issueNumber: number,
): void {
  state.watchdogIssues.delete(issueNumber);
}

export function noteTerminalIssue(
  state: RuntimeStatusState,
  issue: RuntimeIssue,
  options: {
    readonly branchName: string;
    readonly terminalOutcome: "success" | "failure";
    readonly summary: string;
    readonly observedAt: string;
    readonly workspaceRetention: WorkspaceRetentionOutcome;
  },
): void {
  state.terminalIssues = noteTerminalCleanupPosture(state.terminalIssues, {
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    title: issue.title,
    branchName: options.branchName,
    terminalOutcome: options.terminalOutcome,
    summary: options.summary,
    observedAt: options.observedAt,
    workspaceRetention: options.workspaceRetention,
    reportingState: null,
    reportingSummary: null,
    reportingReceiptFile: null,
    reportJsonFile: null,
    reportMarkdownFile: null,
    publicationRoot: null,
    blockedStage: null,
  });
}

export function upsertTerminalIssue(
  state: RuntimeStatusState,
  issue: FactoryTerminalIssueSnapshot,
): void {
  state.terminalIssues = noteTerminalCleanupPosture(state.terminalIssues, {
    issueNumber: issue.issueNumber,
    issueIdentifier: issue.issueIdentifier,
    title: issue.title,
    branchName: issue.branchName,
    terminalOutcome: issue.terminalOutcome,
    summary: issue.summary,
    observedAt: issue.observedAt,
    workspaceRetention: {
      reason:
        issue.terminalOutcome === "success" ? "success" : "failure",
      state:
        issue.workspaceRetentionState === "unknown"
          ? "terminal-retained"
          : issue.workspaceRetentionState,
      action:
        issue.workspaceRetentionState === "terminal-retained" ||
        issue.workspaceRetentionState === "retry-retained" ||
        issue.workspaceRetentionState === "unknown"
          ? "retain"
          : "cleanup",
      },
    reportingState: issue.reportingState,
    reportingSummary: issue.reportingSummary,
    reportingReceiptFile: issue.reportingReceiptFile,
    reportJsonFile: issue.reportJsonFile,
    reportMarkdownFile: issue.reportMarkdownFile,
    publicationRoot: issue.publicationRoot,
    blockedStage: issue.blockedStage,
  });
}

export function setRestartRecoveryState(
  state: RuntimeStatusState,
  restartRecovery: RuntimeStatusState["restartRecovery"],
): void {
  state.restartRecovery = restartRecovery;
}

export function buildFactoryStatusSnapshot(input: {
  readonly state: RuntimeStatusState;
  readonly instanceId: string;
  readonly workerPid: number;
  readonly pollIntervalMs: number;
  readonly maxConcurrentRuns: number;
  readonly activeLocalRuns: number;
  readonly retries: RetryRuntimeState;
  readonly hostDispatch: HostDispatchRuntimeState;
  readonly dispatchPressure: DispatchPressureStateSnapshot | null;
  readonly runtimeIdentity?: FactoryRuntimeIdentity | null;
  readonly publicationState?: "current" | "initializing";
  readonly publicationDetail?: string | null;
}): FactoryStatusSnapshot {
  const activeIssues = [...input.state.activeIssues.values()].sort(
    (left, right) => left.issueNumber - right.issueNumber,
  );
  const retries = [...listQueuedRetries(input.retries)]
    .sort((left, right) => left.dueAt - right.dueAt)
    .map((retry) => ({
      issueNumber: retry.issue.number,
      issueIdentifier: retry.issue.identifier,
      title: retry.issue.title,
      nextAttempt: retry.nextAttempt,
      preferredHost: retry.preferredHost,
      retryClass: retry.retryClass,
      scheduledAt: new Date(retry.scheduledAt).toISOString(),
      backoffMs: retry.backoffMs,
      dueAt: new Date(retry.dueAt).toISOString(),
      lastError: retry.lastError,
    }));
  const hostDispatch: FactoryHostDispatchSnapshot | null =
    input.hostDispatch.hostOrder.length === 0
      ? null
      : {
          hosts: listHostDispatchSnapshots(input.hostDispatch),
        };

  const terminalIssues = input.state.terminalIssues.map((issue) => ({
    issueNumber: issue.issueNumber,
    issueIdentifier: issue.issueIdentifier,
    title: issue.title,
    branchName: issue.branchName,
    terminalOutcome: issue.terminalOutcome,
    summary: issue.summary,
    observedAt: issue.observedAt,
    workspaceRetentionState: issue.workspaceRetention.state,
    reportingState: issue.reportingState,
    reportingSummary: issue.reportingSummary,
    reportingReceiptFile: issue.reportingReceiptFile,
    reportJsonFile: issue.reportJsonFile,
    reportMarkdownFile: issue.reportMarkdownFile,
    publicationRoot: issue.publicationRoot,
    blockedStage: issue.blockedStage,
  })) satisfies readonly FactoryTerminalIssueSnapshot[];

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    runtimeIdentity: input.runtimeIdentity ?? null,
    publication: {
      state: input.publicationState ?? "current",
      detail: input.publicationDetail ?? null,
    },
    dispatchPressure: input.dispatchPressure,
    hostDispatch,
    restartRecovery: input.state.restartRecovery,
    recoveryPosture: projectRecoveryPosture({
      publication: {
        state: input.publicationState ?? "current",
        detail: input.publicationDetail ?? null,
      },
      restartRecovery: input.state.restartRecovery,
      activeIssues,
      retries,
      watchdogIssues: input.state.watchdogIssues,
      terminalIssues: input.state.terminalIssues,
    }),
    factoryState: resolveFactoryState(
      activeIssues,
      input.activeLocalRuns,
      retries.length,
    ),
    worker: {
      instanceId: input.instanceId,
      pid: input.workerPid,
      startedAt: input.state.workerStartedAt,
      pollIntervalMs: input.pollIntervalMs,
      maxConcurrentRuns: input.maxConcurrentRuns,
    },
    counts: {
      ready: input.state.trackerCounts.ready,
      running: input.state.trackerCounts.running,
      failed: input.state.trackerCounts.failed,
      activeLocalRuns: input.activeLocalRuns,
      retries: retries.length,
    },
    lastAction: input.state.lastAction,
    activeIssues,
    terminalIssues,
    readyQueue: input.state.readyQueue,
    retries,
  };
}

function resolveFactoryState(
  activeIssues: readonly RuntimeActiveIssueState[],
  activeLocalRuns: number,
  retryCount: number,
): FactoryState {
  if (
    activeLocalRuns > 0 ||
    activeIssues.some((issue) =>
      ["queued", "preparing", "running"].includes(issue.status),
    )
  ) {
    return "running";
  }
  if (activeIssues.length > 0 || retryCount > 0) {
    return "blocked";
  }
  return "idle";
}
