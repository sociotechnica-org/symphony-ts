import { RunnerShutdownError } from "../domain/errors.js";
import type { ActiveRunExecutionOwner } from "../domain/execution-owner.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RetryClass } from "../domain/retry.js";
import type {
  ClassifiedTransientFailure,
  RateLimits,
  TransientFailureSignal,
} from "../domain/transient-failure.js";
import type { PreparedWorkspace } from "../domain/workspace.js";
import { getPreparedWorkspacePathHint } from "../domain/workspace.js";
import type {
  PromptBuilder,
  ResolvedConfig,
  SshWorkerHostConfig,
} from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type {
  LiveRunnerSession,
  Runner,
  RunnerSessionDescription,
  RunnerTurnResult,
  RunnerVisibilitySnapshot,
} from "../runner/service.js";
import { createRunnerAccountingSnapshot } from "../runner/accounting.js";
import type { WorkspaceManager } from "../workspace/service.js";
import {
  shouldContinueTurnLoop,
  type RunSessionArtifactsState,
} from "./continuation-turns.js";
import type { ActiveRunShutdownContext } from "./coordinator-types.js";
import { getActiveDispatchPressure } from "./dispatch-pressure-state.js";
import {
  bindHostReservationToRunSession,
  hasHostDispatchCapacity,
  notePreferredHost,
  releaseHostForIssue,
  reserveHostForIssue,
} from "./host-dispatch-state.js";
import type { LocalIssueLeaseManager } from "./issue-lease.js";
import { createRunningEntry } from "./running-entry.js";
import type { OrchestratorState } from "./state.js";
import { clearActiveWatchdogEntry } from "./watchdog-state.js";
import { noteStatusAction, upsertActiveIssue } from "./status-state.js";
import type { Tracker } from "../tracker/service.js";

