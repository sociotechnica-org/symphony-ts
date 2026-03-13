/**
 * Shared helpers for traversing untyped Codex JSON payloads.
 *
 * Both running-entry.ts (token extraction) and tui.ts (display formatting)
 * need to navigate the same Codex protocol payloads with snake_case /
 * camelCase key tolerance. This module is the single canonical implementation.
 */

/**
 * Look up a key in a record, trying the exact key first, then camelCase,
 * then snake_case variants. Uses Object.hasOwn so an explicit `null` value
 * is distinguishable from a missing key.
 */
export function getKey(obj: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(obj, key)) return obj[key];
  const camel = key.replace(/_([a-z])/g, (_, c: string) =>
    (c as string).toUpperCase(),
  );
  if (camel !== key && Object.hasOwn(obj, camel)) return obj[camel];
  const snake = key.replace(/([A-Z])/g, "_$1").toLowerCase();
  if (snake !== key && Object.hasOwn(obj, snake)) return obj[snake];
  return undefined;
}

/**
 * Look up the first non-null, non-undefined value for any of the given keys.
 */
export function getMapKey(obj: unknown, keys: readonly string[]): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const val = getKey(record, key);
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

/**
 * Walk a dot-path through nested objects, applying key-variant tolerance
 * at each level.
 */
export function mapPath(obj: unknown, path: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = getKey(current as Record<string, unknown>, key);
  }
  return current;
}
