import { ConfigError } from "../domain/errors.js";
import {
  buildDefaultPlanReviewReplyGuidance,
  buildDefaultPlanReviewReplyTemplateBlock,
  DEFAULT_PLAN_REVIEW_METADATA_LABELS,
  DEFAULT_PLAN_REVIEW_PROTOCOL,
  type PlanReviewMetadataLabels,
  type PlanReviewProtocol,
} from "../domain/plan-review.js";
import type {
  GitHubQueuePriorityConfig,
  QueuePriorityConfig,
} from "../domain/workflow.js";
import {
  requireBoolean,
  requireInteger,
  requireNumberRecord,
  requireString,
  requireStringArray,
} from "./workflow-validation.js";

export function resolveQueuePriorityConfig(
  value: unknown,
  field: string,
): QueuePriorityConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }

  const config = value as Record<string, unknown>;
  return {
    enabled: requireBoolean(config["enabled"], `${field}.enabled`),
  };
}

export function resolveGitHubQueuePriorityConfig(
  value: unknown,
  field: string,
): GitHubQueuePriorityConfig | undefined {
  const config = resolveQueuePriorityConfig(value, field);
  if (config === undefined) {
    return undefined;
  }

  const rawConfig = value as Record<string, unknown>;
  if (!config.enabled) {
    return {
      enabled: false,
    };
  }

  return {
    enabled: true,
    projectNumber: requireInteger(
      rawConfig["project_number"],
      `${field}.project_number`,
    ),
    fieldName: requireString(rawConfig["field_name"], `${field}.field_name`),
    optionRankMap:
      rawConfig["option_rank_map"] === undefined
        ? undefined
        : requireNumberRecord(
            rawConfig["option_rank_map"],
            `${field}.option_rank_map`,
          ),
  };
}

function resolvePlanReviewMetadataLabels(
  value: unknown,
  field: string,
): PlanReviewMetadataLabels {
  if (value === undefined) {
    return DEFAULT_PLAN_REVIEW_METADATA_LABELS;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }

  const labels = value as Record<string, unknown>;
  return {
    planPath:
      labels["plan_path"] === undefined
        ? DEFAULT_PLAN_REVIEW_METADATA_LABELS.planPath
        : requireString(labels["plan_path"], `${field}.plan_path`),
    branchName:
      labels["branch_name"] === undefined
        ? DEFAULT_PLAN_REVIEW_METADATA_LABELS.branchName
        : requireString(labels["branch_name"], `${field}.branch_name`),
    planUrl:
      labels["plan_url"] === undefined
        ? DEFAULT_PLAN_REVIEW_METADATA_LABELS.planUrl
        : requireString(labels["plan_url"], `${field}.plan_url`),
    branchUrl:
      labels["branch_url"] === undefined
        ? DEFAULT_PLAN_REVIEW_METADATA_LABELS.branchUrl
        : requireString(labels["branch_url"], `${field}.branch_url`),
    compareUrl:
      labels["compare_url"] === undefined
        ? DEFAULT_PLAN_REVIEW_METADATA_LABELS.compareUrl
        : requireString(labels["compare_url"], `${field}.compare_url`),
  };
}

export function resolvePlanReviewProtocol(
  value: unknown,
  field: string,
): PlanReviewProtocol {
  if (value === undefined) {
    return DEFAULT_PLAN_REVIEW_PROTOCOL;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }

  const config = value as Record<string, unknown>;
  const baseProtocol = {
    planReadySignal:
      config["plan_ready_signal"] === undefined
        ? DEFAULT_PLAN_REVIEW_PROTOCOL.planReadySignal
        : requireString(
            config["plan_ready_signal"],
            `${field}.plan_ready_signal`,
          ),
    legacyPlanReadySignals:
      config["legacy_plan_ready_signals"] === undefined
        ? DEFAULT_PLAN_REVIEW_PROTOCOL.legacyPlanReadySignals
        : requireStringArray(
            config["legacy_plan_ready_signals"],
            `${field}.legacy_plan_ready_signals`,
          ),
    approvedSignal:
      config["approved_signal"] === undefined
        ? DEFAULT_PLAN_REVIEW_PROTOCOL.approvedSignal
        : requireString(config["approved_signal"], `${field}.approved_signal`),
    changesRequestedSignal:
      config["changes_requested_signal"] === undefined
        ? DEFAULT_PLAN_REVIEW_PROTOCOL.changesRequestedSignal
        : requireString(
            config["changes_requested_signal"],
            `${field}.changes_requested_signal`,
          ),
    waivedSignal:
      config["waived_signal"] === undefined
        ? DEFAULT_PLAN_REVIEW_PROTOCOL.waivedSignal
        : requireString(config["waived_signal"], `${field}.waived_signal`),
    metadataLabels: resolvePlanReviewMetadataLabels(
      config["metadata_labels"],
      `${field}.metadata_labels`,
    ),
  } as const;

  return {
    ...baseProtocol,
    reviewReplyGuidance:
      config["review_reply_guidance"] === undefined
        ? buildDefaultPlanReviewReplyGuidance(baseProtocol)
        : requireString(
            config["review_reply_guidance"],
            `${field}.review_reply_guidance`,
          ),
    replyTemplateBlock:
      config["reply_template_block"] === undefined
        ? buildDefaultPlanReviewReplyTemplateBlock(baseProtocol)
        : requireString(
            config["reply_template_block"],
            `${field}.reply_template_block`,
          ),
  };
}
