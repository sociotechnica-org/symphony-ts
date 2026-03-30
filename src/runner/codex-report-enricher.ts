import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "../domain/error-format.js";
import { asFiniteNumber } from "../domain/number-coerce.js";
import type { IssueArtifactSessionSnapshot } from "../observability/issue-artifacts.js";
import type {
  IssueReportEnricher,
  IssueReportEnricherInput,
  IssueReportEnrichment,
  IssueReportSessionEnrichment,
} from "../observability/issue-report-enrichment.js";

const MATCH_WINDOW_BEFORE_START_MS = 30 * 60 * 1000;
const MATCH_WINDOW_AFTER_FINISH_MS = 30 * 60 * 1000;
const MATCH_WINDOW_WITHOUT_FINISH_MS = 4 * 60 * 60 * 1000;

interface ParsedCodexSessionMeta {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly cwd: string | null;
  readonly originator: string | null;
  readonly source: string | null;
  readonly cliVersion: string | null;
  readonly modelProvider: string | null;
  readonly gitBranch: string | null;
  readonly gitCommit: string | null;
}

interface ParsedCodexSession {
  readonly filePath: string;
  readonly meta: ParsedCodexSessionMeta;
  readonly tokenUsage: {
    readonly inputTokens: number | null;
    readonly cachedInputTokens: number | null;
    readonly outputTokens: number | null;
    readonly reasoningOutputTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly finalSummary: string | null;
}

interface ResolvedCodexSessionMatch {
  readonly match: ParsedCodexSession | null;
  readonly note: string | null;
}

export interface CodexIssueReportEnricherOptions {
  readonly sessionsRoot?: string | undefined;
}

export class CodexIssueReportEnricher implements IssueReportEnricher {
  readonly id = "codex-jsonl";
  readonly #sessionsRoot: string;

  constructor(options?: CodexIssueReportEnricherOptions) {
    this.#sessionsRoot =
      options?.sessionsRoot ?? path.join(os.homedir(), ".codex", "sessions");
  }

  async enrich(
    input: IssueReportEnricherInput,
  ): Promise<IssueReportEnrichment> {
    const sessions = input.loaded.sessions.filter(
      (session) => session.provider === "codex",
    );

    if (sessions.length === 0) {
      return {};
    }

    const enrichments: IssueReportSessionEnrichment[] = [];
    for (const session of sessions) {
      try {
        const enrichment = await this.#enrichSession(session);
        if (enrichment !== null) {
          enrichments.push(enrichment);
        }
      } catch (error) {
        enrichments.push({
          sessionId: session.sessionId,
          notes: [
            `Runner log enrichment failed for this session and was skipped: ${formatErrorMessage(error)}`,
          ],
        });
      }
    }

    return enrichments.length > 0 ? { sessions: enrichments } : {};
  }

  async #enrichSession(
    session: IssueArtifactSessionSnapshot,
  ): Promise<IssueReportSessionEnrichment | null> {
    if (session.workspacePath === null) {
      return {
        sessionId: session.sessionId,
        notes: [
          "Runner log enrichment was skipped because the canonical session snapshot did not record a workspace path.",
        ],
      };
    }

    if (session.startedAt === null) {
      return {
        sessionId: session.sessionId,
        notes: [
          "Runner log enrichment was skipped because the canonical session snapshot did not record a start time.",
        ],
      };
    }

    const candidateFiles = await this.#findCandidateFiles(session);
    let sawParseFailure = false;
    const matches: ParsedCodexSession[] = [];

    for (const filePath of candidateFiles) {
      try {
        const parsed = await parseCodexSessionFile(filePath);
        if (matchesCodexSession(parsed.meta, session)) {
          matches.push(parsed);
        }
      } catch {
        sawParseFailure = true;
      }
    }

    if (matches.length === 0) {
      return {
        sessionId: session.sessionId,
        notes: [
          sawParseFailure
            ? "A runner log file in the matching time window could not be parsed, so enrichment was skipped."
            : "No matching runner log file was found for this session.",
        ],
      };
    }

    const resolvedMatch = resolveCodexSessionMatch(matches, session);
    if (resolvedMatch.match === null) {
      return {
        sessionId: session.sessionId,
        notes: [
          "Multiple runner log files matched this session, so enrichment was skipped to avoid guessing.",
        ],
      };
    }

    const matched = resolvedMatch.match;
    return {
      sessionId: session.sessionId,
      tokenUsage: matched.tokenUsage,
      originator: matched.meta.originator,
      sessionSource: matched.meta.source,
      cliVersion: matched.meta.cliVersion,
      modelProvider: matched.meta.modelProvider,
      gitBranch: matched.meta.gitBranch,
      gitCommit: matched.meta.gitCommit,
      finalSummary: matched.finalSummary,
      sourceArtifacts: [matched.filePath],
      notes: [
        ...(sawParseFailure
          ? [
              "At least one runner log file in the matching time window could not be parsed; enrichment used the only readable match.",
            ]
          : []),
        ...(resolvedMatch.note === null ? [] : [resolvedMatch.note]),
      ],
    };
  }

