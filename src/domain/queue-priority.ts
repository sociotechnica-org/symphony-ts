import type { QueuePriority, RuntimeIssue } from "./issue.js";

export function compareQueuePriority(
  left: QueuePriority | null | undefined,
  right: QueuePriority | null | undefined,
): number {
  if (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined
  ) {
    return left.rank - right.rank;
  }
  if (left !== null && left !== undefined) {
    return -1;
  }
  if (right !== null && right !== undefined) {
    return 1;
  }
  return 0;
}

export function compareRuntimeIssuesByQueuePriority(
  left: RuntimeIssue,
  right: RuntimeIssue,
): number {
  const priorityComparison = compareQueuePriority(
    left.queuePriority,
    right.queuePriority,
  );
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  return left.number - right.number;
}
