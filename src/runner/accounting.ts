export type RunnerAccountingStatus = "unavailable" | "partial" | "complete";

export interface RunnerAccountingSnapshot {
  readonly status: RunnerAccountingStatus;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export function createRunnerAccountingSnapshot(input?: {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly costUsd?: number | null;
}): RunnerAccountingSnapshot {
  const fields = {
    inputTokens: input?.inputTokens ?? null,
    outputTokens: input?.outputTokens ?? null,
    totalTokens: input?.totalTokens ?? null,
    costUsd: input?.costUsd ?? null,
  };
  return {
    ...fields,
    status: deriveRunnerAccountingStatus(fields),
  };
}

export function deriveRunnerAccountingStatus(input: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}): RunnerAccountingStatus {
  if (
    input.inputTokens === null &&
    input.outputTokens === null &&
    input.totalTokens === null &&
    input.costUsd === null
  ) {
    return "unavailable";
  }
  if (input.totalTokens !== null && input.costUsd !== null) {
    return "complete";
  }
  return "partial";
}

export function aggregateRunnerAccountingSnapshots(
  snapshots: readonly RunnerAccountingSnapshot[],
): RunnerAccountingSnapshot {
  if (snapshots.length === 0) {
    return createRunnerAccountingSnapshot();
  }

  const statuses = snapshots.map((snapshot) => snapshot.status);
  const allUnavailable = statuses.every((status) => status === "unavailable");
  const allComplete = statuses.every((status) => status === "complete");

  return {
    status: allUnavailable ? "unavailable" : allComplete ? "complete" : "partial",
    inputTokens: sumIfAllPresent(snapshots.map((snapshot) => snapshot.inputTokens)),
    outputTokens: sumIfAllPresent(
      snapshots.map((snapshot) => snapshot.outputTokens),
    ),
    totalTokens: sumIfAllPresent(snapshots.map((snapshot) => snapshot.totalTokens)),
    costUsd: sumIfAllPresent(snapshots.map((snapshot) => snapshot.costUsd)),
  };
}

export function sumIfAllPresent(
  values: readonly (number | null)[],
): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === values.length && observed.length > 0
    ? observed.reduce((sum, value) => sum + value, 0)
    : null;
}
