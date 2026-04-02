import {
  DEFAULT_PLAN_REVIEW_PROTOCOL,
  type PlanReviewProtocol,
} from "../domain/plan-review.js";
import { parsePlanReviewSignal } from "./plan-review-signal.js";

export interface PlanReadyCommentMetadata {
  readonly planPath: string;
  readonly branchName: string;
  readonly planUrl: string;
  readonly branchUrl: string;
  readonly compareUrl: string;
}

function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildPlanReadyCommentMetadata(input: {
  readonly repo: string;
  readonly planPath: string;
  readonly branchName: string;
  readonly baseBranch?: string;
}): PlanReadyCommentMetadata {
  const repositoryUrl = `https://github.com/${input.repo}`;
  const baseBranch = input.baseBranch ?? "main";

  return {
    planPath: input.planPath,
    branchName: input.branchName,
    planUrl: `${repositoryUrl}/blob/${encodeGitHubPath(input.branchName)}/${encodeGitHubPath(input.planPath)}`,
    branchUrl: `${repositoryUrl}/tree/${encodeGitHubPath(input.branchName)}`,
    compareUrl: `${repositoryUrl}/compare/${encodeGitHubPath(baseBranch)}...${encodeGitHubPath(input.branchName)}`,
  };
}

export function formatPlanReadyComment(input: {
  readonly repo: string;
  readonly planPath: string;
  readonly branchName: string;
  readonly summaryLines: readonly string[];
  readonly baseBranch?: string;
  readonly protocol?: PlanReviewProtocol;
}): string {
  const metadata = buildPlanReadyCommentMetadata(input);
  const protocol = input.protocol ?? DEFAULT_PLAN_REVIEW_PROTOCOL;
  const metadataLabels = protocol.metadataLabels;

  return [
    protocol.planReadySignal,
    "",
    `${metadataLabels.planPath}: \`${metadata.planPath}\``,
    `${metadataLabels.branchName}: \`${metadata.branchName}\``,
    `${metadataLabels.planUrl}: ${metadata.planUrl}`,
    `${metadataLabels.branchUrl}: ${metadata.branchUrl}`,
    `${metadataLabels.compareUrl}: ${metadata.compareUrl}`,
    "",
    "Summary",
    "",
    ...input.summaryLines.map((line) => `- ${line}`),
    "",
    protocol.reviewReplyGuidance,
    "",
    protocol.replyTemplateBlock,
  ].join("\n");
}

function normalizeBacktickValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "`") {
    return "";
  }
  if (trimmed.length > 1 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseMetadataLine(
  body: string,
  label: string,
  options?: { readonly normalizeBackticks?: boolean },
): string | null {
  const expression = new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "imu");
  const match = body.match(expression);
  const value = match?.[1]?.trim();
  if (!value) {
    return null;
  }
  const normalizedValue =
    options?.normalizeBackticks === false
      ? value
      : normalizeBacktickValue(value);
  return normalizedValue.length > 0 ? normalizedValue : null;
}

export function parsePlanReadyCommentMetadata(
  body: string,
  protocol: PlanReviewProtocol = DEFAULT_PLAN_REVIEW_PROTOCOL,
): PlanReadyCommentMetadata | null {
  if (parsePlanReviewSignal(body, protocol) !== "plan-ready") {
    return null;
  }

  const metadataLabels = protocol.metadataLabels;
  const planPath = parseMetadataLine(body, metadataLabels.planPath);
  const branchName = parseMetadataLine(body, metadataLabels.branchName);
  const planUrl = parseMetadataLine(body, metadataLabels.planUrl, {
    normalizeBackticks: false,
  });
  const branchUrl = parseMetadataLine(body, metadataLabels.branchUrl, {
    normalizeBackticks: false,
  });
  const compareUrl = parseMetadataLine(body, metadataLabels.compareUrl, {
    normalizeBackticks: false,
  });

  if (
    planPath === null ||
    branchName === null ||
    planUrl === null ||
    branchUrl === null ||
    compareUrl === null
  ) {
    return null;
  }

  return {
    planPath,
    branchName,
    planUrl,
    branchUrl,
    compareUrl,
  };
}
