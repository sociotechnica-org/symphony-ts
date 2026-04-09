import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { Logger } from "../observability/logger.js";
import type { FactoryRestartRecoveryIssueSnapshot } from "../observability/status.js";
import { claimHostForIssue, notePreferredHost } from "./host-dispatch-state.js";
import {
  type IssueLeaseSnapshot,
  type LocalIssueLeaseManager,
} from "./issue-lease.js";
import { decideRestartRecovery } from "./restart-recovery.js";
import type { OrchestratorState } from "./state.js";
import { noteStatusAction, setRestartRecoveryState } from "./status-state.js";

export interface RecoveredShutdownLease {
  readonly issueNumber: number;
  readonly lockDir: string;
  readonly shutdownState: "shutdown-terminated" | "shutdown-forced";
  readonly executionOwner: IssueLeaseSnapshot["executionOwner"];
  readonly runnerPid: number | null;
  readonly runnerAlive: boolean | null;
  readonly runSessionId: string | null;
}

export interface RestartRecoveryCoordinatorContext {
  readonly logger: Logger;
  readonly state: OrchestratorState;
  readonly leaseManager: LocalIssueLeaseManager;
  readonly startupRecoveryCompleted: () => boolean;
  readonly markStartupRecoveryCompleted: () => void;
  readonly recoveredRunningLifecycles: Map<number, HandoffLifecycle>;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly refreshLifecycle: (branchName: string) => Promise<HandoffLifecycle>;
  readonly branchName: (issueNumber: number) => string;
  readonly asRecoveredShutdownLease: (
    snapshot: IssueLeaseSnapshot,
  ) => RecoveredShutdownLease | null;
  readonly consumeRecoveredShutdownLease: (
    recoveredShutdown: RecoveredShutdownLease,
  ) => Promise<void>;
}

export async function reconcileRunningIssueOwnership(
  context: RestartRecoveryCoordinatorContext,
  issues: readonly RuntimeIssue[],
): Promise<readonly RuntimeIssue[]> {
  if (!context.startupRecoveryCompleted()) {
    setRestartRecoveryState(context.state.status, {
      state: "reconciling",
      startedAt: new Date().toISOString(),
      completedAt: null,
      summary: `Reconciling ${issues.length.toString()} inherited running issue${issues.length === 1 ? "" : "s"} before dispatch.`,
      issues: [],
    });
    await context.persistStatusSnapshot();
  }

  const runnable: RuntimeIssue[] = [];
  const observedIssues: FactoryRestartRecoveryIssueSnapshot[] = [];
  let degraded = false;

  for (const issue of issues) {
    const observedAt = new Date().toISOString();
    const branchName = context.branchName(issue.number);
    try {
      const snapshot = await context.leaseManager.inspect(issue.number);
      const lifecycle =
        snapshot.kind === "active" ||
        snapshot.kind === "shutdown-terminated" ||
        snapshot.kind === "shutdown-forced"
          ? null
          : await context.refreshLifecycle(
              snapshot.record?.branchName ?? branchName,
            );
      const decision = decideRestartRecovery({
        issue,
        branchName: snapshot.record?.branchName ?? branchName,
        snapshot,
        lifecycle,
      });

      observedIssues.push({
        issueNumber: issue.number,
        issueIdentifier: issue.identifier,
        branchName: decision.branchName,
        decision: decision.decision,
        leaseState: decision.leaseState,
        lifecycleKind: decision.lifecycleKind,
        executionOwner: snapshot.executionOwner,
        ownerPid: snapshot.ownerPid,
        ownerAlive: snapshot.ownerAlive,
        runnerPid: snapshot.runnerPid,
        runnerAlive: snapshot.runnerAlive,
        summary: decision.summary,
        observedAt,
      });

      await applyRestartRecoveryDecision(
        context,
        issue,
        snapshot,
        lifecycle,
        decision,
      );
      if (decision.shouldDispatch && lifecycle !== null) {
        context.recoveredRunningLifecycles.set(issue.number, lifecycle);
      }
      if (decision.shouldDispatch) {
        runnable.push(issue);
      }
      if (decision.decision === "degraded") {
        degraded = true;
      }
    } catch (error) {
      degraded = true;
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      context.logger.error("Failed to reconcile running issue ownership", {
        issueNumber: issue.number,
        error: normalizedError.message,
      });
      observedIssues.push({
        issueNumber: issue.number,
        issueIdentifier: issue.identifier,
        branchName,
        decision: "degraded",
        leaseState: "missing",
        lifecycleKind: null,
        executionOwner: null,
        ownerPid: null,
        ownerAlive: null,
        runnerPid: null,
        runnerAlive: null,
        summary: `Restart recovery failed for ${issue.identifier}: ${normalizedError.message}`,
        observedAt,
      });
    }
  }

  setRestartRecoveryState(context.state.status, {
    state: degraded ? "degraded" : "ready",
    startedAt: context.state.status.restartRecovery.startedAt,
    completedAt: new Date().toISOString(),
    summary: degraded
      ? "Restart recovery completed with degraded inherited-state decisions."
      : "Restart recovery completed successfully.",
    issues: observedIssues,
  });
  context.markStartupRecoveryCompleted();
  await context.persistStatusSnapshot();
  return runnable;
}

