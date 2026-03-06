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

export const REVIEW_THREADS_QUERY =
  "query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 20) { nodes { author { login } body path } } } } } } }";

export function normalizeChecks(statusCheckRollup) {
  return (statusCheckRollup ?? []).map((check) => ({
    name: check.name,
    status: check.status ?? "",
    conclusion: check.conclusion ?? "",
    detailsUrl: check.detailsUrl ?? "",
    workflowName: check.workflowName ?? "",
  }));
}

export function validateRepoName(repo) {
  if (repo === null || !repo.includes("/")) {
    throw new Error(`Repo must be in owner/name form, got: ${String(repo)}`);
  }

  return repo;
}

export function parseRepo(repo) {
  const validatedRepo = validateRepoName(repo);
  const [owner, name] = validatedRepo.split("/", 2);
  return { owner, name };
}

export function normalizeReviewThreads(reviewThreads) {
  return (reviewThreads ?? []).map((thread) => ({
    id: thread.id ?? "",
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    comments: Array.isArray(thread.comments)
      ? thread.comments.map((comment) => ({
          authorLogin: comment.authorLogin ?? comment.author?.login ?? "",
          body: comment.body ?? "",
          path: comment.path ?? "",
        }))
      : (thread.comments?.nodes ?? []).map((comment) => ({
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

export async function resolveRepoName(repo, execFileAsync) {
  if (repo !== null) {
    return validateRepoName(repo);
  }

  const { stdout } = await execFileAsync("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);

  return validateRepoName(stdout.trim());
}

export async function fetchReviewThreads(
  pullRequestNumber,
  repo,
  execFileAsync,
) {
  const { owner, name } = parseRepo(repo);
  const { stdout } = await execFileAsync("gh", [
    "api",
    "graphql",
    "-f",
    REVIEW_THREADS_QUERY,
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${name}`,
    "-F",
    `number=${pullRequestNumber}`,
  ]);
  const result = JSON.parse(stdout);

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(
      `GraphQL error fetching review threads: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  return result.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}
