import type {
  DispatchPressureStateSnapshot,
  TransientFailureSignal,
} from "../domain/transient-failure.js";

export interface DispatchPressureRuntimeState {
  current: DispatchPressureStateSnapshot | null;
  readonly contributors: Map<number, DispatchPressureStateSnapshot>;
}

export function createDispatchPressureState(): DispatchPressureRuntimeState {
  return {
    current: null,
    contributors: new Map(),
  };
}

export function getActiveDispatchPressure(
  state: DispatchPressureRuntimeState,
  now = Date.now(),
): DispatchPressureStateSnapshot | null {
  const current = state.current;
  if (current === null) {
    return null;
  }
  return Date.parse(current.resumeAt) > now ? current : null;
}

export function activateDispatchPressure(
  state: DispatchPressureRuntimeState,
  issueNumber: number,
  signal: TransientFailureSignal,
): {
  readonly transition: "activated" | "extended";
  readonly pressure: DispatchPressureStateSnapshot;
} {
  const next = {
    retryClass: signal.retryClass,
    reason: signal.reason,
    observedAt: signal.observedAt,
    resumeAt: new Date(signal.resumeAt ?? Date.now()).toISOString(),
  } satisfies DispatchPressureStateSnapshot;
  const previous = state.current;
  state.contributors.set(issueNumber, next);
  const current = selectCurrentDispatchPressure(state);
  state.current = current;
  if (previous === null || current === null) {
    return {
      transition: "activated",
      pressure: current ?? next,
    };
  }
  return {
    transition: "extended",
    pressure: current,
  };
}

export function clearDispatchPressure(
  state: DispatchPressureRuntimeState,
  issueNumber?: number,
): void {
  if (issueNumber === undefined) {
    state.contributors.clear();
    state.current = null;
    return;
  }
  state.contributors.delete(issueNumber);
  state.current = selectCurrentDispatchPressure(state);
}

function selectCurrentDispatchPressure(
  state: DispatchPressureRuntimeState,
): DispatchPressureStateSnapshot | null {
  let current: DispatchPressureStateSnapshot | null = null;
  for (const pressure of state.contributors.values()) {
    if (
      current === null ||
      Date.parse(pressure.resumeAt) > Date.parse(current.resumeAt)
    ) {
      current = pressure;
    }
  }
  return current;
}
