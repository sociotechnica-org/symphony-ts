import { ConfigError } from "../domain/errors.js";
import type { PollingConfig, WatchdogConfig } from "../domain/workflow.js";
import { requireBoolean, requireNumber } from "./workflow-validation.js";

const DEFAULT_DISABLED_WATCHDOG_CONFIG: Omit<WatchdogConfig, "enabled"> = {
  checkIntervalMs: 60_000,
  stallThresholdMs: 300_000,
  executionStallThresholdMs: 300_000,
  prFollowThroughStallThresholdMs: 300_000,
  maxRecoveryAttempts: 2,
};

export function resolvePollingConfig(
  raw: Readonly<Record<string, unknown>>,
): PollingConfig {
  const resolved = {
    intervalMs: requireNumber(raw["interval_ms"], "polling.interval_ms"),
    maxConcurrentRuns: requireNumber(
      raw["max_concurrent_runs"],
      "polling.max_concurrent_runs",
    ),
    retry: resolveRetryConfig(raw["retry"]),
  };
  const watchdog = resolveWatchdogConfig(raw["watchdog"]);
  return watchdog === undefined ? resolved : { ...resolved, watchdog };
}

function resolveRetryConfig(value: unknown): {
  readonly maxAttempts: number;
  readonly backoffMs: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for polling.retry");
  }

  const retry = value as Record<string, unknown>;
  if (Object.hasOwn(retry, "max_follow_up_attempts")) {
    throw new ConfigError(
      "polling.retry.max_follow_up_attempts is no longer supported; review and rework continuation is now tracker-driven",
    );
  }
  return {
    maxAttempts: requireNumber(
      retry["max_attempts"],
      "polling.retry.max_attempts",
    ),
    backoffMs: requireNumber(retry["backoff_ms"], "polling.retry.backoff_ms"),
  };
}

function resolveWatchdogConfig(value: unknown): WatchdogConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for polling.watchdog");
  }

  const watchdog = value as Record<string, unknown>;
  const enabled =
    watchdog["enabled"] === undefined
      ? true
      : requireBoolean(watchdog["enabled"], "polling.watchdog.enabled");
  const checkIntervalMs = requireOptionalPositiveInteger(
    watchdog["check_interval_ms"],
    "polling.watchdog.check_interval_ms",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.checkIntervalMs,
  );
  const stallThresholdMs = requireOptionalPositiveInteger(
    watchdog["stall_threshold_ms"],
    "polling.watchdog.stall_threshold_ms",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.stallThresholdMs,
  );
  const executionStallThresholdMs = requireOptionalPositiveInteger(
    watchdog["execution_stall_threshold_ms"],
    "polling.watchdog.execution_stall_threshold_ms",
    stallThresholdMs,
  );
  const prFollowThroughStallThresholdMs = requireOptionalPositiveInteger(
    watchdog["pr_follow_through_stall_threshold_ms"],
    "polling.watchdog.pr_follow_through_stall_threshold_ms",
    stallThresholdMs,
  );
  const maxRecoveryAttempts = requireOptionalRecoveryAttempts(
    watchdog["max_recovery_attempts"],
    "polling.watchdog.max_recovery_attempts",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.maxRecoveryAttempts,
  );

  return {
    enabled,
    checkIntervalMs,
    stallThresholdMs,
    executionStallThresholdMs,
    prFollowThroughStallThresholdMs,
    maxRecoveryAttempts,
  };
}

function requireOptionalPositiveInteger(
  value: unknown,
  field: string,
  fallback: number | undefined,
): number {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new ConfigError(`Expected number for ${field}`);
    }
    return fallback;
  }

  const resolved = requireNumber(value, field);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ConfigError(`${field} must be an integer > 0`);
  }
  return resolved;
}

function requireOptionalRecoveryAttempts(
  value: unknown,
  field: string,
  fallback: number | undefined,
): number {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new ConfigError(`Expected number for ${field}`);
    }
    return fallback;
  }

  const resolved = requireNumber(value, field);
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new ConfigError(`${field} must be an integer >= 0`);
  }
  return resolved;
}
