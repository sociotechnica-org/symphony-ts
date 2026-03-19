import type { QueuePriority } from "../domain/issue.js";
import type { GitHubQueuePriorityConfig } from "../domain/workflow.js";

export type GitHubProjectFieldValue =
  | {
      readonly kind: "number";
      readonly value: number | null;
    }
  | {
      readonly kind: "single_select";
      readonly value: string | null;
    }
  | {
      readonly kind: "text";
      readonly value: string | null;
    }
  | {
      readonly kind: "unsupported";
    };

export function normalizeGitHubQueuePriority(
  value: GitHubProjectFieldValue | null,
  config: GitHubQueuePriorityConfig | undefined,
): QueuePriority | null {
  if (config?.enabled !== true || value === null) {
    return null;
  }

  switch (value.kind) {
    case "number":
      return normalizeNumericPriority(value.value);
    case "single_select":
    case "text":
      return normalizeMappedPriority(value.value, config.optionRankMap);
    case "unsupported":
      return null;
    default:
      return exhaustiveGitHubProjectFieldValue(value);
  }
}

function normalizeNumericPriority(value: number | null): QueuePriority | null {
  if (value === null || !Number.isSafeInteger(value)) {
    return null;
  }

  return {
    rank: value,
    label: value.toString(),
  };
}

function normalizeMappedPriority(
  value: string | null,
  optionRankMap: Readonly<Record<string, number>> | undefined,
): QueuePriority | null {
  if (value === null || value.trim() === "" || optionRankMap === undefined) {
    return null;
  }

  const rank = optionRankMap[value];
  if (rank === undefined || !Number.isSafeInteger(rank)) {
    return null;
  }

  return {
    rank,
    label: value,
  };
}

function exhaustiveGitHubProjectFieldValue(value: never): never {
  throw new Error(`Unsupported GitHub project field value: ${String(value)}`);
}