export async function applyRestartRecoveryDecision(
  context: RestartRecoveryCoordinatorContext,
  issue: RuntimeIssue,
  snapshot: IssueLeaseSnapshot,
  lifecycle: HandoffLifecycle | null,
  decision: ReturnType<typeof decideRestartRecovery>,
): Promise<void> {
  if (decision.decision === "adopted") {
    const adoptedRemoteHost =
      snapshot.executionOwner?.endpoint.workspaceHost ?? null;
    if (adoptedRemoteHost !== null) {
      notePreferredHost(
        context.state.hostDispatch,
        issue.number,
        adoptedRemoteHost,
      );
      const hostClaim = claimHostForIssue(
        context.state.hostDispatch,
        adoptedRemoteHost,
        issue.number,
        snapshot.executionOwner?.runSessionId ??
          snapshot.record?.runSessionId ??
          null,
      );
      if (hostClaim.kind === "unknown-host") {
        context.logger.warn(
          "Inherited remote run uses an unconfigured worker host",
          {
            issueNumber: issue.number,
            workerHost: adoptedRemoteHost,
            runSessionId:
              snapshot.executionOwner?.runSessionId ??
              snapshot.record?.runSessionId ??
              null,
          },
        );
      } else if (hostClaim.kind === "occupied") {
        context.logger.warn(
          "Inherited remote run could not reclaim occupied worker host",
          {
            issueNumber: issue.number,
            workerHost: adoptedRemoteHost,
            occupiedByIssueNumber: hostClaim.occupiedByIssueNumber,
            runSessionId:
              snapshot.executionOwner?.runSessionId ??
              snapshot.record?.runSessionId ??
              null,
          },
        );
      }
    }
    context.logger.info("Adopted healthy inherited ownership", {
      issueNumber: issue.number,
      ownershipState: snapshot.kind,
      executionOwner: snapshot.executionOwner,
      ownerPid: snapshot.ownerPid,
      runnerPid: snapshot.runnerPid,
    });
    noteStatusAction(context.state.status, {
      kind: "ownership-adopted",
      summary: decision.summary,
      issueNumber: issue.number,
    });
    return;
  }

  if (decision.decision === "recovered-shutdown") {
    const recoveredShutdown = context.asRecoveredShutdownLease(snapshot);
    if (recoveredShutdown !== null) {
      context.logger.info("Recovered intentional shutdown posture", {
        issueNumber: issue.number,
        shutdownState: recoveredShutdown.shutdownState,
        executionOwner: recoveredShutdown.executionOwner,
        runnerPid: recoveredShutdown.runnerPid,
        runnerAlive: recoveredShutdown.runnerAlive,
        runSessionId: recoveredShutdown.runSessionId,
      });
      await context.consumeRecoveredShutdownLease(recoveredShutdown);
    }
    noteStatusAction(context.state.status, {
      kind: "shutdown-recovered",
      summary: decision.summary,
      issueNumber: issue.number,
    });
    return;
  }

  if (decision.decision === "requeued") {
    if (snapshot.kind !== "missing") {
      await context.leaseManager.reconcile(issue.number, {
        preserveShutdown: false,
      });
    }
    context.logger.warn("Recovered stale local run ownership", {
      issueNumber: issue.number,
      ownershipState: snapshot.kind,
      executionOwner: snapshot.executionOwner,
      ownerPid: snapshot.ownerPid,
      runnerPid: snapshot.runnerPid,
      runSessionId: snapshot.record?.runSessionId ?? null,
    });
    noteStatusAction(context.state.status, {
      kind: "ownership-recovered",
      summary: decision.summary,
      issueNumber: issue.number,
    });
    return;
  }

  if (decision.decision === "suppressed-terminal" && lifecycle !== null) {
    if (snapshot.kind !== "missing") {
      await context.leaseManager.reconcile(issue.number, {
        preserveShutdown: false,
      });
    }
    context.logger.info("Suppressed restart rerun for inherited issue", {
      issueNumber: issue.number,
      ownershipState: snapshot.kind,
      lifecycleKind: lifecycle.kind,
    });
    noteStatusAction(context.state.status, {
      kind: "restart-recovery-suppressed",
      summary: decision.summary,
      issueNumber: issue.number,
    });
    return;
  }

  context.logger.error("Restart recovery remained degraded", {
    issueNumber: issue.number,
    ownershipState: snapshot.kind,
    lifecycleKind: lifecycle?.kind ?? null,
    summary: decision.summary,
  });
  noteStatusAction(context.state.status, {
    kind: "restart-recovery-degraded",
    summary: decision.summary,
    issueNumber: issue.number,
  });
}
