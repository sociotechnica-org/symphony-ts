import type { RunUpdateEvent } from "../domain/run.js";

export function parseRunUpdateEvent(
  payload: unknown,
): RunUpdateEvent | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return undefined;
  }

  const obj = payload as Record<string, unknown>;
  const payloadType = extractPayloadType(obj);
  const event =
    typeof obj["event"] === "string"
      ? obj["event"]
      : payloadType !== undefined
        ? `codex/event/${payloadType}`
        : typeof obj["method"] === "string"
          ? (obj["method"] as string)
          : "unknown";

  return { event, payload, timestamp: new Date().toISOString() };
}

function extractPayloadType(obj: Record<string, unknown>): string | undefined {
  if (obj["type"] === "event_msg") {
    const payload = asRecord(obj["payload"]);
    const type = payload?.["type"];
    return typeof type === "string" ? type : undefined;
  }

  const params = asRecord(obj["params"]);
  const msg = asRecord(params?.["msg"]);
  const payload = asRecord(msg?.["payload"]);
  const type = payload?.["type"];
  return typeof type === "string" ? type : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
