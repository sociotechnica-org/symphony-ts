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

const PASSING_MERGE_STATES = new Set(["clean", "has_hooks"]);

function summarizeLifecycle(
  intro: string,
  url: string,
  failingCheckNames: readonly string[],
  pendingCheckNames: readonly string[],
  actionableReviewFeedback: readonly ReviewFeedback[],
  reviewerVerdict: PullRequestSnapshot["reviewerVerdict"],
  blockingReviewerKeys: readonly string[],
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
  if (reviewerVerdict === "blocking-issues-found") {
    parts.push(
      `reviewer-app verdict: issues found${blockingReviewerKeys.length === 0 ? "" : ` (${blockingReviewerKeys.join(", ")})`}`,
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
    reviewerVerdict: "no-blocking-verdict",
    blockingReviewerKeys: [],
    requiredReviewerState: "not-required",
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
        reviewerVerdict: "no-blocking-verdict",
        blockingReviewerKeys: [],
        requiredReviewerState: "not-required",
        summary: `Pull request ${snapshot.pullRequest.url} has merged`,
      },
      nextNoCheckObservation: null,
    };
  }

  if (
    snapshot.reviewerVerdict === "blocking-issues-found" ||
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: summarizeLifecycle(
          "Rework required for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
          snapshot.reviewerVerdict,
          snapshot.blockingReviewerKeys,
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: summarizeLifecycle(
          "Waiting on checks for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
          snapshot.reviewerVerdict,
          snapshot.blockingReviewerKeys,
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: summarizeLifecycle(
          "Waiting on checks for",
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          snapshot.actionableReviewFeedback,
          snapshot.reviewerVerdict,
          snapshot.blockingReviewerKeys,
        ),
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.requiredReviewerState === "running") {
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: `Waiting for reviewer apps to finish on ${snapshot.pullRequest.url}`,
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
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
          reviewerVerdict: snapshot.reviewerVerdict,
          blockingReviewerKeys: snapshot.blockingReviewerKeys,
          requiredReviewerState: snapshot.requiredReviewerState,
          summary: `Waiting for PR checks to appear on ${snapshot.pullRequest.url}`,
        },
        nextNoCheckObservation: observation,
      };
    }
  }

  if (snapshot.requiredReviewerState === "missing") {
    return {
      lifecycle: {
        kind: "degraded-review-infrastructure",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: `Degraded external review infrastructure for ${snapshot.pullRequest.url}; expected reviewer-app output has not been observed on the current head.`,
      },
      nextNoCheckObservation: previousNoCheckObservation ?? null,
    };
  }

  if (snapshot.requiredReviewerState === "unknown") {
    return {
      lifecycle: {
        kind: "degraded-review-infrastructure",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: `Degraded external review infrastructure for ${snapshot.pullRequest.url}; required reviewer-app output was observed on the current head but no explicit pass verdict was normalized.`,
      },
      nextNoCheckObservation: previousNoCheckObservation ?? null,
    };
  }

  if (snapshot.mergeable === null) {
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
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: `Waiting for GitHub mergeability to settle on ${snapshot.pullRequest.url}`,
      },
      nextNoCheckObservation: previousNoCheckObservation ?? null,
    };
  }

  if (
    snapshot.mergeable !== true ||
    (snapshot.mergeStateStatus !== null &&
      !PASSING_MERGE_STATES.has(snapshot.mergeStateStatus))
  ) {
    const mergeStateSummary =
      snapshot.mergeable !== true
        ? "GitHub does not consider the pull request mergeable"
        : `GitHub reports merge state '${snapshot.mergeStateStatus}'`;
    return {
      lifecycle: {
        kind: "rework-required",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        reviewerVerdict: snapshot.reviewerVerdict,
        blockingReviewerKeys: snapshot.blockingReviewerKeys,
        requiredReviewerState: snapshot.requiredReviewerState,
        summary: `${mergeStateSummary} for ${snapshot.pullRequest.url}`,
      },
      nextNoCheckObservation: previousNoCheckObservation ?? null,
    };
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
      reviewerVerdict: snapshot.reviewerVerdict,
      blockingReviewerKeys: snapshot.blockingReviewerKeys,
      requiredReviewerState: snapshot.requiredReviewerState,
      summary: snapshot.hasLandingCommand
        ? `Pull request ${snapshot.pullRequest.url} is awaiting landing / merge observation`
        : `Pull request ${snapshot.pullRequest.url} is awaiting a human /land command`,
    },
    nextNoCheckObservation: null,
  };
}
