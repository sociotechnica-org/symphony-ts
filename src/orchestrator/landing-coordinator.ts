import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { Logger } from "../observability/logger.js";
import type { LandingExecutionResult, Tracker } from "../tracker/service.js";
import {
  clearLandingRuntimeState,
  noteLandingAttempt,
  shouldExecuteLanding,
} from "./landing-state.js";
import type { OrchestratorState } from "./state.js";
import { noteLifecycleForIssue, noteStatusAction, upsertActiveIssue } from "./status-state.js";

export interface LandingCoordinatorContext {
  readonly logger: Logger;
  readonly tracker: Tracker;
  readonly state: OrchestratorState;
  readonly normalizeFailure: (error: Error) => string;
  readonly persistStatusSnapshot: () => Promise<void>;
  readonly recordLifecycleObservation: (
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    lifecycle: HandoffLifecycle,
  ) => Promise<void>;
  readonly recordLandingObservation: (
    issue: RuntimeIssue,
    attempt: number,
    branchName: string,
    lifecycle: HandoffLifecycle,
    observedAt: string,
    landingResult: LandingExecutionResult | null,
    landingError: string | null,
  ) => Promise<void>;
  readonly refreshLifecycle: (branchName: string) => Promise<HandoffLifecycle>;
  readonly completeIssue: (
    issue: RuntimeIssue,
    options: {
      readonly attemptNumber: number;
      readonly branchName: string;
      readonly finishedAt: string;
      readonly lifecycle: HandoffLifecycle;
    },
  ) => Promise<void>;
}

export async function handleLandingLifecycle(
  context: LandingCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
  source: "ready" | "running",
  branchName: string,
  lifecycle: HandoffLifecycle,
): Promise<void> {
  const headSha = lifecycle.pullRequest?.headSha ?? null;
  if (shouldExecuteLanding(context.state.landing, issue.number, headSha)) {
    await executeLanding(
      context,
      issue,
      attempt,
      source,
      branchName,
      lifecycle,
    );
    return;
  }

  noteLifecycleForIssue(
    context.state.status,
    issue,
    source,
    attempt,
    branchName,
    lifecycle,
  );
  noteStatusAction(context.state.status, {
    kind: lifecycle.kind,
    summary: lifecycle.summary,
    issueNumber: issue.number,
  });
  await context.persistStatusSnapshot();
  await context.recordLifecycleObservation(issue, attempt, branchName, lifecycle);
}

export async function executeLanding(
  context: LandingCoordinatorContext,
  issue: RuntimeIssue,
  attempt: number,
  source: "ready" | "running",
  branchName: string,
  lifecycle: HandoffLifecycle,
): Promise<void> {
  const observedAt = new Date().toISOString();
  noteStatusAction(context.state.status, {
    kind: "landing-started",
    summary: `Executing landing for ${issue.identifier}`,
    issueNumber: issue.number,
  });
  noteLifecycleForIssue(
    context.state.status,
    issue,
    source,
    attempt,
    branchName,
    lifecycle,
  );
  await context.persistStatusSnapshot();

  let landingError: string | null = null;
  let landingResult: LandingExecutionResult | null = null;
  try {
    noteLandingAttempt(
      context.state.landing,
      issue.number,
      lifecycle.pullRequest?.headSha ?? null,
    );
    if (lifecycle.pullRequest === null) {
      throw new Error("Cannot execute landing without a pull request handle");
    }
    landingResult = await context.tracker.executeLanding(lifecycle.pullRequest);
    if (landingResult.kind === "blocked") {
      context.logger.info("Landing blocked by guard", {
        issueNumber: issue.number,
        branchName,
        pullRequestNumber: lifecycle.pullRequest.number,
        reason: landingResult.reason,
        lifecycleKind: landingResult.lifecycleKind,
        summary: landingResult.summary,
      });
    }
  } catch (error) {
    landingError = context.normalizeFailure(error as Error);
    context.logger.warn("Landing execution failed", {
      issueNumber: issue.number,
      branchName,
      pullRequestNumber: lifecycle.pullRequest?.number ?? null,
      error: landingError,
    });
  }
  await context.recordLandingObservation(
    issue,
    attempt,
    branchName,
    lifecycle,
    observedAt,
    landingResult,
    landingError,
  );

  const refreshedLifecycle = await context.refreshLifecycle(branchName);
  if (refreshedLifecycle.kind === "handoff-ready") {
    clearLandingRuntimeState(context.state.landing, issue.number);
    await context.completeIssue(issue, {
      attemptNumber: attempt,
      branchName,
      finishedAt: new Date().toISOString(),
      lifecycle: refreshedLifecycle,
    });
    return;
  }

  if (
    landingResult?.kind === "blocked" ||
    refreshedLifecycle.kind !== "awaiting-landing"
  ) {
    clearLandingRuntimeState(context.state.landing, issue.number);
  }

  noteLifecycleForIssue(
    context.state.status,
    issue,
    source,
    attempt,
    branchName,
    refreshedLifecycle,
  );
  if (landingResult?.kind === "blocked") {
    upsertActiveIssue(context.state.status, issue, {
      source,
      runSequence: attempt,
      branchName,
      status: landingResult.lifecycleKind,
      summary: landingResult.summary,
      blockedReason: landingResult.summary,
    });
  }
  noteStatusAction(context.state.status, {
    kind:
      landingError !== null
        ? "landing-failed"
        : landingResult?.kind === "blocked"
          ? "landing-blocked"
          : refreshedLifecycle.kind,
    summary:
      landingError !== null
        ? `Landing request failed for ${issue.identifier}: ${landingError}`
        : landingResult?.kind === "blocked"
          ? landingResult.summary
          : refreshedLifecycle.summary,
    issueNumber: issue.number,
  });
  await context.persistStatusSnapshot();
  if (landingError === null) {
    await context.recordLifecycleObservation(
      issue,
      attempt,
      branchName,
      refreshedLifecycle,
    );
  }
}
