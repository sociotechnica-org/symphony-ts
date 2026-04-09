import { ConfigError } from "../domain/errors.js";
import type {
  GitHubCompatibleTrackerConfig,
  GitHubReviewerAppConfig,
} from "../domain/workflow.js";
import {
  requireBoolean,
  requireGitHubRepo,
  requireString,
  requireStringArray,
} from "./workflow-validation.js";
import {
  resolveGitHubQueuePriorityConfig,
  resolvePlanReviewProtocol,
} from "./workflow-tracker-shared.js";

const SUPPORTED_GITHUB_REVIEWER_APP_KEYS = ["devin"] as const;

type SupportedGitHubReviewerAppKey =
  (typeof SUPPORTED_GITHUB_REVIEWER_APP_KEYS)[number];

function resolveGitHubReviewerApps(
  value: unknown,
): readonly GitHubReviewerAppConfig[] {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for tracker.reviewer_apps");
  }

  const reviewerApps: GitHubReviewerAppConfig[] = [];
  for (const [key, rawConfig] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      !SUPPORTED_GITHUB_REVIEWER_APP_KEYS.includes(
        key as SupportedGitHubReviewerAppKey,
      )
    ) {
      throw new ConfigError(
        `Unsupported tracker.reviewer_apps key '${key}'. Supported reviewer apps: ${SUPPORTED_GITHUB_REVIEWER_APP_KEYS.join(", ")}`,
      );
    }
    if (
      rawConfig === null ||
      typeof rawConfig !== "object" ||
      Array.isArray(rawConfig)
    ) {
      throw new ConfigError(`Expected object for tracker.reviewer_apps.${key}`);
    }

    const appConfig = rawConfig as Record<string, unknown>;
    const accepted =
      appConfig["accepted"] === undefined
        ? true
        : requireBoolean(
            appConfig["accepted"],
            `tracker.reviewer_apps.${key}.accepted`,
          );
    const required =
      appConfig["required"] === undefined
        ? false
        : requireBoolean(
            appConfig["required"],
            `tracker.reviewer_apps.${key}.required`,
          );

    if (!accepted && !required) {
      throw new ConfigError(
        `tracker.reviewer_apps.${key} must enable accepted, required, or both`,
      );
    }
    if (required && !accepted) {
      throw new ConfigError(
        `tracker.reviewer_apps.${key}.required cannot be true when accepted is false`,
      );
    }

    reviewerApps.push({
      key,
      accepted,
      required,
    });
  }

  return reviewerApps;
}

export function resolveGitHubTrackerConfig<
  TKind extends GitHubCompatibleTrackerConfig["kind"],
>(
  kind: TKind,
  tracker: Readonly<Record<string, unknown>>,
): Extract<GitHubCompatibleTrackerConfig, { readonly kind: TKind }> {
  return {
    kind,
    repo: requireGitHubRepo(tracker["repo"]),
    apiUrl: requireString(tracker["api_url"], "tracker.api_url"),
    readyLabel: requireString(tracker["ready_label"], "tracker.ready_label"),
    runningLabel: requireString(
      tracker["running_label"],
      "tracker.running_label",
    ),
    failedLabel: requireString(tracker["failed_label"], "tracker.failed_label"),
    respectBlockedRelationships:
      tracker["respect_blocked_relationships"] === undefined
        ? false
        : requireBoolean(
            tracker["respect_blocked_relationships"],
            "tracker.respect_blocked_relationships",
          ),
    successComment: requireString(
      tracker["success_comment"],
      "tracker.success_comment",
    ),
    reviewBotLogins:
      tracker["review_bot_logins"] === undefined
        ? []
        : requireStringArray(
            tracker["review_bot_logins"],
            "tracker.review_bot_logins",
          ),
    approvedReviewBotLogins:
      tracker["approved_review_bot_logins"] === undefined
        ? []
        : requireStringArray(
            tracker["approved_review_bot_logins"],
            "tracker.approved_review_bot_logins",
          ),
    reviewerApps: resolveGitHubReviewerApps(tracker["reviewer_apps"]),
    queuePriority: resolveGitHubQueuePriorityConfig(
      tracker["queue_priority"],
      "tracker.queue_priority",
    ),
    planReview: resolvePlanReviewProtocol(
      tracker["plan_review"],
      "tracker.plan_review",
    ),
  } as Extract<GitHubCompatibleTrackerConfig, { readonly kind: TKind }>;
}
