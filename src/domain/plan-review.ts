export type PlanReviewSignal =
  | "plan-ready"
  | "changes-requested"
  | "approved"
  | "waived";

export type PlanReviewDecisionSignal = Exclude<PlanReviewSignal, "plan-ready">;

export interface PlanReviewMetadataLabels {
  readonly planPath: string;
  readonly branchName: string;
  readonly planUrl: string;
  readonly branchUrl: string;
  readonly compareUrl: string;
}

export interface PlanReviewProtocol {
  readonly planReadySignal: string;
  readonly legacyPlanReadySignals: readonly string[];
  readonly approvedSignal: string;
  readonly changesRequestedSignal: string;
  readonly waivedSignal: string;
  readonly metadataLabels: PlanReviewMetadataLabels;
  readonly reviewReplyGuidance: string;
  readonly replyTemplateBlock: string;
}

export const DEFAULT_PLAN_REVIEW_METADATA_LABELS: PlanReviewMetadataLabels = {
  planPath: "Plan path",
  branchName: "Branch",
  planUrl: "Plan URL",
  branchUrl: "Branch URL",
  compareUrl: "Compare URL",
};

export function buildDefaultPlanReviewReplyGuidance(
  protocol: Pick<
    PlanReviewProtocol,
    "approvedSignal" | "changesRequestedSignal" | "waivedSignal"
  >,
): string {
  return `Review replies must start with one of these exact first-line markers: \`${protocol.approvedSignal}\`, \`${protocol.changesRequestedSignal}\`, or \`${protocol.waivedSignal}\`.`;
}

export function buildDefaultPlanReviewReplyTemplateBlock(
  protocol: Pick<
    PlanReviewProtocol,
    "approvedSignal" | "changesRequestedSignal" | "waivedSignal"
  >,
): string {
  return [
    "````md",
    "```md",
    protocol.approvedSignal,
    "",
    "Summary",
    "",
    "- Approved to implement.",
    "```",
    "",
    "```md",
    protocol.changesRequestedSignal,
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
    protocol.waivedSignal,
    "",
    "Summary",
    "",
    "- Plan review is waived; proceed to implementation.",
    "```",
    "````",
  ].join("\n");
}

export function createDefaultPlanReviewProtocol(): PlanReviewProtocol {
  const base = {
    planReadySignal: "Plan status: plan-ready",
    legacyPlanReadySignals: ["Plan ready for review."] as const,
    approvedSignal: "Plan review: approved",
    changesRequestedSignal: "Plan review: changes-requested",
    waivedSignal: "Plan review: waived",
    metadataLabels: DEFAULT_PLAN_REVIEW_METADATA_LABELS,
  } as const;

  return {
    ...base,
    reviewReplyGuidance: buildDefaultPlanReviewReplyGuidance(base),
    replyTemplateBlock: buildDefaultPlanReviewReplyTemplateBlock(base),
  };
}

export const DEFAULT_PLAN_REVIEW_PROTOCOL = createDefaultPlanReviewProtocol();
