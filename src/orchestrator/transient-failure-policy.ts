import type {
  ClassifiedTransientFailure,
  TransientFailureSignal,
} from "../domain/transient-failure.js";

const RATE_LIMIT_PATTERNS = [
  /\brate limit\b/iu,
  /\b429\b/u,
  /\btoo many requests\b/iu,
  /\bthrottl(?:e|ed|ing)\b/iu,
] as const;

const ACCOUNT_PRESSURE_PATTERNS = [
  /\binsufficient quota\b/iu,
  /\bquota exceeded\b/iu,
  /\bbilling\b/iu,
  /\bpayment required\b/iu,
  /\bcredit(?:s| balance)?\b/iu,
  /\bsubscription\b/iu,
  /\bauth(?:entication)?\b/iu,
  /\baccount (?:limit|restricted|disabled|issue)\b/iu,
] as const;

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
