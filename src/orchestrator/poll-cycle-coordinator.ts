import { inspectFactoryHalt } from "../domain/factory-halt.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { DispatchPressureStateSnapshot } from "../domain/transient-failure.js";
import type { ResolvedConfig } from "../domain/workflow.js";
import { getConfigInstancePaths } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "../tracker/service.js";
import {
  countReservedLocalDispatches,
  hasReservedLocalDispatch,
} from "./local-dispatch-state.js";
import { collectDueRetries, listDueRetries } from "./retry-state.js";
import type { OrchestratorState } from "./state.js";
import {
  noteStatusAction,
  setFactoryHaltState,
  setReadyQueue,
  setTrackerIssueCounts,
} from "./status-state.js";
import {
  mergeDispatchQueue,
  orderReadyCandidates,
  type QueueEntry,
} from "./dispatch-queue.js";

export interface PollCycleCoordinatorContext {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly tracker: Tracker;
  readonly state: OrchestratorState;
  readonly recoveredRunningLifecycles: Map<number, HandoffLifecycle>;
  readonly notifyDashboard: () => void;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly fetchFailedCandidatesForStatus: () => Promise<
    readonly RuntimeIssue[]
  >;
  readonly pruneStaleActiveIssues: (
    readyIssues: readonly RuntimeIssue[],
    runningIssues: readonly RuntimeIssue[],
  ) => void;
  readonly reconcileRunningIssueOwnership: (
    issues: readonly RuntimeIssue[],
  ) => Promise<readonly RuntimeIssue[]>;
  readonly releaseExpiredDispatchPressure: () => DispatchPressureStateSnapshot | null;
  readonly resolveAttemptNumber: (
    issueNumber: number,
    retryAttempts: ReadonlyMap<number, number>,
  ) => number;
  readonly startDispatchTask: (entry: QueueEntry) => Promise<void> | null;
  readonly reconcileTerminalIssueReporting: () => Promise<void>;
}

export async function runPollCycle(
  context: PollCycleCoordinatorContext,
): Promise<readonly Promise<void>[]> {
  context.state.polling.checkingNow = true;
  context.recoveredRunningLifecycles.clear();
  context.notifyDashboard();

  let readyCandidates: readonly RuntimeIssue[];
  let runningCandidates: readonly RuntimeIssue[];
  let failedCandidates: readonly RuntimeIssue[];
  let queue: readonly QueueEntry[];
  let availableSlots: number;
  let dispatchPressure: DispatchPressureStateSnapshot | null;
  let factoryHalt: Awaited<ReturnType<typeof inspectFactoryHalt>>;

  try {
    noteStatusAction(context.state.status, {
      kind: "poll-started",
      summary: "Polling tracker for ready and running issues",
      issueNumber: null,
    });
    await context.persistStatusSnapshot();
    await context.tracker.ensureLabels();
    context.logger.info("Poll started");
    [readyCandidates, runningCandidates, failedCandidates] = await Promise.all([
      context.tracker.fetchReadyIssues(),
      context.tracker.fetchRunningIssues(),
      context.fetchFailedCandidatesForStatus(),
    ]);
    setTrackerIssueCounts(context.state.status, {
      ready: readyCandidates.length,
      running: runningCandidates.length,
      failed: failedCandidates.length,
    });
    factoryHalt = await inspectFactoryHalt(
      getConfigInstancePaths(context.config),
    );
    setFactoryHaltState(context.state.status, factoryHalt);
    context.pruneStaleActiveIssues(readyCandidates, runningCandidates);
    runningCandidates =
      await context.reconcileRunningIssueOwnership(runningCandidates);
    dispatchPressure = context.releaseExpiredDispatchPressure();
    const dueRetries =
      dispatchPressure === null && factoryHalt.state === "clear"
        ? collectDueRetries(context.state.retries)
        : listDueRetries(context.state.retries);
    const orderedReadyQueue = orderReadyCandidates(
      readyCandidates,
      runningCandidates,
      dueRetries,
      {
        hasQueuedRetry: (issueNumber) =>
          context.state.retries.queueByIssueNumber.has(issueNumber),
      },
    );
    setReadyQueue(context.state.status, orderedReadyQueue);
    queue = mergeDispatchQueue(
      dispatchPressure === null && factoryHalt.state === "clear"
        ? orderedReadyQueue
        : [],
      runningCandidates,
      factoryHalt.state === "clear" ? dueRetries : [],
      {
        hasQueuedRetry: (issueNumber) =>
          context.state.retries.queueByIssueNumber.has(issueNumber),
        resolveAttemptNumber: context.resolveAttemptNumber,
      },
    );
    availableSlots =
      context.config.polling.maxConcurrentRuns -
      countReservedLocalDispatches(context.state.localDispatch);
    context.logger.info("Poll candidates fetched", {
      readyCount: readyCandidates.length,
      runningCount: runningCandidates.length,
      failedCount: failedCandidates.length,
      candidateCount: queue.length,
      availableSlots,
      factoryHalt,
      dispatchPressure:
        dispatchPressure === null
          ? null
          : {
              retryClass: dispatchPressure.retryClass,
              resumeAt: dispatchPressure.resumeAt,
            },
    });
    noteStatusAction(context.state.status, {
      kind: "poll-fetched",
      summary:
        factoryHalt.state === "halted"
          ? `Factory halted since ${factoryHalt.haltedAt}; ${runningCandidates.length.toString()} running issues still inspected, new dispatch blocked until explicit resume`
          : factoryHalt.state === "degraded"
            ? `Factory halt state degraded: ${factoryHalt.detail ?? "unreadable halt state"}`
            : dispatchPressure === null
              ? `Found ${readyCandidates.length.toString()} ready, ${runningCandidates.length.toString()} running, ${failedCandidates.length.toString()} failed issues`
              : `Dispatch paused for ${dispatchPressure.retryClass} until ${dispatchPressure.resumeAt}; ${runningCandidates.length.toString()} running issues still inspected`,
      issueNumber: null,
    });
  } catch (err) {
    context.state.polling.checkingNow = false;
    try {
      context.notifyDashboard();
    } catch {
      /* don't mask the original error */
    }
    throw err;
  }
  context.state.polling.checkingNow = false;
  context.notifyDashboard();
  await context.persistStatusSnapshot();
  await context.reconcileTerminalIssueReporting();

  if (availableSlots <= 0) {
    return [];
  }

  const startedDispatchTasks: Promise<void>[] = [];
  let startedDispatches = 0;
  for (const entry of queue) {
    if (startedDispatches >= availableSlots) {
      break;
    }
    if (
      hasReservedLocalDispatch(context.state.localDispatch, entry.issue.number)
    ) {
      continue;
    }
    const task = context.startDispatchTask(entry);
    if (task !== null) {
      startedDispatches += 1;
      startedDispatchTasks.push(task);
    }
  }

  if (startedDispatches > 0) {
    context.notifyDashboard();
    await context.persistStatusSnapshot();
  }

  return startedDispatchTasks;
}
