export interface ActiveRunShutdownContext {
  requestedAt: string | null;
  gracefulDeadlineAt: string | null;
  writePromise: Promise<void>;
}
