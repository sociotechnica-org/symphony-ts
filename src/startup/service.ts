import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSource } from "../domain/workspace.js";
import {
  coerceRuntimeInstancePaths,
  getConfigInstancePaths,
  type ResolvedConfig,
  type RuntimeInstanceInput,
} from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import {
  collectFactoryRuntimeIdentity,
  factoryRuntimeIdentityLogFields,
  parseFactoryRuntimeIdentity,
  type FactoryRuntimeIdentity,
} from "../observability/runtime-identity.js";
import { isAbortError } from "../support/abort.js";
import { GitHubMirrorStartupPreparer } from "./github-mirror.js";

let startupWriteSequence = 0;

export type StartupState = "preparing" | "ready" | "failed";

export interface StartupSnapshot {
  readonly version: 1;
  readonly state: StartupState;
  readonly updatedAt: string;
  readonly workerPid: number;
  readonly provider: string;
  readonly summary: string | null;
  readonly runtimeIdentity?: FactoryRuntimeIdentity | null;
}

export interface StartupPreparationSuccess {
  readonly kind: "ready";
  readonly summary: string | null;
  readonly workspaceSourceOverride?: WorkspaceSource | null;
}

export interface StartupPreparationFailure {
  readonly kind: "failed";
  readonly summary: string;
}

export type StartupPreparationResult =
  | StartupPreparationSuccess
  | StartupPreparationFailure;

export interface StartupPreparer {
  readonly id: string;
  prepare(context: {
    readonly config: ResolvedConfig;
    readonly logger: Logger;
    readonly signal?: AbortSignal | undefined;
  }): Promise<StartupPreparationResult>;
}

export interface StartupPreparationOutcomeReady {
  readonly kind: "ready";
  readonly provider: string;
  readonly summary: string | null;
  readonly workspaceSourceOverride: WorkspaceSource | null;
  readonly artifactPath: string;
  readonly runtimeIdentity: FactoryRuntimeIdentity;
}

export interface StartupPreparationOutcomeFailed {
  readonly kind: "failed";
  readonly provider: string;
  readonly summary: string;
  readonly workspaceSourceOverride: null;
  readonly artifactPath: string;
  readonly runtimeIdentity: FactoryRuntimeIdentity;
}

export type StartupPreparationOutcome =
  | StartupPreparationOutcomeReady
  | StartupPreparationOutcomeFailed;

class NoOpStartupPreparer implements StartupPreparer {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  prepare(): Promise<StartupPreparationSuccess> {
    return Promise.resolve({
      kind: "ready",
      summary: "No startup preparation is required for this runtime.",
    });
  }
}

export function deriveStartupFilePath(instance: RuntimeInstanceInput): string {
  return coerceRuntimeInstancePaths(instance).startupFilePath;
}

export async function writeStartupSnapshot(
  filePath: string,
  snapshot: StartupSnapshot,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.startup.${process.pid.toString()}.${startupWriteSequence.toString()}.tmp`,
  );
  startupWriteSequence += 1;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readStartupSnapshot(
  filePath: string,
): Promise<StartupSnapshot> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseStartupSnapshotContent(raw, filePath);
}

export function parseStartupSnapshotContent(
  raw: string,
  filePath: string,
): StartupSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse startup snapshot at ${filePath}.`, {
      cause: error as Error,
    });
  }
  return parseStartupSnapshot(parsed, filePath);
}

export function createStartupPreparer(config: ResolvedConfig): StartupPreparer {
  switch (config.tracker.kind) {
    case "github":
    case "github-bootstrap":
      return new GitHubMirrorStartupPreparer();
    case "linear":
      return new NoOpStartupPreparer("linear/noop");
    default:
      return exhaustiveTrackerKind(config.tracker);
  }
}

