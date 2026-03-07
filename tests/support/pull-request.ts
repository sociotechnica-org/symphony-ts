import type { RuntimeIssue } from "../../src/domain/issue.js";
import type {
  PullRequestLifecycle,
  ReviewFeedback,
} from "../../src/domain/pull-request.js";

export function createIssue(
  number: number,
  label = "symphony:ready",
): RuntimeIssue {
  const timestamp = new Date().toISOString();
  return {
    id: String(number),
    identifier: `sociotechnica-org/symphony-ts#${number}`,
    number,
    title: `Issue ${number}`,
    description: `Description ${number}`,
    labels: [label],
    state: "open",
    url: `https://example.test/issues/${number}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifecycle(
  kind: PullRequestLifecycle["kind"],
  branchName: string,
  options?: {
    failingCheckNames?: readonly string[];
    pendingCheckNames?: readonly string[];
    actionableReviewFeedback?: readonly ReviewFeedback[];
    unresolvedThreadIds?: readonly string[];
  },
): PullRequestLifecycle {
  return {
    kind,
    branchName,
    pullRequest:
      kind === "missing" || kind === "awaiting-plan-review"
        ? null
        : {
            number: 1,
            url: `https://example.test/pulls/${branchName}`,
            branchName,
            latestCommitAt: new Date().toISOString(),
          },
    checks: [],
    pendingCheckNames: options?.pendingCheckNames ?? [],
    failingCheckNames: options?.failingCheckNames ?? [],
    actionableReviewFeedback: options?.actionableReviewFeedback ?? [],
    unresolvedThreadIds: options?.unresolvedThreadIds ?? [],
    summary: `${kind} for ${branchName}`,
  };
}
