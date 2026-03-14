import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type FactoryRuntimeIdentitySource =
  | "git"
  | "git-unavailable"
  | "not-a-git-checkout"
  | "git-error";

export interface FactoryRuntimeIdentity {
  readonly checkoutPath: string;
  readonly headSha: string | null;
  readonly committedAt: string | null;
  readonly isDirty: boolean | null;
  readonly source: FactoryRuntimeIdentitySource;
  readonly detail: string | null;
}

export interface RuntimeIdentityCollectorDeps {
  readonly execFile?: typeof execFile;
}

export async function collectFactoryRuntimeIdentity(
  checkoutPath: string,
  deps: RuntimeIdentityCollectorDeps = {},
): Promise<FactoryRuntimeIdentity> {
  const resolvedCheckoutPath = path.resolve(checkoutPath);
  const execGit = deps.execFile ?? execFile;

  let headSha: string;
  try {
    const result = await execGit("git", ["rev-parse", "HEAD"], {
      cwd: resolvedCheckoutPath,
    });
    headSha = result.stdout.trim();
  } catch (error) {
    return buildUnavailableIdentity(resolvedCheckoutPath, error);
  }

  let committedAt: string | null = null;
  let isDirty: boolean | null = null;
  const detailParts: string[] = [];

  try {
    const result = await execGit(
      "git",
      ["show", "-s", "--format=%cI", "HEAD"],
      {
        cwd: resolvedCheckoutPath,
      },
    );
    committedAt = normalizeOptionalText(result.stdout);
  } catch (error) {
    detailParts.push(
      `commit timestamp unavailable: ${normalizeGitErrorMessage(error)}`,
    );
  }

  try {
    const result = await execGit(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      {
        cwd: resolvedCheckoutPath,
      },
    );
    isDirty = result.stdout.trim().length > 0;
  } catch (error) {
    detailParts.push(
      `dirty state unavailable: ${normalizeGitErrorMessage(error)}`,
    );
  }

  return {
    checkoutPath: resolvedCheckoutPath,
    headSha,
    committedAt,
    isDirty,
    source: "git",
    detail: detailParts.length === 0 ? null : detailParts.join("; "),
  };
}

export function renderFactoryRuntimeIdentity(
  identity: FactoryRuntimeIdentity | null | undefined,
): string {
  if (identity === null || identity === undefined) {
    return "unavailable";
  }
  if (identity.headSha === null) {
    const reason =
      identity.detail === null
        ? identity.source
        : `${identity.source}: ${identity.detail}`;
    return `unavailable (${reason})`;
  }

  const parts = [identity.headSha];
  if (identity.committedAt !== null) {
    parts.push(`committed ${identity.committedAt}`);
  }
  if (identity.isDirty === true) {
    parts.push("dirty");
  } else if (identity.isDirty === false) {
    parts.push("clean");
  }
  if (identity.detail !== null) {
    parts.push(identity.detail);
  }
  return parts.join(" | ");
}

export function factoryRuntimeIdentityLogFields(
  identity: FactoryRuntimeIdentity | null | undefined,
): Record<string, unknown> {
  if (identity === null || identity === undefined) {
    return {
      runtimeCheckoutPath: null,
      runtimeHeadSha: null,
      runtimeCommittedAt: null,
      runtimeIsDirty: null,
      runtimeIdentitySource: null,
      runtimeIdentityDetail: null,
    };
  }
  return {
    runtimeCheckoutPath: identity.checkoutPath,
    runtimeHeadSha: identity.headSha,
    runtimeCommittedAt: identity.committedAt,
    runtimeIsDirty: identity.isDirty,
    runtimeIdentitySource: identity.source,
    runtimeIdentityDetail: identity.detail,
  };
}

export function parseFactoryRuntimeIdentity(
  value: unknown,
  filePath: string,
  field: string,
): FactoryRuntimeIdentity | null {
  if (value === null || value === undefined) {
    return null;
  }
  const identity = expectObject(value, filePath, field);
  return {
    checkoutPath: expectString(
      identity.checkoutPath,
      filePath,
      `${field}.checkoutPath`,
    ),
    headSha: expectNullableString(
      identity.headSha,
      filePath,
      `${field}.headSha`,
    ),
    committedAt: expectNullableString(
      identity.committedAt,
      filePath,
      `${field}.committedAt`,
    ),
    isDirty: expectNullableBoolean(
      identity.isDirty,
      filePath,
      `${field}.isDirty`,
    ),
    source: expectEnum(
      identity.source,
      ["git", "git-unavailable", "not-a-git-checkout", "git-error"],
      filePath,
      `${field}.source`,
    ),
    detail: expectNullableString(identity.detail, filePath, `${field}.detail`),
  };
}

function buildUnavailableIdentity(
  checkoutPath: string,
  error: unknown,
): FactoryRuntimeIdentity {
  const normalized = classifyGitError(error);
  return {
    checkoutPath,
    headSha: null,
    committedAt: null,
    isDirty: null,
    source: normalized.source,
    detail: normalized.detail,
  };
}

function classifyGitError(error: unknown): {
  readonly source: FactoryRuntimeIdentitySource;
  readonly detail: string;
} {
  const err = error as {
    readonly code?: string;
    readonly stderr?: string;
    readonly stdout?: string;
    readonly message?: string;
  };
  if (err.code === "ENOENT") {
    return {
      source: "git-unavailable",
      detail: "git executable is not available",
    };
  }
  const detail = normalizeGitErrorMessage(error);
  if (/not a git repository/i.test(detail)) {
    return {
      source: "not-a-git-checkout",
      detail,
    };
  }
  return {
    source: "git-error",
    detail,
  };
}

function normalizeGitErrorMessage(error: unknown): string {
  const err = error as {
    readonly stderr?: string;
    readonly stdout?: string;
    readonly message?: string;
  };
  const text =
    normalizeOptionalText(err.stderr) ??
    normalizeOptionalText(err.stdout) ??
    (error instanceof Error ? error.message : String(error));
  return text.length === 0 ? "unknown git error" : text;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function expectObject(
  value: unknown,
  filePath: string,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Expected object for ${field} in runtime identity snapshot ${filePath}.`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected string for ${field} in runtime identity snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectNullableString(
  value: unknown,
  filePath: string,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Expected string or null for ${field} in runtime identity snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectNullableBoolean(
  value: unknown,
  filePath: string,
  field: string,
): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `Expected boolean or null for ${field} in runtime identity snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  filePath: string,
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `Expected ${allowed.join(" | ")} for ${field} in runtime identity snapshot ${filePath}.`,
    );
  }
  return value as T;
}
