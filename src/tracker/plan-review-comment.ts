import { parsePlanReviewSignal } from "./plan-review-signal.js";

export const PLAN_REVIEW_REPLY_TEMPLATE_BLOCK = [
  "````md",
  "```md",
  "Plan review: approved",
  "",
  "Summary",
  "",
  "- Approved to implement.",
  "```",
  "",
  "```md",
  "Plan review: changes-requested",
  "",
  "Summary",
  "",
  "- One-sentence decision.",
  "",
  "What is good",
  "",
  "- ...",
  "",
  "Required changes",
  "",
  "- ...",
  "",
  "Architecture / spec concerns",
  "",
  "- ...",
  "",
  "Slice / PR size concerns",
  "",
  "- ...",
  "",
  "Approval condition",
  "",
  "- Approve after ...",
  "```",
  "",
  "```md",
  "Plan review: waived",
  "",
  "Summary",
  "",
  "- Plan review is waived; proceed to implementation.",
  "```",
  "````",
].join("\n");

export interface PlanReadyCommentMetadata {
  readonly planPath: string;
  readonly branchName: string;
  readonly planUrl: string;
  readonly branchUrl: string;
  readonly compareUrl: string;
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
    planUrl: `${repositoryUrl}/blob/${input.branchName}/${input.planPath}`,
    branchUrl: `${repositoryUrl}/tree/${input.branchName}`,
    compareUrl: `${repositoryUrl}/compare/${baseBranch}...${input.branchName}`,
  };
}

export function formatPlanReadyComment(input: {
  readonly repo: string;
  readonly planPath: string;
  readonly branchName: string;
  readonly summaryLines: readonly string[];
  readonly baseBranch?: string;
}): string {
  const metadata = buildPlanReadyCommentMetadata(input);

  return [
    "Plan status: plan-ready",
    "",
    `Plan path: \`${metadata.planPath}\``,
    `Branch: \`${metadata.branchName}\``,
    `Plan URL: ${metadata.planUrl}`,
    `Branch URL: ${metadata.branchUrl}`,
    `Compare URL: ${metadata.compareUrl}`,
    "",
    "Summary",
    "",
    ...input.summaryLines.map((line) => `- ${line}`),
    "",
    "Review replies must start with one of these exact first-line markers: `Plan review: approved`, `Plan review: changes-requested`, or `Plan review: waived`.",
    "",
    PLAN_REVIEW_REPLY_TEMPLATE_BLOCK,
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
  const expression = new RegExp(`^${label}:\\s*(.+)$`, "imu");
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
): PlanReadyCommentMetadata | null {
  if (parsePlanReviewSignal(body) !== "plan-ready") {
    return null;
  }

  const planPath = parseMetadataLine(body, "Plan path");
  const branchName = parseMetadataLine(body, "Branch");
  const planUrl = parseMetadataLine(body, "Plan URL", {
    normalizeBackticks: false,
  });
  const branchUrl = parseMetadataLine(body, "Branch URL", {
    normalizeBackticks: false,
  });
  const compareUrl = parseMetadataLine(body, "Compare URL", {
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
