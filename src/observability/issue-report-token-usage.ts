import { sumIfAnyPresent, sumIfAllPresent } from "../runner/accounting.js";
import type {
  IssueReportTokenUsageAgent,
  IssueReportTokenUsageAttempt,
  IssueReportTokenUsageSession,
  IssueReportTokenUsageStatus,
} from "./issue-report.js";

export interface IssueReportTokenUsageRollup {
  readonly attempts: readonly IssueReportTokenUsageAttempt[];
  readonly agents: readonly IssueReportTokenUsageAgent[];
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly observedTokenSubtotal: number | null;
  readonly observedCostSubtotal: number | null;
  readonly counts: Readonly<Record<IssueReportTokenUsageStatus, number>>;
  readonly status: IssueReportTokenUsageStatus;
}

export function rollupIssueReportTokenUsageSessions(
  sessions: readonly IssueReportTokenUsageSession[],
  attemptNumbers: readonly number[],
): IssueReportTokenUsageRollup {
  const attempts = attemptNumbers.map((attemptNumber) => {
    const attemptSessions = sessions.filter(
      (session) => session.attemptNumber === attemptNumber,
    );
    return {
      attemptNumber,
      sessionIds: attemptSessions.map((session) => session.sessionId),
      totalTokens: sumIfAllPresent(
        attemptSessions.map((session) => session.totalTokens),
      ),
      costUsd: sumIfAllPresent(
        attemptSessions.map((session) => session.costUsd),
      ),
    };
  });
  const agents = aggregateAgents(sessions);
  const totalTokens = sumIfAllPresent(
    sessions.map((session) => session.totalTokens),
  );
  const costUsd = sumIfAllPresent(sessions.map((session) => session.costUsd));
  const observedTokenSubtotal = sumIfAnyPresent(
    sessions.map((session) => session.totalTokens),
  );
  const observedCostSubtotal = sumIfAnyPresent(
    sessions.map((session) =>
      session.status === "estimated" ? null : session.costUsd,
    ),
  );
  const counts: Record<IssueReportTokenUsageStatus, number> = {
    unavailable: 0,
    partial: 0,
    estimated: 0,
    complete: 0,
  };
  for (const session of sessions) {
    counts[session.status] += 1;
  }

  return {
    attempts,
    agents,
    totalTokens,
    costUsd,
    observedTokenSubtotal,
    observedCostSubtotal,
    counts,
    status: deriveAggregateStatus(sessions.length, counts),
  };
}

function aggregateAgents(
  sessions: readonly IssueReportTokenUsageSession[],
): readonly IssueReportTokenUsageAgent[] {
  const grouped = new Map<
    string,
    {
      readonly sessionCount: number;
      readonly totalTokens: number | null;
      readonly costUsd: number | null;
    }
  >();
  for (const session of sessions) {
    const label =
      session.model === null
        ? session.provider
        : `${session.provider} (${session.model})`;
    const existing = grouped.get(label) ?? {
      sessionCount: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    grouped.set(label, {
      sessionCount: existing.sessionCount + 1,
      totalTokens:
        existing.totalTokens === null || session.totalTokens === null
          ? null
          : existing.totalTokens + session.totalTokens,
      costUsd:
        existing.costUsd === null || session.costUsd === null
          ? null
          : existing.costUsd + session.costUsd,
    });
  }
  return [...grouped.entries()]
    .map(([agent, value]) => ({
      agent,
      sessionCount: value.sessionCount,
      totalTokens: value.totalTokens,
      costUsd: value.costUsd,
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));
}

function deriveAggregateStatus(
  sessionCount: number,
  counts: Readonly<Record<IssueReportTokenUsageStatus, number>>,
): IssueReportTokenUsageStatus {
  if (sessionCount === 0 || counts.unavailable === sessionCount) {
    return "unavailable";
  }
  if (counts.partial > 0 || counts.unavailable > 0) {
    return "partial";
  }
  if (counts.estimated > 0) {
    return "estimated";
  }
  return "complete";
}
