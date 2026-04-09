import { ConfigError } from "../domain/errors.js";

// Internal validation helpers for the workflow/config subsystem.
// External callers should stay on the public `src/config/workflow.ts` entrypoint.

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Expected non-empty string for ${field}`);
  }
  return value.trim();
}

export function requireGitHubRepo(value: unknown): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ConfigError(
      `tracker.repo must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new ConfigError(
      "tracker.repo is not set; provide it in WORKFLOW.md or set the SYMPHONY_REPO environment variable",
    );
  }
  return value.trim();
}

export function requireUrlString(value: unknown, field: string): string {
  const resolved = requireString(value, field);
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new ConfigError(`${field} must be a valid URL, got '${resolved}'`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `${field} must use https:// or http://, got '${resolved}'`,
    );
  }
  return resolved;
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Expected number for ${field}`);
  }
  return value;
}

export function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Expected integer for ${field}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`Expected integer for ${field}`);
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`Expected boolean for ${field}`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new ConfigError(
      `${field} must be one of ${options.map((option) => `'${option}'`).join(", ")}`,
    );
  }
  return value as T;
}

export function coerceOptionalObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  // Omitted top-level sections keep the legacy "{}" parsing path, but an
  // explicit YAML null is treated as malformed boundary input and fails early.
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }
  return value as Record<string, unknown>;
}

export function requireOptionalString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function requireStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`Expected string array for ${field}`);
  }
  return value;
}

export function requireNonEmptyStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  const items = requireStringArray(value, field);
  if (items.length === 0) {
    throw new ConfigError(`Expected non-empty string array for ${field}`);
  }
  return items;
}

export function requireNumberRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, number>> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }

  const record: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (key.trim() === "") {
      throw new ConfigError(`Expected non-empty string key for ${field}`);
    }
    record[key] = requireInteger(rawValue, `${field}.${key}`);
  }
  return record;
}

function normalizeSecretValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveEnvReferenceName(value: string): string | null {
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/u);
  return match?.[1] ?? null;
}

export function resolveEnvBackedSecret(
  value: unknown,
  field: string,
  fallbackEnvName: string,
): string | null {
  if (value === undefined || value === null) {
    return normalizeSecretValue(process.env[fallbackEnvName]);
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }

  const trimmed = value.trim();
  const referencedEnvName = resolveEnvReferenceName(trimmed);
  if (referencedEnvName === null) {
    return normalizeSecretValue(trimmed);
  }

  // Match the Elixir config seam: an unset explicit env reference falls back
  // to the default env var for this field instead of failing immediately.
  const referencedValue = process.env[referencedEnvName];
  if (referencedValue === undefined) {
    return normalizeSecretValue(process.env[fallbackEnvName]);
  }

  return normalizeSecretValue(referencedValue);
}

export function resolveOptionalEnvBackedSecret(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }

  const trimmed = value.trim();
  const referencedEnvName = resolveEnvReferenceName(trimmed);
  if (referencedEnvName === null) {
    return normalizeSecretValue(trimmed);
  }

  return normalizeSecretValue(process.env[referencedEnvName]);
}
