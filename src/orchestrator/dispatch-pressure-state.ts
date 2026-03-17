import type {
  DispatchPressureStateSnapshot,
  TransientFailureSignal,
} from "../domain/transient-failure.js";

export interface DispatchPressureRuntimeState {
  current: DispatchPressureStateSnapshot | null;
}

export function createDispatchPressureState(): DispatchPressureRuntimeState {
  return {
    current: null,
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
  const current = state.current;
  if (current === null) {
    state.current = next;
    return {
      transition: "activated",
      pressure: next,
    };
  }

  const merged = {
    retryClass: next.retryClass,
    reason: next.reason,
    observedAt: next.observedAt,
    resumeAt:
      Date.parse(next.resumeAt) >= Date.parse(current.resumeAt)
        ? next.resumeAt
        : current.resumeAt,
  } satisfies DispatchPressureStateSnapshot;
  state.current = merged;
  return {
    transition: "extended",
    pressure: merged,
  };
}

export function clearDispatchPressure(
  state: DispatchPressureRuntimeState,
): void {
  state.current = null;
}
