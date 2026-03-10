import { TrackerError } from "../domain/errors.js";

function formatValidationError(
  expectation: string,
  field: string,
  prefix?: string,
): string {
  if (prefix === undefined) {
    return `Expected ${expectation} for ${field}`;
  }
  return `${prefix}: expected ${expectation} for ${field}`;
}

export function requireObject(
  value: unknown,
  field: string,
  prefix?: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackerError(formatValidationError("object", field, prefix));
  }
  return value as Record<string, unknown>;
}

export function requireArray(
  value: unknown,
  field: string,
  prefix?: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TrackerError(formatValidationError("array", field, prefix));
  }
  return value;
}

export function requireBoolean(
  value: unknown,
  field: string,
  prefix?: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new TrackerError(formatValidationError("boolean", field, prefix));
  }
  return value;
}

export function requireString(
  value: unknown,
  field: string,
  prefix?: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TrackerError(
      formatValidationError("non-empty string", field, prefix),
    );
  }
  return value;
}

export function requireNumber(
  value: unknown,
  field: string,
  prefix?: string,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TrackerError(formatValidationError("number", field, prefix));
  }
  return value;
}

export function requireNullableString(
  value: unknown,
  field: string,
  prefix?: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TrackerError(
      formatValidationError("string or null", field, prefix),
    );
  }
  return value;
}
