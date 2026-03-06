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

export function summarizeChecks(statusCheckRollup) {
  const checks = normalizeChecks(statusCheckRollup);

  if (checks.length === 0) {
    return {
      overall: "pending",
      checks,
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
      pending: [],
      failed,
      successful: checks.filter((check) =>
        SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
      ),
    };
  }

  return {
    overall: "success",
    checks,
    pending: [],
    failed: [],
    successful: checks.filter((check) =>
      SUCCESSFUL_CONCLUSIONS.has(check.conclusion),
    ),
  };
}
