import type {
  PullRequestLifecycle,
  ReviewFeedback,
} from "../domain/pull-request.js";
import type { PullRequestSnapshot } from "./pull-request-snapshot.js";

export interface NoCheckObservation {
  readonly url: string;
  readonly latestCommitAt: string | null;
}

export interface PullRequestPolicyResult {
  readonly lifecycle: PullRequestLifecycle;
  readonly nextNoCheckObservation: NoCheckObservation | null;
}

function summarizeLifecycle(
  url: string,
  failingCheckNames: readonly string[],
  pendingCheckNames: readonly string[],
  actionableReviewFeedback: readonly ReviewFeedback[],
): string {
  const parts: string[] = [`Follow-up required for ${url}`];
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
): PullRequestLifecycle {
  return {
    kind: "missing",
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
  if (
    snapshot.botActionableReviewFeedback.length > 0 ||
    (snapshot.failingCheckNames.length > 0 &&
      snapshot.pendingCheckNames.length === 0)
  ) {
    return {
      lifecycle: {
        kind: "needs-follow-up",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: snapshot.actionableReviewFeedback,
        unresolvedThreadIds: snapshot.unresolvedThreadIds,
        summary: summarizeLifecycle(
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
        kind: "awaiting-review",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        summary: summarizeLifecycle(
          snapshot.pullRequest.url,
          snapshot.failingCheckNames,
          snapshot.pendingCheckNames,
          [],
        ),
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.pendingCheckNames.length > 0) {
    return {
      lifecycle: {
        kind: "awaiting-review",
        branchName: snapshot.branchName,
        pullRequest: snapshot.pullRequest,
        checks: snapshot.checks,
        pendingCheckNames: snapshot.pendingCheckNames,
        failingCheckNames: snapshot.failingCheckNames,
        actionableReviewFeedback: [],
        unresolvedThreadIds: [],
        summary: `Waiting for ${snapshot.pendingCheckNames.join(", ")} on ${snapshot.pullRequest.url}`,
      },
      nextNoCheckObservation: null,
    };
  }

  if (snapshot.actionableReviewFeedback.length > 0) {
    return {
      lifecycle: {
        kind: "awaiting-review",
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
          kind: "awaiting-review",
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
      kind: "ready",
      branchName: snapshot.branchName,
      pullRequest: snapshot.pullRequest,
      checks: snapshot.checks,
      pendingCheckNames: snapshot.pendingCheckNames,
      failingCheckNames: snapshot.failingCheckNames,
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      summary: `Pull request ${snapshot.pullRequest.url} is merge-ready`,
    },
    nextNoCheckObservation: null,
  };
}
