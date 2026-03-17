import type {
  ClassifiedTransientFailure,
  TransientFailureSignal,
} from "../domain/transient-failure.js";
import {
  ACCOUNT_PRESSURE_PATTERNS,
  RATE_LIMIT_PATTERNS,
} from "../domain/transient-failure-patterns.js";

export function classifyTransientFailure(options: {
  readonly message: string;
  readonly signal: TransientFailureSignal | null;
  readonly observedAt?: string;
  readonly backoffMs: number;
}): ClassifiedTransientFailure {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const signal = options.signal;
  if (signal !== null) {
    return {
      retryClass: signal.retryClass,
      message: options.message,
      dispatchPressure: {
        retryClass: signal.retryClass,
        reason: signal.reason,
        observedAt: signal.observedAt,
        resumeAt: new Date(
          signal.resumeAt ?? Date.parse(observedAt) + options.backoffMs,
        ).toISOString(),
      },
    };
  }

  const retryClass = classifyMessage(options.message);
  if (
    retryClass === "provider-rate-limit" ||
    retryClass === "provider-account-pressure"
  ) {
    return {
      retryClass,
      message: options.message,
      dispatchPressure: {
        retryClass,
        reason: options.message,
        observedAt,
        resumeAt: new Date(
          Date.parse(observedAt) + options.backoffMs,
        ).toISOString(),
      },
    };
  }

  return {
    retryClass,
    message: options.message,
    dispatchPressure: null,
  };
}

function classifyMessage(
  message: string,
): ClassifiedTransientFailure["retryClass"] {
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "provider-rate-limit";
  }
  if (ACCOUNT_PRESSURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "provider-account-pressure";
  }
  return "run-failure";
}
