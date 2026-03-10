import { TrackerError } from "../domain/errors.js";

export type LinearWorkpadStatus =
  | "running"
  | "retry-scheduled"
  | "failed"
  | "handoff-ready"
  | "completed";

export interface LinearWorkpadEntry {
  readonly status: LinearWorkpadStatus;
  readonly summary: string;
  readonly branchName: string | null;
  readonly updatedAt: string;
}

const WORKPAD_START = "<!-- symphony-linear-workpad:start -->";
const WORKPAD_END = "<!-- symphony-linear-workpad:end -->";

export function parseLinearWorkpad(
  description: string | null | undefined,
): LinearWorkpadEntry | null {
  const content = description ?? "";
  const start = content.indexOf(WORKPAD_START);
  const end = content.indexOf(WORKPAD_END);
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  const payload = content.slice(start + WORKPAD_START.length, end).trim();
  if (payload === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new TrackerError("Linear issue workpad contains invalid JSON", {
      cause: error as Error,
    });
  }

  return normalizeWorkpadEntry(parsed);
}

export function writeLinearWorkpad(
  description: string | null | undefined,
  entry: LinearWorkpadEntry,
): string {
  const base = stripLinearWorkpad(description).trimEnd();
  const block = [
    WORKPAD_START,
    JSON.stringify(entry, null, 2),
    WORKPAD_END,
  ].join("\n");

  if (base === "") {
    return `${block}\n`;
  }

  return `${base}\n\n${block}\n`;
}

function stripLinearWorkpad(description: string | null | undefined): string {
  const content = description ?? "";
  const start = content.indexOf(WORKPAD_START);
  const end = content.indexOf(WORKPAD_END);
  if (start < 0 || end < 0 || end <= start) {
    return content;
  }

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + WORKPAD_END.length).trimStart();

  if (before === "") {
    return after;
  }
  if (after === "") {
    return before;
  }
  return `${before}\n\n${after}`;
}

function normalizeWorkpadEntry(value: unknown): LinearWorkpadEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackerError("Linear issue workpad must be an object");
  }
  const record = value as Record<string, unknown>;

  const status = requireStatus(record["status"]);
  const summary = requireString(record["summary"], "summary");
  const updatedAt = requireString(record["updatedAt"], "updatedAt");
  const branchName = requireOptionalString(record["branchName"], "branchName");

  return {
    status,
    summary,
    updatedAt,
    branchName,
  };
}

function requireStatus(value: unknown): LinearWorkpadStatus {
  if (
    value === "running" ||
    value === "retry-scheduled" ||
    value === "failed" ||
    value === "handoff-ready" ||
    value === "completed"
  ) {
    return value;
  }
  throw new TrackerError(
    `Unsupported Linear workpad status '${String(value)}'`,
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TrackerError(`Linear issue workpad requires ${field}`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TrackerError(
      `Linear issue workpad field ${field} must be a string`,
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
