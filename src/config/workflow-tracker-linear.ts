import { ConfigError } from "../domain/errors.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";
import {
  requireNonEmptyStringArray,
  requireOptionalString,
  requireUrlString,
  resolveEnvBackedSecret,
  resolveOptionalEnvBackedSecret,
} from "./workflow-validation.js";
import {
  resolvePlanReviewProtocol,
  resolveQueuePriorityConfig,
} from "./workflow-tracker-shared.js";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_LINEAR_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

export function resolveLinearTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): LinearTrackerConfig {
  const apiKey = resolveEnvBackedSecret(
    tracker["api_key"],
    "tracker.api_key",
    "LINEAR_API_KEY",
  );
  if (apiKey === null) {
    throw new ConfigError(
      "Linear tracker requires tracker.api_key or LINEAR_API_KEY",
    );
  }

  const projectSlug = requireOptionalString(
    tracker["project_slug"],
    "tracker.project_slug",
  );
  if (projectSlug === null) {
    throw new ConfigError("Linear tracker requires tracker.project_slug");
  }

  return {
    kind: "linear",
    endpoint:
      tracker["endpoint"] === undefined
        ? DEFAULT_LINEAR_ENDPOINT
        : requireUrlString(tracker["endpoint"], "tracker.endpoint"),
    apiKey,
    projectSlug,
    assignee: resolveOptionalEnvBackedSecret(
      tracker["assignee"],
      "tracker.assignee",
    ),
    activeStates:
      tracker["active_states"] === undefined
        ? DEFAULT_LINEAR_ACTIVE_STATES
        : requireNonEmptyStringArray(
            tracker["active_states"],
            "tracker.active_states",
          ),
    terminalStates:
      tracker["terminal_states"] === undefined
        ? DEFAULT_LINEAR_TERMINAL_STATES
        : requireNonEmptyStringArray(
            tracker["terminal_states"],
            "tracker.terminal_states",
          ),
    queuePriority: resolveQueuePriorityConfig(
      tracker["queue_priority"],
      "tracker.queue_priority",
    ),
    planReview: resolvePlanReviewProtocol(
      tracker["plan_review"],
      "tracker.plan_review",
    ),
  };
}
