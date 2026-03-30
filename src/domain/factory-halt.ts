import fs from "node:fs/promises";
import path from "node:path";
import {
  coerceRuntimeInstancePaths,
  type RuntimeInstanceInput,
} from "./workflow.js";

const HALT_RECORD_VERSION = 1;

export interface FactoryHaltRecord {
  readonly version: 1;
  readonly reason: string;
  readonly haltedAt: string;
  readonly source: string | null;
  readonly actor: string | null;
}

export interface FactoryHaltSnapshot {
  readonly state: "clear" | "halted" | "degraded";
  readonly reason: string | null;
  readonly haltedAt: string | null;
  readonly source: string | null;
  readonly actor: string | null;
  readonly detail: string | null;
}

interface FactoryHaltIo {
  readonly readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  readonly writeFile?: (
    filePath: string,
    content: string,
    encoding: "utf8",
  ) => Promise<void>;
  readonly rename?: (fromPath: string, toPath: string) => Promise<void>;
  readonly removeFile?: (filePath: string) => Promise<void>;
  readonly ensureDirectory?: (directoryPath: string) => Promise<void>;
}

export function deriveFactoryHaltFilePath(instance: RuntimeInstanceInput): string {
  return path.join(
    coerceRuntimeInstancePaths(instance).factoryArtifactsRoot,
    "halt-state.json",
  );
}

export async function inspectFactoryHalt(
  instance: RuntimeInstanceInput,
  io: FactoryHaltIo = {},
): Promise<FactoryHaltSnapshot> {
  const readFile = io.readFile ?? defaultReadFile;
  const filePath = deriveFactoryHaltFilePath(instance);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        state: "clear",
        reason: null,
        haltedAt: null,
        source: null,
        actor: null,
        detail: null,
      };
    }
    return {
      state: "degraded",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: `Failed to read halt state at ${filePath}: ${(error as Error).message}`,
    };
  }

  try {
    const record = parseFactoryHaltRecord(raw, filePath);
    return {
      state: "halted",
      reason: record.reason,
      haltedAt: record.haltedAt,
      source: record.source,
      actor: record.actor,
      detail: null,
    };
  } catch (error) {
    return {
      state: "degraded",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: (error as Error).message,
    };
  }
}

export async function writeFactoryHaltRecord(
  instance: RuntimeInstanceInput,
  input: {
    readonly reason: string;
    readonly haltedAt?: string;
    readonly source?: string | null;
    readonly actor?: string | null;
  },
  io: FactoryHaltIo = {},
): Promise<FactoryHaltRecord> {
  const writeFile = io.writeFile ?? defaultWriteFile;
  const rename = io.rename ?? defaultRename;
  const ensureDirectory = io.ensureDirectory ?? defaultEnsureDirectory;
  const filePath = deriveFactoryHaltFilePath(instance);
  const directory = path.dirname(filePath);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("Factory halt reason must not be empty.");
  }
  const record: FactoryHaltRecord = {
    version: HALT_RECORD_VERSION,
    reason,
    haltedAt: input.haltedAt ?? new Date().toISOString(),
    source: normalizeOptionalString(input.source),
    actor: normalizeOptionalString(input.actor),
  };
  const temporaryPath = path.join(
    directory,
    `.halt-state.${process.pid.toString()}.tmp`,
  );
  await ensureDirectory(directory);
  await writeFile(
    temporaryPath,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await (io.removeFile ?? defaultRemoveFile)(temporaryPath).catch(
      () => undefined,
    );
    throw error;
  }
  return record;
}

export async function clearFactoryHaltRecord(
  instance: RuntimeInstanceInput,
  io: FactoryHaltIo = {},
): Promise<void> {
  const removeFile = io.removeFile ?? defaultRemoveFile;
  await removeFile(deriveFactoryHaltFilePath(instance)).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  });
}

export function parseFactoryHaltRecord(
  raw: string,
  filePath: string,
): FactoryHaltRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse factory halt state at ${filePath}: ${(error as Error).message}`,
    );
  }
  return validateFactoryHaltRecord(parsed, filePath);
}

function validateFactoryHaltRecord(
  value: unknown,
  filePath: string,
): FactoryHaltRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid factory halt state at ${filePath}: expected a JSON object`,
    );
  }

  const record = value as Record<string, unknown>;
  if (record.version !== HALT_RECORD_VERSION) {
    throw new Error(
      `Invalid factory halt state at ${filePath}: expected version ${HALT_RECORD_VERSION}`,
    );
  }

  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    throw new Error(
      `Invalid factory halt state at ${filePath}: expected a non-empty reason`,
    );
  }
  if (typeof record.haltedAt !== "string" || record.haltedAt.length === 0) {
    throw new Error(
      `Invalid factory halt state at ${filePath}: expected haltedAt to be a non-empty string`,
    );
  }

  return {
    version: HALT_RECORD_VERSION,
    reason: record.reason.trim(),
    haltedAt: record.haltedAt,
    source: expectOptionalString(record.source, filePath, "source"),
    actor: expectOptionalString(record.actor, filePath, "actor"),
  };
}

function expectOptionalString(
  value: unknown,
  filePath: string,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid factory halt state at ${filePath}: expected ${field} to be a string or null`,
    );
  }
  return normalizeOptionalString(value);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

async function defaultReadFile(
  filePath: string,
  encoding: "utf8",
): Promise<string> {
  return fs.readFile(filePath, encoding);
}

async function defaultWriteFile(
  filePath: string,
  content: string,
  encoding: "utf8",
): Promise<void> {
  await fs.writeFile(filePath, content, encoding);
}

async function defaultRename(fromPath: string, toPath: string): Promise<void> {
  await fs.rename(fromPath, toPath);
}

async function defaultRemoveFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function defaultEnsureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}
