export function normalizeGitHubLogin(login: string): string {
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]")
    ? normalized.slice(0, -"[bot]".length)
    : normalized;
}

export function createGitHubLoginSet(
  logins: readonly string[],
): ReadonlySet<string> {
  return new Set(logins.map(normalizeGitHubLogin));
}
