export const SUCCESSFUL_CONCLUSIONS = new Set([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
]);

export const FAILED_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);

export function normalizeChecks(statusCheckRollup) {
  return (statusCheckRollup ?? []).map((check) => ({
    name: check.name,
    status: check.status ?? "",
    conclusion: check.conclusion ?? "",
    detailsUrl: check.detailsUrl ?? "",
    workflowName: check.workflowName ?? "",
  }));
}

export function normalizeReviewThreads(reviewThreads) {
  return (reviewThreads ?? []).map((thread) => ({
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    comments: (thread.comments?.nodes ?? []).map((comment) => ({
      authorLogin: comment.author?.login ?? "",
      body: comment.body ?? "",
      path: comment.path ?? "",
    })),
  }));
}

export function summarizeChecks(statusCheckRollup, reviewThreads = []) {
  const checks = normalizeChecks(statusCheckRollup);
  const threads = normalizeReviewThreads(reviewThreads);
  const unresolvedThreads = threads.filter(
    (thread) => thread.isResolved !== true && thread.isOutdated !== true,
  );
  const successful = checks.filter((check) =>
    SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
  );
  const failed = checks.filter((check) =>
    FAILED_CONCLUSIONS.has(check.conclusion),
  );
  const unknown = checks.filter(
    (check) =>
      check.status === "COMPLETED" &&
      !SUCCESSFUL_CONCLUSIONS.has(check.conclusion) &&
      !FAILED_CONCLUSIONS.has(check.conclusion),
  );

  if (checks.length === 0) {
    return {
      overall: "pending",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed: [],
      successful: [],
      unknown: [],
    };
  }

  const pending = checks.filter((check) => check.status !== "COMPLETED");
  if (pending.length > 0) {
    return {
      overall: "pending",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending,
      failed,
      successful,
      unknown,
    };
  }

  if (failed.length > 0) {
    return {
      overall: "failure",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed,
      successful,
      unknown,
    };
  }

  if (unknown.length > 0) {
    return {
      overall: "failure",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed: [],
      successful,
      unknown,
    };
  }

  if (unresolvedThreads.length > 0) {
    return {
      overall: "failure",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed: [],
      successful,
      unknown,
    };
  }

  return {
    overall: "success",
    checks,
    reviewThreads: threads,
    unresolvedThreads,
    pending: [],
    failed: [],
    successful,
    unknown,
  };
}

export function nextPollDelayMilliseconds({
  startedAt,
  now = Date.now(),
  intervalSeconds,
  timeoutSeconds,
}) {
  const intervalMilliseconds = intervalSeconds * 1000;
  const deadline = startedAt + timeoutSeconds * 1000;
  const remaining = deadline - now;

  if (remaining <= 0) {
    return 0;
  }

  return Math.min(intervalMilliseconds, remaining);
}
