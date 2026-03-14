export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}
