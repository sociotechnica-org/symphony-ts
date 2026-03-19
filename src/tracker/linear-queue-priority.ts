import type { QueuePriority } from "../domain/issue.js";
import type { QueuePriorityConfig } from "../domain/workflow.js";

const LINEAR_QUEUE_PRIORITY_LABELS: Readonly<Record<number, string>> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

export function normalizeLinearQueuePriority(
  value: number | null,
  config: QueuePriorityConfig | undefined,
): QueuePriority | null {
  if (config?.enabled !== true || value === null) {
    return null;
  }

  const label = LINEAR_QUEUE_PRIORITY_LABELS[value];
  if (label === undefined) {
    return null;
  }

  return {
    rank: value,
    label,
  };
}
