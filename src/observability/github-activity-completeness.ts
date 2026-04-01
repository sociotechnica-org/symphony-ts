export type GitHubActivityAvailability =
  | "complete"
  | "partial"
  | "unavailable";

export function rollupGitHubActivityAvailability(
  statuses: readonly GitHubActivityAvailability[],
): GitHubActivityAvailability {
  if (statuses.length === 0 || statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }

  return statuses.every((status) => status === "complete")
    ? "complete"
    : "partial";
}

export function deriveGitHubActivityAvailability(
  statuses: readonly (GitHubActivityAvailability | null)[],
): GitHubActivityAvailability {
  return rollupGitHubActivityAvailability(
    statuses.filter(
      (status): status is GitHubActivityAvailability => status !== null,
    ),
  );
}
