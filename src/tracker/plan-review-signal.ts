export type PlanReviewSignal =
  | "plan-ready"
  | "changes-requested"
  | "approved"
  | "waived";

export function parsePlanReviewSignal(body: string): PlanReviewSignal | null {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.toLowerCase();
  if (
    normalized === "plan status: plan-ready" ||
    // Legacy human-authored marker; the trailing period is intentional.
    normalized === "plan ready for review."
  ) {
    return "plan-ready";
  }
  if (normalized === "plan review: changes-requested") {
    return "changes-requested";
  }
  if (normalized === "plan review: approved") {
    return "approved";
  }
  if (normalized === "plan review: waived") {
    return "waived";
  }

  return null;
}