  async #findCandidateFiles(
    session: IssueArtifactSessionSnapshot,
  ): Promise<readonly string[]> {
    const dayRoots = deriveCandidateDayRoots(this.#sessionsRoot, session);
    const discovered: string[] = [];

    for (const dayRoot of dayRoots) {
      const entries = await fs
        .readdir(dayRoot, { withFileTypes: true })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          discovered.push(path.join(dayRoot, entry.name));
        }
      }
    }

    return discovered.sort((left, right) => left.localeCompare(right));
  }
}

export function createDefaultIssueReportEnrichers(): readonly IssueReportEnricher[] {
  return [new CodexIssueReportEnricher()];
}

async function parseCodexSessionFile(
  filePath: string,
): Promise<ParsedCodexSession> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let meta: ParsedCodexSessionMeta | null = null;
  let tokenUsage: ParsedCodexSession["tokenUsage"] = {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
  };
  let finalSummary: string | null = null;

  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["type"] === "session_meta") {
      meta = parseSessionMeta(parsed);
      continue;
    }
    if (parsed["type"] === "event_msg") {
      const usage = parseTokenCount(parsed);
      if (usage !== null) {
        // Codex emits cumulative totals in `info.total_token_usage`, so the
        // latest token_count snapshot is the full-session total for reporting.
        tokenUsage = usage;
      }
      continue;
    }
    if (parsed["type"] === "response_item") {
      const assistantText = parseAssistantOutputText(parsed);
      if (assistantText !== null) {
        finalSummary = assistantText;
      }
    }
  }

  if (meta === null) {
    throw new Error(`No Codex session metadata was found in ${filePath}`);
  }

  return {
    filePath,
    meta,
    tokenUsage,
    finalSummary,
  };
}

function parseSessionMeta(
  record: Record<string, unknown>,
): ParsedCodexSessionMeta {
  const payload = asRecord(record["payload"]);
  const git = asRecord(payload?.["git"]);

  return {
    id: asString(payload?.["id"]),
    timestamp:
      asString(payload?.["timestamp"]) ?? asString(record["timestamp"]),
    cwd: asString(payload?.["cwd"]),
    originator: asString(payload?.["originator"]),
    source: asString(payload?.["source"]),
    cliVersion: asString(payload?.["cli_version"]),
    modelProvider: asString(payload?.["model_provider"]),
    gitBranch: asString(git?.["branch"]),
    gitCommit: asString(git?.["commit_hash"]),
  };
}

function parseTokenCount(
  record: Record<string, unknown>,
): ParsedCodexSession["tokenUsage"] | null {
  const payload = asRecord(record["payload"]);
  if (payload?.["type"] !== "token_count") {
    return null;
  }
  const info = asRecord(payload["info"]);
  const total = asRecord(info?.["total_token_usage"]);
  if (total === null) {
    return null;
  }
  return {
    inputTokens: asFiniteNumber(total["input_tokens"]),
    cachedInputTokens: asFiniteNumber(total["cached_input_tokens"]),
    outputTokens: asFiniteNumber(total["output_tokens"]),
    reasoningOutputTokens: asFiniteNumber(total["reasoning_output_tokens"]),
    totalTokens: asFiniteNumber(total["total_tokens"]),
  };
}

