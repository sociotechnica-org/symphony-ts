import {
  DEFAULT_PLAN_REVIEW_PROTOCOL,
  type PlanReviewProtocol,
  type PlanReviewSignal,
} from "../domain/plan-review.js";

function normalizeMarker(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePlanReviewSignal(
  body: string,
  protocol: PlanReviewProtocol = DEFAULT_PLAN_REVIEW_PROTOCOL,
): PlanReviewSignal | null {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (!firstLine) {
    return null;
  }

  const normalized = normalizeMarker(firstLine);
  const planReadySignals = [
    protocol.planReadySignal,
    ...protocol.legacyPlanReadySignals,
  ].map(normalizeMarker);
  if (planReadySignals.includes(normalized)) {
    return "plan-ready";
  }
  if (normalized === normalizeMarker(protocol.changesRequestedSignal)) {
    return "changes-requested";
  }
  if (normalized === normalizeMarker(protocol.approvedSignal)) {
    return "approved";
  }
  if (normalized === normalizeMarker(protocol.waivedSignal)) {
    return "waived";
  }

  return null;
}
