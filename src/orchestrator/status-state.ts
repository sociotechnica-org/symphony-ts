import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryState } from "../domain/retry.js";
import type {
  FactoryActiveIssueSnapshot,
  FactoryIssueStatus,
  FactoryState,
  FactoryStatusAction,
  FactoryStatusSnapshot,
} from "../observability/status.js";

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
      lifecycle.kind === "actionable-follow-up"
        ? "actionable-follow-up"
        : lifecycle.kind === "awaiting-human-handoff"
          ? "awaiting-human-handoff"
          : lifecycle.kind === "awaiting-system-checks"
            ? "awaiting-system-checks"
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
      lifecycle.kind === "awaiting-system-checks" ||
      lifecycle.kind === "awaiting-landing" ||
      lifecycle.kind === "actionable-follow-up"
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

export function buildFactoryStatusSnapshot(input: {
  readonly state: RuntimeStatusState;
  readonly instanceId: string;
  readonly workerPid: number;
  readonly pollIntervalMs: number;
  readonly maxConcurrentRuns: number;
  readonly activeLocalRuns: number;
  readonly retries: ReadonlyMap<number, RetryState>;
}): FactoryStatusSnapshot {
  const activeIssues = [...input.state.activeIssues.values()].sort(
    (left, right) => left.issueNumber - right.issueNumber,
  );
  const retries = [...input.retries.values()]
    .sort((left, right) => left.issue.number - right.issue.number)
    .map((retry) => ({
      issueNumber: retry.issue.number,
      issueIdentifier: retry.issue.identifier,
      title: retry.issue.title,
      nextAttempt: retry.nextAttempt,
      dueAt: new Date(retry.dueAt).toISOString(),
      lastError: retry.lastError,
    }));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
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
