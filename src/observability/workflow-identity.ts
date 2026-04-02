import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const FACTORY_WORKFLOW_IDENTITY_SOURCES = [
  "file",
  "missing",
  "read-error",
] as const;

export type FactoryWorkflowIdentitySource =
  (typeof FACTORY_WORKFLOW_IDENTITY_SOURCES)[number];

export interface FactoryWorkflowIdentity {
  readonly workflowPath: string;
  readonly contentHash: string | null;
  readonly source: FactoryWorkflowIdentitySource;
  readonly detail: string | null;
}

export async function collectFactoryWorkflowIdentity(
  workflowPath: string,
): Promise<FactoryWorkflowIdentity> {
  const resolvedWorkflowPath = path.resolve(workflowPath);

  try {
    const raw = await fs.readFile(resolvedWorkflowPath);
    return {
      workflowPath: resolvedWorkflowPath,
      contentHash: createHash("sha256").update(raw).digest("hex"),
      source: "file",
      detail: null,
    };
  } catch (error) {
    return buildUnavailableIdentity(resolvedWorkflowPath, error);
  }
}

export function renderFactoryWorkflowIdentity(
  identity: FactoryWorkflowIdentity | null | undefined,
): string {
  if (identity === null || identity === undefined) {
    return "unavailable";
  }
  if (identity.contentHash === null) {
    const reason =
      identity.detail === null
        ? identity.source
        : `${identity.source}: ${identity.detail}`;
    return `${identity.workflowPath} | unavailable (${reason})`;
  }

  return `${identity.workflowPath} | sha256 ${identity.contentHash}`;
}

export function factoryWorkflowIdentityLogFields(
  identity: FactoryWorkflowIdentity | null | undefined,
): Record<string, unknown> {
  if (identity === null || identity === undefined) {
    return {
      workflowPath: null,
      workflowContentHash: null,
      workflowIdentitySource: null,
      workflowIdentityDetail: null,
    };
  }

  return {
    workflowPath: identity.workflowPath,
    workflowContentHash: identity.contentHash,
    workflowIdentitySource: identity.source,
    workflowIdentityDetail: identity.detail,
  };
}

export function parseFactoryWorkflowIdentity(
  value: unknown,
  filePath: string,
  field: string,
): FactoryWorkflowIdentity | null {
  if (value === null || value === undefined) {
    return null;
  }

  const identity = expectObject(value, filePath, field);
  return {
    workflowPath: expectString(
      identity.workflowPath,
      filePath,
      `${field}.workflowPath`,
    ),
    contentHash: expectNullableString(
      identity.contentHash,
      filePath,
      `${field}.contentHash`,
    ),
    source: expectEnum(
      identity.source,
      FACTORY_WORKFLOW_IDENTITY_SOURCES,
      filePath,
      `${field}.source`,
    ),
    detail: expectNullableString(identity.detail, filePath, `${field}.detail`),
  };
}

function buildUnavailableIdentity(
  workflowPath: string,
  error: unknown,
): FactoryWorkflowIdentity {
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    return {
      workflowPath,
      contentHash: null,
      source: "missing",
      detail: "workflow file does not exist",
    };
  }

  return {
    workflowPath,
    contentHash: null,
    source: "read-error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function expectObject(
  value: unknown,
  filePath: string,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Expected object for ${field} in workflow identity snapshot ${filePath}.`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected string for ${field} in workflow identity snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectNullableString(
  value: unknown,
  filePath: string,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Expected string or null for ${field} in workflow identity snapshot ${filePath}.`,
    );
  }
  return value;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  filePath: string,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(
      `Expected one of ${allowed.join(", ")} for ${field} in workflow identity snapshot ${filePath}.`,
    );
  }
  return value as T[number];
}
