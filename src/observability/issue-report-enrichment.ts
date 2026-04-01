import { formatErrorMessage } from "../domain/error-format.js";
import type {
  IssueReportDocument,
  IssueReportTokenUsage,
  IssueReportTokenUsageSession,
  LoadedIssueArtifacts,
} from "./issue-report.js";
import { rollupIssueReportTokenUsageSessions } from "./issue-report-token-usage.js";

const CANONICAL_SESSION_SOURCE_ARTIFACT_COUNT = 1;

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
  const baseSessionsById = new Map(
    base.sessions.map((session) => [session.sessionId, session]),
  );
  const enrichedSessionCount = sessions.filter(
    (session) => session.status !== "unavailable",
  ).length;
  const rollup = rollupIssueReportTokenUsageSessions(
    sessions,
    base.attempts.map((attempt) => attempt.attemptNumber),
  );
  const completeSessionCount = rollup.counts.complete;
  const tokenTotalSessionCount = sessions.filter(
    (session) => session.totalTokens !== null,
  ).length;
  const newlyFilledTokenTotals = sessions.filter((session) => {
    const previous = baseSessionsById.get(session.sessionId);
    return previous?.totalTokens === null && session.totalTokens !== null;
  }).length;
  const anySessionDetail = enrichedSessionCount > 0;
  const allSessionTotalsAvailable =
    sessions.length > 0 && tokenTotalSessionCount === sessions.length;
  const someSessionTotalsAvailable =
    tokenTotalSessionCount > 0 && !allSessionTotalsAvailable;
  const costAvailableSessionCount = sessions.filter(
    (session) => session.costUsd !== null,
  ).length;
  const allSessionCostsAvailable =
    sessions.length > 0 && costAvailableSessionCount === sessions.length;
  const someSessionCostsAvailable =
    costAvailableSessionCount > 0 && !allSessionCostsAvailable;
  const costExplanation = allSessionCostsAvailable
    ? `Canonical runner-event accounting already supplied cost totals for all ${sessions.length.toString()} session(s).`
    : someSessionCostsAvailable
      ? `Canonical runner-event accounting supplied cost totals for ${costAvailableSessionCount.toString()} of ${sessions.length.toString()} session(s); aggregate cost remained partial or unavailable.`
      : "Estimated cost remains unavailable because report generation does not apply provider pricing.";

  const status =
    newlyFilledTokenTotals === 0 && base.status !== "unavailable"
      ? base.status
      : completeSessionCount === sessions.length && sessions.length > 0
        ? "complete"
        : someSessionTotalsAvailable
          ? "partial"
          : anySessionDetail
            ? "partial"
            : base.status;
  const explanation =
    newlyFilledTokenTotals === 0 && base.status !== "unavailable"
      ? base.explanation
      : allSessionTotalsAvailable
        ? `Runner log enrichment supplied token totals for all ${sessions.length.toString()} session(s). ${costExplanation}`
        : someSessionTotalsAvailable
          ? `Runner log enrichment supplied token totals for ${tokenTotalSessionCount.toString()} of ${sessions.length.toString()} session(s). Remaining sessions stayed partial or unavailable. ${costExplanation}`
          : anySessionDetail
            ? "Runner log enrichment supplied optional session detail, but token totals remained partial or unavailable."
            : base.explanation;

  return {
    ...base,
    status,
    explanation,
    totalTokens: rollup.totalTokens,
    costUsd: base.costUsd,
    sessions,
    attempts: rollup.attempts,
    agents: rollup.agents,
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
  if (session.totalTokens !== null && session.costUsd !== null) {
    return "complete";
  }
  if (
    session.inputTokens !== null ||
    session.outputTokens !== null ||
    session.totalTokens !== null ||
    session.costUsd !== null ||
    session.originator !== null ||
    session.sessionSource !== null ||
    session.finalSummary !== null ||
    session.modelProvider !== null ||
    session.cliVersion !== null ||
    session.gitBranch !== null ||
    session.gitCommit !== null ||
    hasRunnerEnrichmentSourceArtifacts(session)
  ) {
    return "partial";
  }
  return "unavailable";
}

function hasRunnerEnrichmentSourceArtifacts(
  session: IssueReportTokenUsageSession,
): boolean {
  // Canonical sessions always start with one source artifact: the session
  // snapshot JSON. Anything beyond that came from optional enrichment.
  return (
    session.sourceArtifacts.length > CANONICAL_SESSION_SOURCE_ARTIFACT_COUNT
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
