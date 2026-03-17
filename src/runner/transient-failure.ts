import type {
  RateLimitBucket,
  RateLimits,
  TransientFailureSignal,
} from "../domain/transient-failure.js";
import type { RunUpdateEvent } from "../domain/run.js";
import { getMapKey, mapPath } from "../domain/codex-payload.js";

export function extractRateLimitsSnapshot(
  update: RunUpdateEvent,
): RateLimits | null {
  if (
    update.event !== "account/rateLimits/updated" &&
    update.event !== "codex/event/account/rateLimits/updated"
  ) {
    return null;
  }
  const payload =
    update.payload !== null &&
    typeof update.payload === "object" &&
    !Array.isArray(update.payload)
      ? (update.payload as Record<string, unknown>)
      : null;
  if (payload === null) {
    return null;
  }

  const limitPayload =
    asRecord(getMapKey(payload, ["rateLimits", "rate_limits"])) ??
    asRecord(mapPath(payload, ["params", "rateLimits"])) ??
    asRecord(mapPath(payload, ["params", "rate_limits"])) ??
    asRecord(mapPath(payload, ["params", "msg", "payload", "rateLimits"])) ??
    asRecord(mapPath(payload, ["params", "msg", "payload", "rate_limits"])) ??
    payload;

  return {
    limitId: readString(limitPayload, ["limitId", "limit_id"]),
    primary: parseBucket(
      asRecord(getMapKey(limitPayload, ["primary"])) ??
        asRecord(mapPath(limitPayload, ["primary"])),
    ),
    secondary: parseBucket(
      asRecord(getMapKey(limitPayload, ["secondary"])) ??
        asRecord(mapPath(limitPayload, ["secondary"])),
    ),
    credits: readString(limitPayload, ["credits", "creditBalance", "balance"]),
  };
}

export function extractTransientFailureSignal(
  update: RunUpdateEvent,
): TransientFailureSignal | null {
  const rateLimits = extractRateLimitsSnapshot(update);
  if (rateLimits !== null) {
    const resumeAt = deriveResumeAt(rateLimits, Date.parse(update.timestamp));
    if (resumeAt !== null) {
      return {
        retryClass: "provider-rate-limit",
        reason: "Provider rate-limit pressure is active.",
        observedAt: update.timestamp,
        resumeAt,
        rateLimits,
      };
    }
  }

  const message = extractErrorMessage(update.payload);
  if (message === null) {
    return null;
  }
  if (
    /\brate limit\b|\b429\b|\btoo many requests\b|\bthrottl(?:e|ed|ing)\b/iu.test(
      message,
    )
  ) {
    return {
      retryClass: "provider-rate-limit",
      reason: message,
      observedAt: update.timestamp,
      resumeAt: deriveResumeAt(rateLimits, Date.parse(update.timestamp)),
      rateLimits,
    };
  }
  if (
    /\binsufficient quota\b|\bquota exceeded\b|\bbilling\b|\bpayment required\b|\bcredit(?:s| balance)?\b|\bsubscription\b|\bauth(?:entication)?\b|\baccount (?:limit|restricted|disabled|issue)\b/iu.test(
      message,
    )
  ) {
    return {
      retryClass: "provider-account-pressure",
      reason: message,
      observedAt: update.timestamp,
      resumeAt: null,
      rateLimits,
    };
  }
  return null;
}

function deriveResumeAt(
  rateLimits: RateLimits | null,
  observedAt: number,
): number | null {
  const resetInMs = [
    rateLimits?.primary?.resetInMs,
    rateLimits?.secondary?.resetInMs,
  ]
    .filter((value): value is number => typeof value === "number" && value > 0)
    .sort((left, right) => right - left)[0];
  if (resetInMs === undefined) {
    return null;
  }
  return observedAt + resetInMs;
}

function parseBucket(
  bucket: Record<string, unknown> | null,
): RateLimitBucket | null {
  if (bucket === null) {
    return null;
  }
  const used = readNumber(bucket, ["used"]);
  const limit = readNumber(bucket, ["limit"]);
  const resetInMs = readNumber(bucket, ["resetInMs", "reset_in_ms"]);
  if (used === null || limit === null || resetInMs === null) {
    return null;
  }
  return { used, limit, resetInMs };
}

function extractErrorMessage(payload: unknown): string | null {
  return (
    readString(payload, ["message", "error", "reason"]) ??
    readString(mapPath(payload, ["params", "error"]) ?? payload, ["message"]) ??
    readString(mapPath(payload, ["params", "msg", "payload"]) ?? payload, [
      "message",
      "error",
      "reason",
    ]) ??
    readString(
      mapPath(payload, ["params", "msg", "payload", "error"]) ?? payload,
      ["message"],
    ) ??
    null
  );
}

function readString(value: unknown, keys: readonly string[]): string | null {
  const raw = getMapKey(value, keys);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function readNumber(value: unknown, keys: readonly string[]): number | null {
  const raw = getMapKey(value, keys);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
