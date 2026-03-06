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

  if (checks.length === 0) {
    return {
      overall: "pending",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed: [],
      successful: [],
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
      failed: [],
      successful: checks.filter((check) =>
        SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
      ),
    };
  }

  const failed = checks.filter((check) =>
    FAILED_CONCLUSIONS.has(check.conclusion),
  );
  if (failed.length > 0) {
    return {
      overall: "failure",
      checks,
      reviewThreads: threads,
      unresolvedThreads,
      pending: [],
      failed,
      successful: checks.filter((check) =>
        SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
      ),
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
      successful: checks.filter((check) =>
        SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
      ),
    };
  }

  return {
    overall: "success",
    checks,
    reviewThreads: threads,
    unresolvedThreads,
    pending: [],
    failed: [],
    successful: checks.filter((check) =>
      SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
    ),
  };
}
