import type {
  IssueReportDocument,
  IssueReportTokenUsage,
  IssueReportTokenUsageSession,
  LoadedIssueArtifacts,
} from "./issue-report.js";

export interface IssueReportSessionTokenUsageEnrichment {
  readonly inputTokens?: number | null | undefined;
  readonly cachedInputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly reasoningOutputTokens?: number | null | undefined;
  readonly totalTokens?: number | null | undefined;
}

export interface IssueReportSessionEnrichment {
  readonly sessionId: string;
  readonly tokenUsage?: IssueReportSessionTokenUsageEnrichment | undefined;
  readonly originator?: string | null | undefined;
  readonly sessionSource?: string | null | undefined;
  readonly cliVersion?: string | null | undefined;
  readonly modelProvider?: string | null | undefined;
  readonly gitBranch?: string | null | undefined;
  readonly gitCommit?: string | null | undefined;
  readonly finalSummary?: string | null | undefined;
  readonly sourceArtifacts?: readonly string[] | undefined;
  readonly notes?: readonly string[] | undefined;
}

export interface IssueReportEnrichment {
  readonly notes?: readonly string[] | undefined;
  readonly sessions?: readonly IssueReportSessionEnrichment[] | undefined;
}

export interface IssueReportEnricherInput {
  readonly workspaceRoot: string;
  readonly loaded: LoadedIssueArtifacts;
  readonly report: IssueReportDocument;
}

export interface IssueReportEnricher {
  readonly id: string;
  enrich(input: IssueReportEnricherInput): Promise<IssueReportEnrichment>;
}

export async function applyIssueReportEnrichers(
  report: IssueReportDocument,
  input: Omit<IssueReportEnricherInput, "report">,
  enrichers: readonly IssueReportEnricher[],
): Promise<IssueReportDocument> {
  if (enrichers.length === 0) {
    return report;
  }

  let nextReport = report;
  for (const enricher of enrichers) {
    try {
      const enrichment = await enricher.enrich({
        ...input,
        report: nextReport,
      });
      nextReport = mergeIssueReportEnrichment(nextReport, enrichment);
    } catch (error) {
      nextReport = mergeIssueReportEnrichment(nextReport, {
        notes: [
          `A runner log enricher failed and its optional additions were skipped: ${formatErrorMessage(error)}`,
        ],
      });
    }
  }

  return nextReport;
}

export function mergeIssueReportEnrichment(
  report: IssueReportDocument,
  enrichment: IssueReportEnrichment,
): IssueReportDocument {
  if (
    (enrichment.notes === undefined || enrichment.notes.length === 0) &&
    (enrichment.sessions === undefined || enrichment.sessions.length === 0)
  ) {
    return report;
  }

  const enrichedSessions = report.tokenUsage.sessions.map((session) => {
    const matching = (enrichment.sessions ?? []).filter(
      (candidate) => candidate.sessionId === session.sessionId,
    );
    if (matching.length === 0) {
      return session;
    }

    let nextSession = session;
    for (const candidate of matching) {
      nextSession = mergeIssueReportSession(nextSession, candidate);
    }
    return nextSession;
  });

  const mergedTokenUsage = rebuildTokenUsage(
    report.tokenUsage,
    enrichedSessions,
    [...report.tokenUsage.notes, ...(enrichment.notes ?? [])],
  );

  return {
    ...report,
    tokenUsage: mergedTokenUsage,
  };
}

function mergeIssueReportSession(
  session: IssueReportTokenUsageSession,
  enrichment: IssueReportSessionEnrichment,
): IssueReportTokenUsageSession {
  const tokenUsage = enrichment.tokenUsage;
  const next: IssueReportTokenUsageSession = {
    ...session,
    inputTokens: tokenUsage?.inputTokens ?? session.inputTokens,
    cachedInputTokens:
      tokenUsage?.cachedInputTokens ?? session.cachedInputTokens,
    outputTokens: tokenUsage?.outputTokens ?? session.outputTokens,
    reasoningOutputTokens:
      tokenUsage?.reasoningOutputTokens ?? session.reasoningOutputTokens,
    totalTokens: tokenUsage?.totalTokens ?? session.totalTokens,
    originator: enrichment.originator ?? session.originator,
    sessionSource: enrichment.sessionSource ?? session.sessionSource,
    cliVersion: enrichment.cliVersion ?? session.cliVersion,
    modelProvider: enrichment.modelProvider ?? session.modelProvider,
    gitBranch: enrichment.gitBranch ?? session.gitBranch,
    gitCommit: enrichment.gitCommit ?? session.gitCommit,
    finalSummary: enrichment.finalSummary ?? session.finalSummary,
    sourceArtifacts: uniqueStrings([
      ...session.sourceArtifacts,
      ...(enrichment.sourceArtifacts ?? []),
    ]),
    notes: uniqueStrings([...session.notes, ...(enrichment.notes ?? [])]),
  };

  return {
    ...next,
    status: deriveSessionStatus(next),
  };
}

