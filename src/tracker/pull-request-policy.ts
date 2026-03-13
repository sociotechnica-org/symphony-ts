import type { HandoffLifecycle, ReviewFeedback } from "../domain/handoff.js";
import type { PullRequestSnapshot } from "./pull-request-snapshot.js";

export interface NoCheckObservation {
  readonly url: string;
  readonly latestCommitAt: string | null;
}

export interface PullRequestPolicyResult {
  readonly lifecycle: HandoffLifecycle;
  readonly nextNoCheckObservation: NoCheckObservation | null;
}

function summarizeLifecycle(
  intro: string,
  url: string,
  failingCheckNames: readonly string[],
  pendingCheckNames: readonly string[],
  actionableReviewFeedback: readonly ReviewFeedback[],
): string {
  const parts: string[] = [`${intro} ${url}`];
  if (failingCheckNames.length > 0) {
    parts.push(`failing checks: ${failingCheckNames.join(", ")}`);
  }
  if (pendingCheckNames.length > 0) {
    parts.push(`pending checks: ${pendingCheckNames.join(", ")}`);
  }
  if (actionableReviewFeedback.length > 0) {
    parts.push(
      `actionable feedback: ${actionableReviewFeedback.length.toString()}`,
    );
  }
  return parts.join("; ");
}

export function missingPullRequestLifecycle(
  branchName: string,
): HandoffLifecycle {
  return {
    kind: "missing-target",
    branchName,
    pullRequest: null,
    checks: [],
    pendingCheckNames: [],
    failingCheckNames: [],
    actionableReviewFeedback: [],
    unresolvedThreadIds: [],
    summary: `No open pull request found for ${branchName}`,
  };
}

export function evaluatePullRequestLifecycle(
  snapshot: PullRequestSnapshot,
  previousNoCheckObservation: NoCheckObservation | undefined,
): PullRequestPolicyResult {
  // GitHub bootstrap currently fast-paths merged PRs before this policy call.
  // Keep this branch for defensive correctness in tests and any future caller
  // that evaluates a merged snapshot directly.
  if (snapshot.landingState === "merged") {
    return {
      lifecycle: {
        kind: "handoff-ready",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: [],
        failingCheckNames: [],
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        summary: `Pull request ${snapshot.pullRequest.url} has merged`,
      },
      nextNoCheckObservation: null,
    };
  }

  if (
    snapshot.botActionableReviewFeedback.length > 0 ||
    (snapshot.failingCheckNames.length > 0 &&
      snapshot.pendingCheckNames.length === 0)
  ) {
    return {
      lifecycle: {
        kind: "rework-required",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: snapshot.actionableReviewFeedback,
        unresolvedThreadIds: snapshot.unresolvedThreadIds,
        summary: summarizeLifecycle(
          "Rework required for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
        ),
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.failingCheckNames.length > 0) {
    return {
      lifecycle: {
        kind: "awaiting-system-checks",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: snapshot.actionableReviewFeedback,
        unresolvedThreadIds: [],
        summary: summarizeLifecycle(
          "Waiting on checks for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
        ),
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.pendingCheckNames.length > 0) {
    return {
      lifecycle: {
        kind: "awaiting-system-checks",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: snapshot.actionableReviewFeedback,
        unresolvedThreadIds: [],
        summary: summarizeLifecycle(
          "Waiting on checks for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
        ),
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.actionableReviewFeedback.length > 0) {
    return {
      lifecycle: {
        kind: "awaiting-human-review",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: snapshot.actionableReviewFeedback,
        unresolvedThreadIds: [],
        summary: `Waiting for human review on ${snapshot.pullRequest.url}`,
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.checks.length === 0) {
    const observation = {
      url: snapshot.pullRequest.url,
      latestCommitAt: snapshot.pullRequest.latestCommitAt,
    };
    const sawSameNoCheckLifecycle =
      previousNoCheckObservation?.url === observation.url &&
      previousNoCheckObservation.latestCommitAt === observation.latestCommitAt;

    if (!sawSameNoCheckLifecycle) {
      return {
        lifecycle: {
          kind: "awaiting-system-checks",
          branchName: snapshot.branchName,
          pullRequest: snapshot.pullRequest,
          checks: snapshot.checks,
          pendingCheckNames: snapshot.pendingCheckNames,
          failingCheckNames: snapshot.failingCheckNames,
          actionableReviewFeedback: [],
          unresolvedThreadIds: [],
          summary: `Waiting for PR checks to appear on ${snapshot.pullRequest.url}`,
        },
        nextNoCheckObservation: observation,
      };
    }
  }

  return {
    lifecycle: {
      kind: snapshot.hasLandingCommand
        ? "awaiting-landing"
        : "awaiting-landing-command",
      branchName: snapshot.branchName,
      pullRequest: snapshot.pullRequest,
      checks: snapshot.checks,
      pendingCheckNames: [],
      failingCheckNames: [],
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      summary: snapshot.hasLandingCommand
        ? `Pull request ${snapshot.pullRequest.url} is awaiting landing / merge observation`
        : `Pull request ${snapshot.pullRequest.url} is awaiting a human /land command`,
    },
    nextNoCheckObservation: null,
  };
}
