import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "../tracker/service.js";
import { clearLandingRuntimeState } from "./landing-state.js";
import type { LocalIssueLeaseManager } from "./issue-lease.js";
import type { OrchestratorState } from "./state.js";
import {
  adjustTrackerIssueCounts,
  noteLifecycleForIssue,
  noteStatusAction,
  upsertActiveIssue,
} from "./status-state.js";

export interface ClaimedIssueCoordinatorContext {
  readonly logger: Logger;
  readonly tracker: Tracker;
  readonly leaseManager: LocalIssueLeaseManager;
  readonly state: OrchestratorState;
  readonly recoveredRunningLifecycles: Map<number, HandoffLifecycle>;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly branchName: (issueNumber: number) => string;
  readonly missingLifecycle: (issueNumber: number) => HandoffLifecycle;
  readonly handleUnexpectedFailure: (
    issue: RuntimeIssue,
    attempt: number,
    error: Error,
  ) => Promise<void>;
  readonly recordClaimedArtifact: (
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
  ) => Promise<void>;
  readonly recordRunningInspectionArtifact: (
    issue: RuntimeIssue,
    branchName: string,
  ) => Promise<void>;
  readonly recordLifecycleObservation: (
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    lifecycle: HandoffLifecycle,
  ) => Promise<void>;
  readonly completeIssue: (
    issue: RuntimeIssue,
    options: {
      readonly branchName: string;
      readonly lifecycle: HandoffLifecycle;
    },
  ) => Promise<void>;
  readonly handleLandingLifecycle: (
    issue: RuntimeIssue,
    attempt: number,
    source: "ready" | "running",
    branchName: string,
    lifecycle: HandoffLifecycle,
  ) => Promise<void>;
  readonly runIssue: (
    issue: RuntimeIssue,
    attempt: number,
    lockDir: string,
    source: "ready" | "running",
    lifecycle: HandoffLifecycle | null,
  ) => Promise<boolean>;
  readonly refreshLifecycle: (branchName: string) => Promise<HandoffLifecycle>;
}

export async function processReadyIssue(
  context: ClaimedIssueCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
): Promise<void> {
  await withIssueLease(context, issue, attempt, async (lockDir) => {
    const claimed = await context.tracker.claimIssue(issue.number);
    if (claimed === null) {
      context.logger.info("Issue was no longer claimable", {
        issueNumber: issue.number,
      });
      noteStatusAction(context.state.status, {
        kind: "claim-skipped",
        summary: `Issue #${issue.number.toString()} was no longer claimable`,
        issueNumber: issue.number,
      });
      await context.persistStatusSnapshot();
      return false;
    }
    const branchName = context.branchName(claimed.number);
    upsertActiveIssue(context.state.status, claimed, {
      source: "ready",
      runSequence: attempt,
      branchName,
      status: "queued",
      summary: `Claimed ${claimed.identifier}`,
      executionOwner: null,
      ownerPid: process.pid,
    });
    adjustTrackerIssueCounts(context.state.status, {
      ready: -1,
      running: 1,
    });
    noteStatusAction(context.state.status, {
      kind: "issue-claimed",
      summary: `Claimed ${claimed.identifier}`,
      issueNumber: claimed.number,
    });
    await context.persistStatusSnapshot();
    await context.recordClaimedArtifact(claimed, attempt, branchName);
    return await processClaimedIssue(
      context,
      claimed,
      attempt,
      lockDir,
      context.missingLifecycle(claimed.number),
      "ready",
    );
  });
}

export async function processRunningIssue(
  context: ClaimedIssueCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
): Promise<void> {
  await withIssueLease(context, issue, attempt, async (lockDir) => {
    const initialLifecycle = context.recoveredRunningLifecycles.get(issue.number);
    context.recoveredRunningLifecycles.delete(issue.number);
    upsertActiveIssue(context.state.status, issue, {
      source: "running",
      runSequence: attempt,
      branchName: context.branchName(issue.number),
      status: "queued",
      summary: `Inspecting ${issue.identifier}`,
      executionOwner: null,
      ownerPid: process.pid,
    });
    noteStatusAction(context.state.status, {
      kind: "issue-resumed",
      summary: `Inspecting running issue ${issue.identifier}`,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    await context.recordRunningInspectionArtifact(
      issue,
      context.branchName(issue.number),
    );
    return await processClaimedIssue(
      context,
      issue,
      attempt,
      lockDir,
      initialLifecycle,
      "running",
    );
  });
}

export async function withIssueLease(
  context: ClaimedIssueCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
  work: (lockDir: string) => Promise<boolean>,
): Promise<void> {
  const lease = await context.leaseManager.acquire(issue.number);
  if (!lease) {
    return;
  }
  let preserveLease = false;
  try {
    preserveLease = await work(lease);
  } catch (error) {
    await context.handleUnexpectedFailure(issue, attempt, error as Error);
  } finally {
    if (!preserveLease) {
      await context.leaseManager.release(lease);
    }
    await context.persistStatusSnapshot();
  }
}

export async function processClaimedIssue(
  context: ClaimedIssueCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
  lockDir: string,
  initialLifecycle?: HandoffLifecycle,
  issueSourceOverride?: "ready" | "running",
): Promise<boolean> {
  const branchName = context.branchName(issue.number);
  const issueSource =
    issueSourceOverride ??
    (initialLifecycle !== undefined ? "ready" : "running");
  const lifecycle =
    initialLifecycle ?? (await context.refreshLifecycle(branchName));

  if (lifecycle.kind === "handoff-ready") {
    clearLandingRuntimeState(context.state.landing, issue.number);
    await context.completeIssue(issue, {
      branchName,
      lifecycle,
    });
    return false;
  }

  if (
    lifecycle.kind === "awaiting-system-checks" ||
    lifecycle.kind === "awaiting-human-handoff" ||
    lifecycle.kind === "awaiting-human-review" ||
    lifecycle.kind === "degraded-review-infrastructure" ||
    lifecycle.kind === "awaiting-landing-command"
  ) {
    clearLandingRuntimeState(context.state.landing, issue.number);
    noteLifecycleForIssue(
      context.state.status,
      issue,
      issueSource,
      attempt,
      branchName,
      lifecycle,
    );
    context.logger.info("Issue remains in handoff review", {
      issueNumber: issue.number,
      summary: lifecycle.summary,
    });
    noteStatusAction(context.state.status, {
      kind: lifecycle.kind,
      summary: lifecycle.summary,
      issueNumber: issue.number,
    });
    await context.persistStatusSnapshot();
    await context.recordLifecycleObservation(issue, attempt, branchName, lifecycle);
    return false;
  }

  if (lifecycle.kind === "awaiting-landing") {
    await context.handleLandingLifecycle(
      issue,
      attempt,
      issueSource,
      branchName,
      lifecycle,
    );
    return false;
  }

  if (lifecycle.kind === "rework-required") {
    await context.recordLifecycleObservation(issue, attempt, branchName, lifecycle);
  }

  return await context.runIssue(
    issue,
    attempt,
    lockDir,
    issueSource,
    lifecycle,
  );
}
