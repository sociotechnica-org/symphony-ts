import type { PullRequestSnapshot } from "./pull-request-snapshot.js";
import type {
  LandingBlockedResult,
  LandingRequestedResult,
} from "./service.js";

export interface GuardedLandingSnapshot {
  readonly approvedHeadSha: string | null;
  readonly pullRequest: PullRequestSnapshot["pullRequest"];
  readonly landingState: "open" | "merged";
  readonly mergeable: boolean | null;
  readonly mergeStateStatus: string | null;
  readonly draft: boolean;
  readonly pendingCheckNames: readonly string[];
  readonly failingCheckNames: readonly string[];
  readonly botActionableReviewFeedback: PullRequestSnapshot["botActionableReviewFeedback"];
  readonly unresolvedReviewThreadCount: number;
  readonly requiredApprovedReviewSatisfied: boolean;
}

// Fail closed: GitHub can report "unstable" when only non-required checks fail,
// but Symphony intentionally refuses to land while any check is failing.
const PASSING_MERGE_STATES = new Set(["clean", "has_hooks"]);

function formatPullRequest(snapshot: GuardedLandingSnapshot): string {
  return `pull request ${snapshot.pullRequest.url}`;
}

function checksBlockedLifecycleKind(
  snapshot: GuardedLandingSnapshot,
): "awaiting-system-checks" | "rework-required" {
  return snapshot.failingCheckNames.length > 0 &&
    snapshot.pendingCheckNames.length === 0
    ? "rework-required"
    : "awaiting-system-checks";
}

export function evaluateGuardedLanding(
  snapshot: GuardedLandingSnapshot,
): LandingRequestedResult | LandingBlockedResult {
  if (snapshot.landingState === "merged") {
    return {
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "merged",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because it is already merged.`,
    };
  }

  if (
    snapshot.approvedHeadSha !== null &&
    snapshot.pullRequest.headSha !== null &&
    snapshot.approvedHeadSha !== snapshot.pullRequest.headSha
  ) {
    return {
      kind: "blocked",
      reason: "stale-approved-head",
      lifecycleKind: "awaiting-landing-command",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because the approved head SHA is stale.`,
    };
  }

  if (snapshot.draft) {
    return {
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because the pull request is still a draft.`,
    };
  }

  if (snapshot.mergeable !== true) {
    return {
      kind: "blocked",
      reason:
        snapshot.mergeable === null
          ? "mergeability-unknown"
          : "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
      summary:
        snapshot.mergeable === null
          ? `Landing blocked for ${formatPullRequest(snapshot)} because GitHub mergeability is still unknown.`
          : `Landing blocked for ${formatPullRequest(snapshot)} because GitHub does not consider it mergeable.`,
    };
  }

  if (
    snapshot.failingCheckNames.length > 0 ||
    snapshot.pendingCheckNames.length > 0
  ) {
    return {
      kind: "blocked",
      reason: "checks-not-green",
      lifecycleKind: checksBlockedLifecycleKind(snapshot),
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because required checks are not terminal green.`,
    };
  }

  if (
    snapshot.mergeStateStatus !== null &&
    !PASSING_MERGE_STATES.has(snapshot.mergeStateStatus)
  ) {
    return {
      kind: "blocked",
      reason: "pull-request-not-mergeable",
      lifecycleKind: "awaiting-landing",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because GitHub reports merge state '${snapshot.mergeStateStatus}'.`,
    };
  }

  if (snapshot.botActionableReviewFeedback.length > 0) {
    return {
      kind: "blocked",
      reason: "actionable-review-feedback",
      lifecycleKind: "rework-required",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because actionable review feedback is still open.`,
    };
  }

  if (snapshot.unresolvedReviewThreadCount > 0) {
    return {
      kind: "blocked",
      reason: "review-threads-unresolved",
      lifecycleKind: "awaiting-human-review",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because unresolved non-outdated review threads remain.`,
    };
  }

  if (!snapshot.requiredApprovedReviewSatisfied) {
    return {
      kind: "blocked",
      reason: "required-bot-review-missing",
      lifecycleKind: "awaiting-human-review",
      summary: `Landing blocked for ${formatPullRequest(snapshot)} because required approved bot review has not been observed on the current head.`,
    };
  }

  return {
    kind: "requested",
    summary: `Landing requested for ${formatPullRequest(snapshot)}.`,
  };
}