function parseAssistantOutputText(
  record: Record<string, unknown>,
): string | null {
  const payload = asRecord(record["payload"]);
  if (payload?.["type"] !== "message" || payload["role"] !== "assistant") {
    return null;
  }
  const content = payload["content"];
  if (!Array.isArray(content)) {
    return null;
  }

  const texts = content
    .map((item) => asRecord(item))
    .flatMap((item) => {
      if (item?.["type"] !== "output_text") {
        return [];
      }
      const text = asString(item["text"]);
      return text === null || text.trim().length === 0 ? [] : [text.trim()];
    });

  if (texts.length === 0) {
    return null;
  }

  return texts.join("\n\n");
}

function matchesCodexSession(
  meta: ParsedCodexSessionMeta,
  session: IssueArtifactSessionSnapshot,
): boolean {
  if (meta.cwd === null) {
    return false;
  }
  if (session.workspacePath === null) {
    return false;
  }
  if (path.resolve(meta.cwd) !== path.resolve(session.workspacePath)) {
    return false;
  }
  if (
    session.branch !== null &&
    meta.gitBranch !== null &&
    session.branch !== meta.gitBranch
  ) {
    return false;
  }

  const sessionStart = parseTimestamp(session.startedAt);
  const sessionFinish =
    parseTimestamp(session.finishedAt) ??
    (sessionStart === null
      ? null
      : sessionStart + MATCH_WINDOW_WITHOUT_FINISH_MS);
  const metaTimestamp = parseTimestamp(meta.timestamp);
  if (sessionStart !== null) {
    if (metaTimestamp === null) {
      return false;
    }
    const lowerBound = sessionStart - MATCH_WINDOW_BEFORE_START_MS;
    const upperBound =
      (sessionFinish ?? sessionStart + MATCH_WINDOW_WITHOUT_FINISH_MS) +
      MATCH_WINDOW_AFTER_FINISH_MS;
    if (metaTimestamp < lowerBound || metaTimestamp > upperBound) {
      return false;
    }
  }

  return true;
}

function resolveCodexSessionMatch(
  matches: readonly ParsedCodexSession[],
  session: IssueArtifactSessionSnapshot,
): ResolvedCodexSessionMatch {
  if (matches.length === 0) {
    return {
      match: null,
      note: null,
    };
  }
  if (matches.length === 1) {
    return {
      match: matches[0] ?? null,
      note: null,
    };
  }

  const backendIdMatches = matches.filter((candidate) =>
    matchesCanonicalBackendId(candidate.meta.id, session),
  );
  if (backendIdMatches.length === 1) {
    return {
      match: backendIdMatches[0] ?? null,
      note: "Runner log enrichment disambiguated multiple Codex logs by matching the canonical backend session identity.",
    };
  }

  return {
    match: null,
    note: null,
  };
}

function matchesCanonicalBackendId(
  metaId: string | null,
  session: IssueArtifactSessionSnapshot,
): boolean {
  if (metaId === null) {
    return false;
  }
  return (
    metaId === session.backendSessionId || metaId === session.backendThreadId
  );
}

function deriveCandidateDayRoots(
  sessionsRoot: string,
  session: IssueArtifactSessionSnapshot,
): readonly string[] {
  const startedAt = parseTimestamp(session.startedAt);
  const finishedAt = parseTimestamp(session.finishedAt);
  const unfinishedUpperBound =
    startedAt === null
      ? null
      : startedAt +
        MATCH_WINDOW_WITHOUT_FINISH_MS +
        MATCH_WINDOW_AFTER_FINISH_MS;
  const anchors = [
    startedAt,
    finishedAt,
    startedAt === null ? null : startedAt - 24 * 60 * 60 * 1000,
    finishedAt === null
      ? startedAt === null
        ? null
        : unfinishedUpperBound
      : null,
    finishedAt === null ? null : finishedAt + 24 * 60 * 60 * 1000,
  ].filter((value): value is number => value !== null);

  return [
    ...new Set(
      anchors.map((value) => path.join(sessionsRoot, formatDatePath(value))),
    ),
  ];
}

function formatDatePath(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return path.join(year, month, day);
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
