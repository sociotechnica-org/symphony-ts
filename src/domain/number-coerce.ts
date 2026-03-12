export function asFiniteNumber(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}
