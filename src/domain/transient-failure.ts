import type { RetryClass } from "./retry.js";

export interface RateLimitBucket {
  readonly used: number;
  readonly limit: number;
  readonly resetInMs: number;
}

export interface RateLimits {
  readonly limitId: string | null;
  readonly primary: RateLimitBucket | null;
  readonly secondary: RateLimitBucket | null;
  readonly credits: string | null;
}

export type DispatchPressureRetryClass = Extract<
  RetryClass,
  "provider-rate-limit" | "provider-account-pressure"
>;

export interface TransientFailureSignal {
  readonly retryClass: DispatchPressureRetryClass;
  readonly reason: string;
  readonly observedAt: string;
  readonly resumeAt: number | null;
  readonly rateLimits: RateLimits | null;
}

export interface DispatchPressureStateSnapshot {
  readonly retryClass: DispatchPressureRetryClass;
  readonly reason: string;
  readonly observedAt: string;
  readonly resumeAt: string;
}

export interface ClassifiedTransientFailure {
  readonly retryClass: RetryClass;
  readonly message: string;
  readonly dispatchPressure: DispatchPressureStateSnapshot | null;
}
