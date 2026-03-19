import type { RuntimeIssue } from "../../src/domain/issue.js";
import type {
  HandoffLifecycle,
  ReviewFeedback,
} from "../../src/domain/handoff.js";

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
    queuePriority: null,
  };
}

export function createLifecycle(
  kind: HandoffLifecycle["kind"],
  branchName: string,
  options?: {
    failingCheckNames?: readonly string[];
    pendingCheckNames?: readonly string[];
    actionableReviewFeedback?: readonly ReviewFeedback[];
    unresolvedThreadIds?: readonly string[];
  },
): HandoffLifecycle {
  return {
    kind,
    branchName,
    pullRequest:
      kind === "missing-target" || kind === "awaiting-human-handoff"
        ? null
        : {
            number: 1,
            url: `https://example.test/pulls/${branchName}`,
            branchName,
            headSha: "test-head-sha",
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