function rebuildTokenUsage(
  base: IssueReportTokenUsage,
  sessions: readonly IssueReportTokenUsageSession[],
  notes: readonly string[],
): IssueReportTokenUsage {
  const enrichedSessionCount = sessions.filter(
    (session) => session.status !== "unavailable",
  ).length;
  const completeSessionCount = sessions.filter(
    (session) => session.totalTokens !== null,
  ).length;
  const anySessionDetail = enrichedSessionCount > 0;
  const allSessionTotalsAvailable =
    sessions.length > 0 && completeSessionCount === sessions.length;
  const someSessionTotalsAvailable =
    completeSessionCount > 0 && !allSessionTotalsAvailable;

  const status = allSessionTotalsAvailable
    ? "complete"
    : someSessionTotalsAvailable
      ? "partial"
      : anySessionDetail
        ? "partial"
        : base.status;
  const explanation = allSessionTotalsAvailable
    ? `Runner log enrichment supplied token totals for all ${sessions.length.toString()} session(s). Estimated cost remains unavailable because report generation does not apply provider pricing.`
    : someSessionTotalsAvailable
      ? `Runner log enrichment supplied token totals for ${completeSessionCount.toString()} of ${sessions.length.toString()} session(s). Remaining sessions stayed partial or unavailable, and estimated cost remains unavailable because report generation does not apply provider pricing.`
      : anySessionDetail
        ? "Runner log enrichment supplied optional session detail, but token totals remained partial or unavailable."
        : base.explanation;

  const attempts = base.attempts.map((attempt) => {
    const attemptSessions = sessions.filter((session) =>
      attempt.sessionIds.includes(session.sessionId),
    );
    const totalTokens =
      attemptSessions.length > 0 &&
      attemptSessions.every((session) => session.totalTokens !== null)
        ? attemptSessions.reduce(
            (total, session) => total + (session.totalTokens ?? 0),
            0,
          )
        : null;
    return {
      ...attempt,
      totalTokens,
      costUsd: null,
    };
  });

  const agentsByName = new Map<
    string,
    {
      sessionCount: number;
      totalTokens: number;
      hasMissingTokens: boolean;
    }
  >();
  for (const session of sessions) {
    const label =
      session.model === null
        ? session.provider
        : `${session.provider} (${session.model})`;
    const existing = agentsByName.get(label) ?? {
      sessionCount: 0,
      totalTokens: 0,
      hasMissingTokens: false,
    };
    agentsByName.set(label, {
      sessionCount: existing.sessionCount + 1,
      totalTokens:
        session.totalTokens === null
          ? existing.totalTokens
          : existing.totalTokens + session.totalTokens,
      hasMissingTokens:
        existing.hasMissingTokens || session.totalTokens === null,
    });
  }

  const agents = [...agentsByName.entries()]
    .map(([agent, value]) => ({
      agent,
      sessionCount: value.sessionCount,
      totalTokens: value.hasMissingTokens ? null : value.totalTokens,
      costUsd: null,
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));

  const totalTokens =
    sessions.length > 0 &&
    sessions.every((session) => session.totalTokens !== null)
      ? sessions.reduce(
          (total, session) => total + (session.totalTokens ?? 0),
          0,
        )
      : null;

  return {
    ...base,
    status,
    explanation,
    totalTokens,
    costUsd: null,
    sessions,
    attempts,
    agents,
    rawArtifacts: uniqueStrings([
      ...base.rawArtifacts,
      ...sessions.flatMap((session) => session.sourceArtifacts),
    ]),
    notes: uniqueStrings(notes),
  };
}

function deriveSessionStatus(
  session: IssueReportTokenUsageSession,
): IssueReportTokenUsageSession["status"] {
  if (session.totalTokens !== null) {
    return "complete";
  }
  if (
    session.originator !== null ||
    session.sessionSource !== null ||
    session.finalSummary !== null ||
    session.modelProvider !== null ||
    session.cliVersion !== null ||
    session.gitBranch !== null ||
    session.gitCommit !== null ||
    session.sourceArtifacts.length > 1
  ) {
    return "partial";
  }
  return "unavailable";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