export async function runStartupPreparation(options: {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly preparer?: StartupPreparer;
  readonly workerPid?: number;
}): Promise<StartupPreparationOutcome> {
  const preparer = options.preparer ?? createStartupPreparer(options.config);
  const instance = getConfigInstancePaths(options.config);
  const workerPid = options.workerPid ?? process.pid;
  const artifactPath = deriveStartupFilePath(instance);
  // The running process cwd identifies the code checkout that launched the
  // current worker. This may differ from the repository that owns WORKFLOW.md
  // when one shared engine checkout targets a separate project-local instance.
  const runtimeIdentity = await collectFactoryRuntimeIdentity(process.cwd());

  options.logger.info("Startup preparation started", {
    provider: preparer.id,
    startupFilePath: artifactPath,
    ...factoryRuntimeIdentityLogFields(runtimeIdentity),
  });
  await writeStartupSnapshot(artifactPath, {
    version: 1,
    state: "preparing",
    updatedAt: new Date().toISOString(),
    workerPid,
    provider: preparer.id,
    summary: "Startup preparation is in progress.",
    runtimeIdentity,
  });

  try {
    const result = await preparer.prepare({
      config: options.config,
      logger: options.logger,
      signal: options.signal,
    });
    if (result.kind === "failed") {
      await writeStartupSnapshot(artifactPath, {
        version: 1,
        state: "failed",
        updatedAt: new Date().toISOString(),
        workerPid,
        provider: preparer.id,
        summary: result.summary,
        runtimeIdentity,
      });
      options.logger.error("Startup preparation failed", {
        provider: preparer.id,
        startupFilePath: artifactPath,
        summary: result.summary,
        ...factoryRuntimeIdentityLogFields(runtimeIdentity),
      });
      return {
        kind: "failed",
        provider: preparer.id,
        summary: result.summary,
        workspaceSourceOverride: null,
        artifactPath,
        runtimeIdentity,
      };
    }

    await writeStartupSnapshot(artifactPath, {
      version: 1,
      state: "ready",
      updatedAt: new Date().toISOString(),
      workerPid,
      provider: preparer.id,
      summary: result.summary ?? "Startup preparation completed.",
      runtimeIdentity,
    });
    options.logger.info("Startup preparation completed", {
      provider: preparer.id,
      startupFilePath: artifactPath,
      summary: result.summary ?? null,
      workspaceSourceOverride: result.workspaceSourceOverride ?? null,
      ...factoryRuntimeIdentityLogFields(runtimeIdentity),
    });
    return {
      kind: "ready",
      provider: preparer.id,
      summary: result.summary ?? null,
      workspaceSourceOverride: result.workspaceSourceOverride ?? null,
      artifactPath,
      runtimeIdentity,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const summary =
      error instanceof Error ? error.message : "Unknown startup failure";
    await writeStartupSnapshot(artifactPath, {
      version: 1,
      state: "failed",
      updatedAt: new Date().toISOString(),
      workerPid,
      provider: preparer.id,
      summary,
      runtimeIdentity,
    });
    options.logger.error("Startup preparation failed", {
      provider: preparer.id,
      startupFilePath: artifactPath,
      summary,
      ...factoryRuntimeIdentityLogFields(runtimeIdentity),
    });
    return {
      kind: "failed",
      provider: preparer.id,
      summary,
      workspaceSourceOverride: null,
      artifactPath,
      runtimeIdentity,
    };
  }
}

function parseStartupSnapshot(
  value: unknown,
  filePath: string,
): StartupSnapshot {
  const snapshot = expectObject(value, filePath);
  const version = expectInteger(snapshot["version"], filePath, "version");
  if (version !== 1) {
    throw new Error(
      `Unsupported startup snapshot version at ${filePath}: expected 1, received ${version.toString()}.`,
    );
  }

  const state = expectState(snapshot["state"], filePath, "state");
  return {
    version: 1,
    state,
    updatedAt: expectString(snapshot["updatedAt"], filePath, "updatedAt"),
    workerPid: expectInteger(snapshot["workerPid"], filePath, "workerPid"),
    provider: expectString(snapshot["provider"], filePath, "provider"),
    summary: expectOptionalString(snapshot["summary"], filePath, "summary"),
    runtimeIdentity: parseFactoryRuntimeIdentity(
      snapshot["runtimeIdentity"],
      filePath,
      "runtimeIdentity",
    ),
  };
}

function expectObject(
  value: unknown,
  filePath: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected startup snapshot object at ${filePath}.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected string for ${field} in startup snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectOptionalString(
  value: unknown,
  filePath: string,
  field: string,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Expected string or null for ${field} in startup snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectInteger(
  value: unknown,
  filePath: string,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    Number.isNaN(value)
  ) {
    throw new Error(
      `Expected integer for ${field} in startup snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectState(
  value: unknown,
  filePath: string,
  field: string,
): StartupState {
  if (value === "preparing" || value === "ready" || value === "failed") {
    return value;
  }
  throw new Error(
    `Expected startup state for ${field} in startup snapshot ${filePath}.`,
  );
}

function exhaustiveTrackerKind(value: never): never {
  throw new Error(`Unsupported tracker kind '${JSON.stringify(value)}'.`);
}
