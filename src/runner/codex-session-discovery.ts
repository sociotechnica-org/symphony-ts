import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODEX_SESSION_MATCH_WINDOW_MS = 10 * 60 * 1000;

export interface CodexSessionMatch {
  readonly id: string;
  readonly filePath: string;
  readonly timestampMs: number;
}

export async function findCodexSession(input: {
  readonly workspacePath: string;
  readonly branchName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}): Promise<CodexSessionMatch | null> {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const candidateRoots = deriveCandidateDayRoots(
    sessionsRoot,
    input.startedAt,
    input.finishedAt,
  );
  const matches: CodexSessionMatch[] = [];

  for (const root of candidateRoots) {
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(root, entry.name);
      const match = await parseCodexSessionMeta(filePath);
      if (match === null) {
        continue;
      }
      if (
        path.resolve(match.cwd) !== path.resolve(input.workspacePath) ||
        (match.branch !== null && match.branch !== input.branchName)
      ) {
        continue;
      }
      const metaTimestamp = Date.parse(match.timestamp);
      const sessionStart = Date.parse(input.startedAt);
      const sessionFinish = Date.parse(input.finishedAt);
      if (
        Number.isNaN(metaTimestamp) ||
        Number.isNaN(sessionStart) ||
        Number.isNaN(sessionFinish)
      ) {
        continue;
      }
      const lowerBound = sessionStart - CODEX_SESSION_MATCH_WINDOW_MS;
      const upperBound = sessionFinish + CODEX_SESSION_MATCH_WINDOW_MS;
      if (metaTimestamp < lowerBound || metaTimestamp > upperBound) {
        continue;
      }
      matches.push({
        id: match.id,
        filePath,
        timestampMs: metaTimestamp,
      });
    }
  }

  return (
    matches
      .sort((left, right) => {
        if (left.timestampMs !== right.timestampMs) {
          return left.timestampMs - right.timestampMs;
        }
        return left.filePath.localeCompare(right.filePath);
      })
      .at(-1) ?? null
  );
}

async function parseCodexSessionMeta(filePath: string): Promise<{
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly branch: string | null;
} | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record["type"] !== "session_meta") {
    return null;
  }
  const payload = asRecord(record["payload"]);
  const git = asRecord(payload?.["git"]);
  const id = asString(payload?.["id"]);
  const timestamp =
    asString(payload?.["timestamp"]) ?? asString(record["timestamp"]);
  const cwd = asString(payload?.["cwd"]);
  if (id === null || timestamp === null || cwd === null) {
    return null;
  }
  return {
    id,
    timestamp,
    cwd,
    branch: asString(git?.["branch"]),
  };
}

function deriveCandidateDayRoots(
  sessionsRoot: string,
  startedAt: string,
  finishedAt: string,
): readonly string[] {
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  const anchors = [
    startMs,
    finishMs,
    startMs - 24 * 60 * 60 * 1000,
    finishMs + 24 * 60 * 60 * 1000,
  ]
    .filter((value) => Number.isFinite(value))
    .map((value) => value as number);
  return [
    ...new Set(
      anchors.map((value) => path.join(sessionsRoot, formatDatePath(value))),
    ),
  ];
}

function formatDatePath(timestampMs: number): string {
  const date = new Date(timestampMs);
  return path.join(
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
