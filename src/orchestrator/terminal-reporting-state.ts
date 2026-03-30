export interface TerminalIssueReportingRuntimeState {
  readonly queuedIssueNumbers: Set<number>;
  readonly retryDueAtMsByIssueNumber: Map<number, number>;
  readonly retryAttemptCountByIssueNumber: Map<number, number>;
  backlogScanned: boolean;
}

export function createTerminalIssueReportingRuntimeState(): TerminalIssueReportingRuntimeState {
  return {
    queuedIssueNumbers: new Set<number>(),
    retryDueAtMsByIssueNumber: new Map<number, number>(),
    retryAttemptCountByIssueNumber: new Map<number, number>(),
    backlogScanned: false,
  };
}

export function clearTerminalIssueReportingState(
  state: TerminalIssueReportingRuntimeState,
  issueNumber: number,
): void {
  state.queuedIssueNumbers.delete(issueNumber);
  state.retryDueAtMsByIssueNumber.delete(issueNumber);
  state.retryAttemptCountByIssueNumber.delete(issueNumber);
}

export function enqueueTerminalIssueReporting(
  state: TerminalIssueReportingRuntimeState,
  issueNumber: number,
): void {
  state.queuedIssueNumbers.add(issueNumber);
}

export function isTerminalIssueReportingDue(
  state: TerminalIssueReportingRuntimeState,
  issueNumber: number,
  now = Date.now(),
): boolean {
  const dueAt = state.retryDueAtMsByIssueNumber.get(issueNumber);
  return dueAt === undefined || dueAt <= now;
}

export function seedTerminalIssueReportingBackoff(
  state: TerminalIssueReportingRuntimeState,
  options: {
    readonly issueNumber: number;
    readonly updatedAt: string;
    readonly baseBackoffMs: number;
    readonly now?: number;
  },
): void {
  const now = options.now ?? Date.now();
  const updatedAtMs = Date.parse(options.updatedAt);
  const dueAt =
    Number.isFinite(updatedAtMs) && options.baseBackoffMs > 0
      ? updatedAtMs + options.baseBackoffMs
      : now;
  state.retryAttemptCountByIssueNumber.set(options.issueNumber, 1);
  state.retryDueAtMsByIssueNumber.set(options.issueNumber, dueAt);
  state.queuedIssueNumbers.add(options.issueNumber);
}

export function scheduleTerminalIssueReportingRetry(
  state: TerminalIssueReportingRuntimeState,
  options: {
    readonly issueNumber: number;
    readonly now?: number;
    readonly baseBackoffMs: number;
    readonly maxBackoffMs: number;
  },
): number {
  const now = options.now ?? Date.now();
  const nextAttempt =
    (state.retryAttemptCountByIssueNumber.get(options.issueNumber) ?? 0) + 1;
  const delayMs =
    options.baseBackoffMs <= 0
      ? 0
      : Math.min(
          options.baseBackoffMs * 2 ** Math.max(0, nextAttempt - 1),
          options.maxBackoffMs,
        );
  const dueAt = now + delayMs;
  state.retryAttemptCountByIssueNumber.set(options.issueNumber, nextAttempt);
  state.retryDueAtMsByIssueNumber.set(options.issueNumber, dueAt);
  state.queuedIssueNumbers.add(options.issueNumber);
  return dueAt;
}
