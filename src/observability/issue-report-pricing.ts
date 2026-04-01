import type {
  IssueReportDocument,
  IssueReportTokenUsage,
  IssueReportTokenUsageSession,
} from "./issue-report.js";
import { rollupIssueReportTokenUsageSessions } from "./issue-report-token-usage.js";

interface ProviderModelPricing {
  readonly provider: "openai";
  readonly modelIds: readonly string[];
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

interface EstimatedSessionCost {
  readonly costUsd: number | null;
  readonly notes: readonly string[];
}

// Standard text pricing from https://openai.com/api/pricing/ checked on
// 2026-03-31. Report pricing intentionally stays repo-owned and explicit.
const PROVIDER_MODEL_PRICING: readonly ProviderModelPricing[] = [
  {
    provider: "openai",
    modelIds: ["gpt-5.4"],
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
  {
    provider: "openai",
    modelIds: ["gpt-5.4-mini", "gpt-5.4 mini"],
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  {
    provider: "openai",
    modelIds: ["gpt-5.4-nano", "gpt-5.4 nano"],
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25,
  },
];

export function applyIssueReportProviderPricing(
  report: IssueReportDocument,
): IssueReportDocument {
  const pricedSessions = report.tokenUsage.sessions.map((session) =>
    applySessionPricing(session),
  );
  if (
    pricedSessions.every(
      (session, index) => session === report.tokenUsage.sessions[index],
    )
  ) {
    return report;
  }
  const rollup = rollupIssueReportTokenUsageSessions(
    pricedSessions,
    report.tokenUsage.attempts.map((attempt) => attempt.attemptNumber),
  );
  const estimatedCount = rollup.counts.estimated;
  const completeCount = rollup.counts.complete;
  const partialCount = rollup.counts.partial;
  const unavailableCount = rollup.counts.unavailable;

  const tokenUsage: IssueReportTokenUsage = {
    ...report.tokenUsage,
    status: rollup.status,
    explanation: buildPricingExplanation({
      sessionCount: pricedSessions.length,
      completeCount,
      estimatedCount,
      partialCount,
      unavailableCount,
      status: rollup.status,
    }),
    totalTokens: rollup.totalTokens,
    costUsd: rollup.costUsd,
    observedTokenSubtotal: rollup.observedTokenSubtotal,
    observedCostSubtotal: rollup.observedCostSubtotal,
    sessions: pricedSessions,
    attempts: rollup.attempts,
    agents: rollup.agents,
    notes: dedupeStrings([
      ...report.tokenUsage.notes,
      ...(estimatedCount === 0
        ? []
        : [
            `Checked-in provider pricing estimated cost for ${estimatedCount.toString()} of ${pricedSessions.length.toString()} recorded session(s).`,
          ]),
      ...(estimatedCount > 0 && completeCount > 0
        ? [
            `${completeCount.toString()} session(s) still supplied explicit backend cost facts; observed cost subtotal preserves only those explicit facts.`,
          ]
        : []),
      ...(unavailableCount === 0 && partialCount === 0
        ? []
        : [
            `Provider pricing still could not price ${(
              unavailableCount + partialCount
            ).toString()} of ${pricedSessions.length.toString()} recorded session(s). See session notes for the remaining gaps.`,
          ]),
    ]),
  };

  return {
    ...report,
    tokenUsage,
  };
}

function applySessionPricing(
  session: IssueReportTokenUsageSession,
): IssueReportTokenUsageSession {
  if (session.costUsd !== null || session.totalTokens === null) {
    return session;
  }

  const estimated = estimateSessionCost(session);
  if (estimated === null) {
    return session;
  }
  if (estimated.costUsd === null) {
    return {
      ...session,
      notes: dedupeStrings([...session.notes, ...estimated.notes]),
    };
  }

  return {
    ...session,
    status: "estimated",
    costUsd: estimated.costUsd,
    notes: dedupeStrings([...session.notes, ...estimated.notes]),
  };
}

function estimateSessionCost(
  session: IssueReportTokenUsageSession,
): EstimatedSessionCost | null {
  const pricing = resolveProviderModelPricing(session);
  if (pricing === null) {
    const provider = normalizePricingProvider(session);
    return provider === null || session.model === null
      ? null
      : {
          costUsd: null,
          notes: [
            `Checked-in provider pricing does not yet support ${renderProviderModelLabel(session)}.`,
          ],
        };
  }
  if (
    session.inputTokens === null ||
    session.outputTokens === null ||
    session.totalTokens === null
  ) {
    return {
      costUsd: null,
      notes: [
        `Provider pricing could not be applied because ${renderProviderModelLabel(session)} did not preserve complete input, output, and total token facts.`,
      ],
    };
  }

  const cachedInputTokens = session.cachedInputTokens ?? 0;
  if (cachedInputTokens > session.inputTokens) {
    return {
      costUsd: null,
      notes: [
        `Provider pricing could not be applied because cached input tokens exceeded total input tokens for ${renderProviderModelLabel(session)}.`,
      ],
    };
  }

  const billableInputTokens = session.inputTokens - cachedInputTokens;
  const costUsd = roundUsd(
    (billableInputTokens * pricing.inputUsdPerMillion) / 1_000_000 +
      (cachedInputTokens * pricing.cachedInputUsdPerMillion) / 1_000_000 +
      (session.outputTokens * pricing.outputUsdPerMillion) / 1_000_000,
  );

  return {
    costUsd,
    notes: [
      `Cost estimated from checked-in ${pricing.provider} pricing for ${session.model ?? "an unknown model"}.`,
      ...(session.cachedInputTokens === null
        ? [
            "Cached input token detail was unavailable, so provider pricing treated cached input usage as zero.",
          ]
        : []),
    ],
  };
}

function resolveProviderModelPricing(
  session: IssueReportTokenUsageSession,
): ProviderModelPricing | null {
  const provider = normalizePricingProvider(session);
  const modelId = normalizeModelId(session.model);
  if (provider === null || modelId === null) {
    return null;
  }

  return (
    PROVIDER_MODEL_PRICING.find((candidate) =>
      candidate.modelIds.some((value) => normalizeModelId(value) === modelId),
    ) ?? null
  );
}

function normalizePricingProvider(
  session: IssueReportTokenUsageSession,
): ProviderModelPricing["provider"] | null {
  if (session.modelProvider !== null) {
    const normalized = session.modelProvider.trim().toLowerCase();
    return normalized === "openai" ? "openai" : null;
  }
  if (session.provider === "codex") {
    return "openai";
  }
  return null;
}

function normalizeModelId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
  return normalized.length === 0 ? null : normalized;
}

function buildPricingExplanation(input: {
  readonly sessionCount: number;
  readonly completeCount: number;
  readonly estimatedCount: number;
  readonly partialCount: number;
  readonly unavailableCount: number;
  readonly status: IssueReportTokenUsage["status"];
}): string {
  if (input.status === "complete") {
    return `Canonical runner-event accounting supplied complete token and cost totals for all ${input.sessionCount.toString()} session(s).`;
  }
  if (input.status === "estimated") {
    return `All ${input.sessionCount.toString()} session(s) supplied token totals; ${input.estimatedCount.toString()} session(s) used checked-in provider pricing estimates and ${input.completeCount.toString()} session(s) supplied explicit backend cost facts.`;
  }
  if (input.status === "partial") {
    return `Token accounting was complete for ${input.completeCount.toString()} of ${input.sessionCount.toString()} session(s); ${[
      input.estimatedCount > 0
        ? `${input.estimatedCount.toString()} were provider-estimated`
        : null,
      input.partialCount > 0
        ? `${input.partialCount.toString()} remained partial`
        : null,
      input.unavailableCount > 0
        ? `${input.unavailableCount.toString()} remained unavailable`
        : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ")}.`;
  }
  return "Canonical runner-event accounting was unavailable for all recorded sessions.";
}

function renderProviderModelLabel(
  session: IssueReportTokenUsageSession,
): string {
  return session.model === null
    ? session.provider
    : `${session.provider} (${session.model})`;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