export interface ActiveRunCoordinatorContext {
  readonly config: ResolvedConfig;
  readonly promptBuilder: PromptBuilder;
  readonly workspaceManager: WorkspaceManager;
  readonly runner: Runner;
  readonly tracker: Tracker;
  readonly logger: Logger;
  readonly state: OrchestratorState;
  readonly instanceId: string;
  readonly shutdownSignal: AbortSignal | undefined;
  readonly leaseManager: LocalIssueLeaseManager;
  readonly notifyDashboard: () => void;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly branchName: (issueNumber: number) => string;
  readonly createRunSession: (
    issue: RuntimeIssue,
    workspace: PreparedWorkspace,
    prompt: string,
    attempt: number,
  ) => RunSessionArtifactsState["runSession"];
  readonly createExecutionOwner: (
    session: RunSessionArtifactsState["runSession"],
    description: RunSessionArtifactsState["description"],
  ) => ActiveRunExecutionOwner | null;
  readonly buildRunnerVisibility: (
    description: RunnerSessionDescription,
    options: {
      readonly state:
        | "starting"
        | "running"
        | "waiting"
        | "completed"
        | "failed";
      readonly phase:
        | "boot"
        | "turn-execution"
        | "turn-finished"
        | "handoff-reconciliation"
        | "awaiting-external";
      readonly lastHeartbeatAt: string;
      readonly lastActionAt: string;
      readonly lastActionSummary: string;
      readonly waitingReason?: string;
      readonly stdoutSummary?: string | null;
      readonly stderrSummary?: string | null;
      readonly errorSummary?: string | null;
    },
  ) => RunnerVisibilitySnapshot;
  readonly recordRunStartedObservation: (
    issue: RuntimeIssue,
    attempt: number,
    sessionState: RunSessionArtifactsState,
    pullRequest: HandoffLifecycle | null,
  ) => Promise<void>;
  readonly createRunTurn: (
    initialPrompt: string,
    issue: RuntimeIssue,
    pullRequest: HandoffLifecycle | null,
    turnNumber: number,
  ) => Promise<{
    readonly prompt: string;
    readonly turnNumber: number;
  }>;
  readonly runRunnerTurn: (
    session: RunSessionArtifactsState["runSession"],
    liveRunnerSession: LiveRunnerSession | undefined,
    turn: {
      readonly prompt: string;
      readonly turnNumber: number;
    },
    lockDir: string,
    signal: AbortSignal,
    signalHandlers?: {
      readonly onRateLimits?: (rateLimits: RateLimits) => void;
      readonly onTransientFailureSignal?: (
        signal: TransientFailureSignal,
      ) => void;
    },
  ) => Promise<RunnerTurnResult>;
  readonly captureLiveSessionState: (
    sessionState: RunSessionArtifactsState,
    liveRunnerSession: LiveRunnerSession | undefined,
  ) => RunSessionArtifactsState;
  readonly warnIfContinuationSessionUnavailable: (
    issue: RuntimeIssue,
    branchName: string,
    session: RunSessionArtifactsState["runSession"],
    liveRunnerSession: LiveRunnerSession | undefined,
  ) => void;
  readonly initWatchdogEntry: (issueNumber: number) => void;
  readonly runWatchdogLoop: (
    issueNumber: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly setIssueRunnerVisibility: (
    issueNumber: number,
    visibility: RunnerVisibilitySnapshot,
    observedAt?: string,
  ) => void;
  readonly setIssueFailureVisibility: (
    issueNumber: number,
    description: RunnerSessionDescription,
    error: Error,
    message: string,
  ) => void;
  readonly beginActiveRunShutdown: (
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    session: RunSessionArtifactsState,
    lockDir: string,
    shutdownContext: ActiveRunShutdownContext,
  ) => void;
  readonly finalizeActiveRunShutdown: (
    issue: RuntimeIssue,
    attempt: number,
    lockDir: string,
    branchName: string,
    session: RunSessionArtifactsState,
    shutdownContext: ActiveRunShutdownContext,
    finishedAt: string,
    termination: "shutdown-forced" | "shutdown-terminated",
    reason: string,
  ) => Promise<void>;
  readonly handleFailure: (
    session: RunSessionArtifactsState,
    attempt: number,
    failure: ClassifiedTransientFailure,
    finishedAt?: string,
  ) => Promise<void>;
  readonly classifyFailure: (
    message: string,
    signal: TransientFailureSignal | null,
    observedAt: string,
    retryClass?: RetryClass,
  ) => ClassifiedTransientFailure;
  readonly resolveRunFailureMessage: (
    issueNumber: number,
    error: Error,
  ) => string;
  readonly resolveRetryClass: (issueNumber: number, error: Error) => RetryClass;
  readonly completeIssue: (
    issue: RuntimeIssue,
    options: {
      readonly attemptNumber: number;
      readonly branchName: string;
      readonly workspace: PreparedWorkspace;
      readonly session: RunSessionArtifactsState;
      readonly finishedAt: string;
      readonly lifecycle: HandoffLifecycle;
    },
  ) => Promise<void>;
  readonly handleTurnLifecycleExit: (
    issue: RuntimeIssue,
    attempt: number,
    source: "ready" | "running",
    branchName: string,
    lifecycle: HandoffLifecycle,
    session: RunSessionArtifactsState,
    finishedAt: string,
  ) => Promise<void>;
}

export async function runIssue(
  context: ActiveRunCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
  lockDir: string,
  source: "ready" | "running",
  pullRequest: HandoffLifecycle | null,
): Promise<boolean> {
  const factoryHalt = context.state.status.factoryHalt;
  if (factoryHalt.state !== "clear") {
    const summary =
      factoryHalt.state === "halted"
        ? `Factory halted since ${factoryHalt.haltedAt}; explicit resume is required before new dispatch`
        : `Factory halt state degraded: ${factoryHalt.detail ?? "unreadable halt state"}`;
    upsertActiveIssue(context.state.status, issue, {
      source,
      runSequence: attempt,
      branchName: context.branchName(issue.number),
      status: "queued",
      summary,
      executionOwner: null,
      ownerPid: process.pid,
      blockedReason:
        factoryHalt.state === "halted"
          ? factoryHalt.reason
          : factoryHalt.detail,
    });
    noteStatusAction(context.state.status, {
      kind:
        factoryHalt.state === "halted"
          ? "factory-halted"
          : "factory-halt-degraded",
      summary,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    return false;
  }
  let selectedWorkerHost: SshWorkerHostConfig | null = null;
  const dispatchPressure = getActiveDispatchPressure(
    context.state.dispatchPressure,
  );
  if (dispatchPressure !== null) {
    const summary = `Dispatch paused for ${dispatchPressure.retryClass} until ${dispatchPressure.resumeAt}`;
    upsertActiveIssue(context.state.status, issue, {
      source,
      runSequence: attempt,
      branchName: context.branchName(issue.number),
      status: "queued",
      summary,
      executionOwner: null,
      ownerPid: process.pid,
      blockedReason: dispatchPressure.reason,
    });
    noteStatusAction(context.state.status, {
      kind: "dispatch-paused",
      summary,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    return false;
  }
  if (hasHostDispatchCapacity(context.state.hostDispatch)) {
    const reservation = reserveHostForIssue(
      context.state.hostDispatch,
      issue.number,
    );
    if (reservation.kind === "blocked") {
      const occupiedHosts =
        reservation.occupiedHosts.length === 0
          ? "none"
          : reservation.occupiedHosts.join(", ");
      const continuity =
        reservation.preferredHost === null
          ? ""
          : ` preferred host=${reservation.preferredHost}.`;
      const summary = `No remote worker host is currently available for ${issue.identifier}; occupied hosts: ${occupiedHosts}.${continuity}`;
      upsertActiveIssue(context.state.status, issue, {
        source,
        runSequence: attempt,
        branchName: context.branchName(issue.number),
        status: "queued",
        summary,
        executionOwner: null,
        ownerPid: process.pid,
        blockedReason: summary,
      });
      noteStatusAction(context.state.status, {
        kind: "dispatch-blocked-no-host",
        summary,
        issueNumber: issue.number,
      });
      await context.persistStatusSnapshot();
      return false;
    }
    selectedWorkerHost = reservation.workerHost;
    notePreferredHost(
      context.state.hostDispatch,
      issue.number,
      selectedWorkerHost.name,
    );
  }
  let hostReservationHeld = selectedWorkerHost !== null;
  const releaseReservedHost = (): void => {
    if (!hostReservationHeld) {
      return;
    }
    releaseHostForIssue(context.state.hostDispatch, issue.number);
    hostReservationHeld = false;
  };
  try {
    upsertActiveIssue(context.state.status, issue, {
      source,
      runSequence: attempt,
      branchName: context.branchName(issue.number),
      status: "preparing",
      summary:
        selectedWorkerHost === null
          ? `Preparing workspace for ${issue.identifier}`
          : `Preparing workspace for ${issue.identifier} on ${selectedWorkerHost.name}`,
      executionOwner: null,
      ownerPid: process.pid,
      runnerPid: null,
      blockedReason: null,
      runnerVisibility: null,
    });
    noteStatusAction(context.state.status, {
      kind: "run-preparing",
      summary:
        selectedWorkerHost === null
          ? `Preparing workspace for ${issue.identifier}`
          : `Preparing workspace for ${issue.identifier} on ${selectedWorkerHost.name}`,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    const workspace = await context.workspaceManager.prepareWorkspace({
      issue,
      workerHost: selectedWorkerHost,
    });
    const initialPrompt = await context.promptBuilder.build({
      issue,
      attempt: attempt > 1 ? attempt : null,
      pullRequest,
    });
    const session = context.createRunSession(
      issue,
      workspace,
      initialPrompt,
      attempt,
    );
    if (selectedWorkerHost !== null) {
      bindHostReservationToRunSession(
        context.state.hostDispatch,
        selectedWorkerHost.name,
        issue.number,
        session.id,
      );
    }
    let sessionState: RunSessionArtifactsState = {
      runSession: session,
      description: context.runner.describeSession(session),
      latestTurnNumber: null,
      accounting: createRunnerAccountingSnapshot(),
    };
    const initialExecutionOwner = context.createExecutionOwner(
      session,
      sessionState.description,
    );
    upsertActiveIssue(context.state.status, issue, {
      source,
      runSequence: attempt,
      branchName: workspace.branchName,
      status: "running",
      summary: `Running ${issue.identifier}`,
      workspacePath: getPreparedWorkspacePathHint(workspace),
      runSessionId: session.id,
      executionOwner: initialExecutionOwner,
      ownerPid: process.pid,
      runnerPid: null,
      startedAt: new Date().toISOString(),
      pullRequest:
        pullRequest?.pullRequest === undefined ||
        pullRequest.pullRequest === null
          ? null
          : {
              number: pullRequest.pullRequest.number,
              url: pullRequest.pullRequest.url,
              headSha: pullRequest.pullRequest.headSha,
              latestCommitAt: pullRequest.pullRequest.latestCommitAt,
            },
      checks: {
        pendingNames: pullRequest?.pendingCheckNames ?? [],
        failingNames: pullRequest?.failingCheckNames ?? [],
      },
      review: {
        actionableCount: pullRequest?.actionableReviewFeedback.length ?? 0,
        unresolvedThreadCount: pullRequest?.unresolvedThreadIds.length ?? 0,
      },
      blockedReason: null,
      runnerAccounting: sessionState.accounting,
      runnerVisibility: context.buildRunnerVisibility(
        sessionState.description,
        {
          state: "starting",
          phase: "boot",
          lastHeartbeatAt: session.startedAt,
          lastActionAt: session.startedAt,
          lastActionSummary: "Runner session created",
        },
      ),
    });
    noteStatusAction(context.state.status, {
      kind: "run-started",
      summary: `Started agent run for ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    await context.recordRunStartedObservation(
      issue,
      attempt,
      sessionState,
      pullRequest,
    );
    await context.leaseManager.recordRun(
      lockDir,
      session,
      sessionState.description,
      {
        factoryInstanceId: context.instanceId,
        factoryPid: process.pid,
      },
    );
    const abortController = new AbortController();
    const shutdownSignal = context.shutdownSignal;
    const shutdownContext: ActiveRunShutdownContext = {
      requestedAt: null,
      gracefulDeadlineAt: null,
      writePromise: Promise.resolve(),
    };
    let liveRunnerSession: LiveRunnerSession | undefined;
    const currentSessionState = (): RunSessionArtifactsState =>
      context.captureLiveSessionState(sessionState, liveRunnerSession);
    const handleShutdown = (): void => {
      context.beginActiveRunShutdown(
        issue,
        attempt,
        workspace.branchName,
        currentSessionState(),
        lockDir,
        shutdownContext,
      );
      abortController.abort();
    };
    if (shutdownSignal?.aborted) {
      handleShutdown();
    } else if (shutdownSignal) {
      shutdownSignal.addEventListener("abort", handleShutdown, {
        once: true,
      });
    }
    context.state.runAbortControllers.set(issue.number, abortController);
    context.initWatchdogEntry(issue.number);
    let transientFailureSignal: TransientFailureSignal | null = null;

    const watchdogStop = new AbortController();
    const watchdogPromise = context.runWatchdogLoop(
      issue.number,
      watchdogStop.signal,
    );
    let watchdogStopped = false;
    const stopWatchdog = async (): Promise<void> => {
      if (watchdogStopped) {
        return;
      }
      watchdogStopped = true;
      watchdogStop.abort();
      await watchdogPromise;
    };
    const runEntry = createRunningEntry(
      issue.number,
      issue.identifier,
      issue.state,
      attempt,
    );
    context.state.runningEntries.set(issue.number, runEntry);
    context.notifyDashboard();

    try {
      liveRunnerSession = await context.runner.startSession?.(session);
      sessionState = currentSessionState();
      context.warnIfContinuationSessionUnavailable(
        issue,
        workspace.branchName,
        session,
        liveRunnerSession,
      );
      let currentLifecycle =
        pullRequest?.kind === "missing-target" ? null : pullRequest;
      let turnNumber = 1;

      while (true) {
        transientFailureSignal = null;
        const turn = await context.createRunTurn(
          session.prompt,
          issue,
          currentLifecycle,
          turnNumber,
        );
        context.setIssueRunnerVisibility(
          issue.number,
          context.buildRunnerVisibility(sessionState.description, {
            state: "running",
            phase: "turn-execution",
            lastHeartbeatAt: new Date().toISOString(),
            lastActionAt: new Date().toISOString(),
            lastActionSummary: `Starting turn ${turn.turnNumber.toString()}`,
          }),
        );
        await context.persistStatusSnapshot();
        const result = await context.runRunnerTurn(
          session,
          liveRunnerSession,
          turn,
          lockDir,
          abortController.signal,
          {
            onRateLimits: (rateLimits) => {
              context.state.rateLimits = rateLimits;
            },
            onTransientFailureSignal: (signal) => {
              transientFailureSignal = signal;
            },
          },
        );
        sessionState = {
          runSession: session,
          description: result.session,
          latestTurnNumber: turn.turnNumber,
          accounting:
            context.state.runningEntries.get(issue.number)?.accounting ??
            sessionState.accounting,
        };

        if (result.exitCode !== 0) {
          await stopWatchdog();
          context.setIssueRunnerVisibility(
            issue.number,
            context.buildRunnerVisibility(result.session, {
              state: "failed",
              phase: "turn-finished",
              lastHeartbeatAt: result.finishedAt,
              lastActionAt: result.finishedAt,
              lastActionSummary: `Turn ${turn.turnNumber.toString()} failed`,
              stdoutSummary: result.stdout.slice(0, 400) || null,
              stderrSummary: result.stderr.slice(0, 400) || null,
              errorSummary:
                `Runner exited with ${result.exitCode}\n${result.stderr}`.slice(
                  0,
                  400,
                ) || null,
            }),
          );
          await context.handleFailure(
            sessionState,
            attempt,
            context.classifyFailure(
              `Runner exited with ${result.exitCode}\n${result.stderr}`,
              transientFailureSignal,
              result.finishedAt,
            ),
            result.finishedAt,
          );
          return false;
        }
        transientFailureSignal = null;

        context.setIssueRunnerVisibility(
          issue.number,
          context.buildRunnerVisibility(result.session, {
            state: "completed",
            phase: "turn-finished",
            lastHeartbeatAt: result.finishedAt,
            lastActionAt: result.finishedAt,
            lastActionSummary: `Turn ${turn.turnNumber.toString()} completed`,
            stdoutSummary: result.stdout.slice(0, 400) || null,
            stderrSummary: result.stderr.slice(0, 400) || null,
          }),
        );

        context.setIssueRunnerVisibility(
          issue.number,
          context.buildRunnerVisibility(result.session, {
            state: "waiting",
            phase: "handoff-reconciliation",
            lastHeartbeatAt: result.finishedAt,
            lastActionAt: result.finishedAt,
            lastActionSummary: `Reconciling handoff after turn ${turn.turnNumber.toString()}`,
            waitingReason: "Waiting for tracker reconciliation",
            stdoutSummary: result.stdout.slice(0, 400) || null,
            stderrSummary: result.stderr.slice(0, 400) || null,
          }),
          result.finishedAt,
        );
        await context.persistStatusSnapshot();
        if (shutdownContext.requestedAt !== null) {
          await stopWatchdog();
          await context.finalizeActiveRunShutdown(
            issue,
            attempt,
            lockDir,
            workspace.branchName,
            currentSessionState(),
            shutdownContext,
            result.finishedAt,
            "shutdown-terminated",
            "Runner exited during coordinated shutdown",
          );
          return true;
        }
        const nextLifecycle = await context.tracker.reconcileSuccessfulRun(
          workspace.branchName,
          currentLifecycle,
        );

        if (nextLifecycle.kind === "handoff-ready") {
          await stopWatchdog();
          await context.completeIssue(issue, {
            attemptNumber: attempt,
            branchName: workspace.branchName,
            workspace,
            session: sessionState,
            finishedAt: result.finishedAt,
            lifecycle: nextLifecycle,
          });
          return false;
        }

        if (
          shouldContinueTurnLoop(
            nextLifecycle,
            turn.turnNumber,
            context.config.agent.maxTurns,
          )
        ) {
          upsertActiveIssue(context.state.status, issue, {
            source,
            runSequence: attempt,
            branchName: workspace.branchName,
            status: "running",
            summary: `Running ${issue.identifier}`,
            pullRequest:
              nextLifecycle.pullRequest === null
                ? null
                : {
                    number: nextLifecycle.pullRequest.number,
                    url: nextLifecycle.pullRequest.url,
                    headSha: nextLifecycle.pullRequest.headSha,
                    latestCommitAt: nextLifecycle.pullRequest.latestCommitAt,
                  },
            checks: {
              pendingNames: nextLifecycle.pendingCheckNames,
              failingNames: nextLifecycle.failingCheckNames,
            },
            review: {
              actionableCount: nextLifecycle.actionableReviewFeedback.length,
              unresolvedThreadCount: nextLifecycle.unresolvedThreadIds.length,
            },
            blockedReason: null,
          });
          await context.persistStatusSnapshot();
          context.logger.info("Continuing agent turn on live session", {
            issueNumber: issue.number,
            branchName: workspace.branchName,
            runSessionId: session.id,
            backendSessionId: result.session.backendSessionId,
            lifecycle: nextLifecycle.kind,
            turnNumber: turn.turnNumber + 1,
            maxTurns: context.config.agent.maxTurns,
          });
          currentLifecycle = nextLifecycle;
          turnNumber += 1;
          continue;
        }

        await stopWatchdog();
        await context.handleTurnLifecycleExit(
          issue,
          attempt,
          source,
          workspace.branchName,
          nextLifecycle,
          sessionState,
          result.finishedAt,
        );
        return false;
      }
    } catch (error) {
      await stopWatchdog();
      if (
        error instanceof RunnerShutdownError &&
        shutdownContext.requestedAt !== null
      ) {
        await context.finalizeActiveRunShutdown(
          issue,
          attempt,
          lockDir,
          workspace.branchName,
          currentSessionState(),
          shutdownContext,
          new Date().toISOString(),
          error.termination === "forced"
            ? "shutdown-forced"
            : "shutdown-terminated",
          error.message,
        );
        return true;
      }
      const normalizedFailure = context.resolveRunFailureMessage(
        sessionState.runSession.issue.number,
        error as Error,
      );
      context.setIssueFailureVisibility(
        sessionState.runSession.issue.number,
        sessionState.description,
        error as Error,
        normalizedFailure,
      );
      await context.handleFailure(
        sessionState,
        attempt,
        context.classifyFailure(
          normalizedFailure,
          transientFailureSignal,
          new Date().toISOString(),
          context.resolveRetryClass(
            sessionState.runSession.issue.number,
            error as Error,
          ),
        ),
        new Date().toISOString(),
      );
      return false;
    } finally {
      await liveRunnerSession?.close().catch((error) => {
        context.logger.warn("Failed to close live runner session cleanly", {
          issueNumber: issue.number,
          branchName: workspace.branchName,
          runSessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await stopWatchdog();
      shutdownSignal?.removeEventListener("abort", handleShutdown);
      context.state.runAbortControllers.delete(issue.number);
      releaseReservedHost();
      clearActiveWatchdogEntry(context.state.watchdog, issue.number);
      context.state.runningEntries.delete(issue.number);
      context.notifyDashboard();
    }
  } finally {
    releaseReservedHost();
  }
}
