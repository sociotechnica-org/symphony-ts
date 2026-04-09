import path from "node:path";
import { inspectFactoryControl } from "../cli/factory-control.js";
import { loadWorkflowInstancePaths } from "../config/workflow.js";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../domain/instance-identity.js";
import type { FactoryActiveIssueSnapshot } from "./status.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  deriveOperatorReportReviewStateFile,
  syncOperatorReportReviews,
  type PendingOperatorReportReview,
} from "./operator-report-review.js";
import {
  assessOperatorRuntimeFreshness,
  type OperatorRuntimeFreshnessSnapshot,
} from "./operator-runtime-freshness.js";
import {
  collectFactoryRuntimeIdentity,
  renderFactoryRuntimeIdentity,
} from "./runtime-identity.js";
import {
  collectFactoryWorkflowIdentity,
  renderFactoryWorkflowIdentity,
} from "./workflow-identity.js";
import {
  readOperatorReleaseState,
  type OperatorReadyPromotionState,
  type OperatorReleaseAdvancementState,
} from "./operator-release-state.js";

export const OPERATOR_CONTROL_STATE_SCHEMA_VERSION = 1 as const;

export type OperatorControlPosture =
  | "runtime-blocked"
  | "report-review-blocked"
  | "release-blocked"
  | "action-required"
  | "clear";

export type OperatorControlBlockingCheckpoint =
  | "runtime"
  | "report-review"
  | "release";

export type OperatorControlActionKind = "review-plan" | "post-land-command";

export interface OperatorControlPaths {
  readonly operatorRepoRoot: string;
  readonly selectedInstanceRoot: string;
  readonly workflowPath: string;
  readonly controlStateFile: string;
  readonly releaseStateFile: string;
  readonly reportReviewStateFile: string;
}

export interface OperatorControlRuntimeCheckpoint {
  readonly kind: "runtime";
  readonly state: "clear" | "blocked";
  readonly summary: string;
  readonly controlState: string;
  readonly freshnessKind: string;
  readonly shouldRestart: boolean;
  readonly factoryState: string | null;
  readonly activeIssueCount: number;
}

export interface OperatorControlReportReviewCheckpoint {
  readonly kind: "report-review";
  readonly state: "clear" | "blocked";
  readonly summary: string;
  readonly reviewStateFile: string;
  readonly pending: readonly PendingOperatorReportReview[];
}

export interface OperatorControlReleaseCheckpoint {
  readonly kind: "release";
  readonly state: "clear" | "blocked";
  readonly summary: string;
  readonly releaseStateFile: string;
  readonly advancementState: OperatorReleaseAdvancementState | "unavailable";
  readonly promotionState: OperatorReadyPromotionState | "unavailable";
  readonly blockingPrerequisiteNumber: number | null;
}

export interface OperatorControlActionCandidate {
  readonly kind: OperatorControlActionKind;
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly sourceStatus: "awaiting-human-handoff" | "awaiting-landing-command";
  readonly summary: string;
  readonly pullRequestNumber: number | null;
}

export interface OperatorControlActionItem extends OperatorControlActionCandidate {
  readonly state: "pending" | "blocked";
  readonly blockedBy: OperatorControlBlockingCheckpoint | null;
}

export interface OperatorControlActionCheckpoint {
  readonly kind: "actions";
  readonly state: "clear" | "pending" | "blocked";
  readonly summary: string;
  readonly items: readonly OperatorControlActionItem[];
}

export interface OperatorControlStateDocument {
  readonly version: typeof OPERATOR_CONTROL_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly posture: OperatorControlPosture;
  readonly summary: string;
  readonly blockingCheckpoint: OperatorControlBlockingCheckpoint | null;
  readonly nextActionSummary: string | null;
  readonly paths: OperatorControlPaths;
  readonly runtime: OperatorControlRuntimeCheckpoint;
  readonly reportReview: OperatorControlReportReviewCheckpoint;
  readonly release: OperatorControlReleaseCheckpoint;
  readonly actions: OperatorControlActionCheckpoint;
}

export function deriveOperatorControlStateFile(paths: {
  readonly controlStatePath: string;
}): string {
  return paths.controlStatePath;
}

export function collectOperatorControlActionCandidates(
  activeIssues: readonly FactoryActiveIssueSnapshot[],
): readonly OperatorControlActionCandidate[] {
  const candidates: OperatorControlActionCandidate[] = [];
  for (const issue of activeIssues) {
    if (issue.status === "awaiting-human-handoff") {
      candidates.push({
        kind: "review-plan",
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        title: issue.title,
        sourceStatus: issue.status,
        summary: `Review the plan for issue #${issue.issueNumber.toString()} against the selected instance contract and post the configured decision marker.`,
        pullRequestNumber: issue.pullRequest?.number ?? null,
      });
      continue;
    }
    if (issue.status === "awaiting-landing-command") {
      candidates.push({
        kind: "post-land-command",
        issueNumber: issue.issueNumber,
        issueIdentifier: issue.issueIdentifier,
        title: issue.title,
        sourceStatus: issue.status,
        summary:
          issue.pullRequest === null
            ? `Inspect issue #${issue.issueNumber.toString()} and post /land only if the guard conditions are satisfied.`
            : `Inspect PR #${issue.pullRequest.number.toString()} for issue #${issue.issueNumber.toString()} and post /land only if required CI is green and review is clean.`,
        pullRequestNumber: issue.pullRequest?.number ?? null,
      });
    }
  }
  return candidates.sort((left, right) => left.issueNumber - right.issueNumber);
}

export function evaluateOperatorControlState(args: {
  readonly updatedAt: string;
  readonly paths: OperatorControlPaths;
  readonly runtime: OperatorControlRuntimeCheckpoint;
  readonly reportReview: OperatorControlReportReviewCheckpoint;
  readonly release: OperatorControlReleaseCheckpoint;
  readonly actionCandidates: readonly OperatorControlActionCandidate[];
}): OperatorControlStateDocument {
  const blockingCheckpoint = determineBlockingCheckpoint(args);
  const posture = determinePosture(args, blockingCheckpoint);
  const actions = buildActionCheckpoint(
    args.actionCandidates,
    blockingCheckpoint,
  );

  return {
    version: OPERATOR_CONTROL_STATE_SCHEMA_VERSION,
    updatedAt: args.updatedAt,
    posture,
    summary: summarizePosture({
      posture,
      runtime: args.runtime,
      reportReview: args.reportReview,
      release: args.release,
      actions,
    }),
    blockingCheckpoint,
    nextActionSummary: determineNextActionSummary({
      posture,
      runtime: args.runtime,
      reportReview: args.reportReview,
      release: args.release,
      actions,
    }),
    paths: args.paths,
    runtime: args.runtime,
    reportReview: args.reportReview,
    release: args.release,
    actions,
  };
}

export async function writeOperatorControlState(
  filePath: string,
  document: OperatorControlStateDocument,
): Promise<void> {
  await writeJsonFileAtomic(filePath, document, {
    tempPrefix: ".operator-control-state",
  });
}

export async function refreshOperatorControlState(args: {
  readonly workflowPath: string;
  readonly operatorRepoRoot: string;
}): Promise<OperatorControlStateDocument> {
  const workflowPath = path.resolve(args.workflowPath);
  const operatorRepoRoot = path.resolve(args.operatorRepoRoot);
  const identity = deriveSymphonyInstanceIdentity(workflowPath);
  const operatorPaths = deriveOperatorInstanceStatePaths({
    operatorRepoRoot,
    instanceKey: identity.instanceKey,
  });
  const paths: OperatorControlPaths = {
    operatorRepoRoot,
    selectedInstanceRoot: identity.instanceRoot,
    workflowPath,
    controlStateFile: deriveOperatorControlStateFile(operatorPaths),
    releaseStateFile: operatorPaths.releaseStatePath,
    reportReviewStateFile: deriveOperatorReportReviewStateFile(operatorPaths),
  };
  const updatedAt = new Date().toISOString();

  const runtimeResult = await loadRuntimeCheckpoint({
    workflowPath,
  });
  const instance = await loadWorkflowInstancePaths(workflowPath);

  const reportReview = await loadReportReviewCheckpoint({
    instance,
    reviewStateFile: paths.reportReviewStateFile,
  });
  const release = await loadReleaseCheckpoint({
    releaseStateFile: paths.releaseStateFile,
  });

  const document = evaluateOperatorControlState({
    updatedAt,
    paths,
    runtime: runtimeResult.checkpoint,
    reportReview,
    release,
    actionCandidates: collectOperatorControlActionCandidates(
      runtimeResult.activeIssues,
    ),
  });
  await writeOperatorControlState(paths.controlStateFile, document);
  return document;
}

async function loadRuntimeCheckpoint(args: {
  readonly workflowPath: string;
}): Promise<{
  readonly checkpoint: OperatorControlRuntimeCheckpoint;
  readonly activeIssues: readonly FactoryActiveIssueSnapshot[];
}> {
  try {
    const status = await inspectFactoryControl({
      workflowPath: args.workflowPath,
    });
    const currentRuntimeIdentity = await collectFactoryRuntimeIdentity(
      status.paths.runtimeRoot,
    );
    const currentWorkflowIdentity = await collectFactoryWorkflowIdentity(
      status.paths.workflowPath,
    );
    const freshness = assessOperatorRuntimeFreshness({
      status,
      currentRuntimeIdentity,
      currentWorkflowIdentity,
    });
    return {
      checkpoint: runtimeCheckpointFromFreshness(freshness),
      activeIssues: status.statusSnapshot?.activeIssues ?? [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checkpoint: {
        kind: "runtime",
        state: "blocked",
        summary: `Operator control state could not inspect factory status: ${message}`,
        controlState: "unavailable",
        freshnessKind: "unavailable",
        shouldRestart: false,
        factoryState: null,
        activeIssueCount: 0,
      },
      activeIssues: [],
    };
  }
}

export function runtimeCheckpointFromFreshness(
  freshness: OperatorRuntimeFreshnessSnapshot,
): OperatorControlRuntimeCheckpoint {
  return {
    kind: "runtime",
    state: runtimeCheckpointState(freshness),
    summary: summarizeRuntimeCheckpoint(freshness),
    controlState: freshness.controlState,
    freshnessKind: freshness.kind,
    shouldRestart: freshness.shouldRestart,
    factoryState: freshness.factoryState,
    activeIssueCount: freshness.activeIssueCount,
  };
}

function runtimeCheckpointState(
  freshness: OperatorRuntimeFreshnessSnapshot,
): OperatorControlRuntimeCheckpoint["state"] {
  if (freshness.kind === "fresh") {
    return "clear";
  }
  if (freshness.kind === "stopped" || freshness.kind === "unavailable") {
    return "blocked";
  }
  return freshness.shouldRestart ? "blocked" : "clear";
}

function summarizeRuntimeCheckpoint(
  freshness: OperatorRuntimeFreshnessSnapshot,
): string {
  if (freshness.kind === "fresh") {
    return freshness.summary;
  }
  if (freshness.kind === "unavailable") {
    return `Runtime checkpoint is unavailable: ${freshness.summary}`;
  }
  if (freshness.kind === "stopped") {
    return `Runtime checkpoint is blocked: ${freshness.summary}`;
  }
  if (freshness.shouldRestart) {
    return `Runtime checkpoint is blocked: ${freshness.summary}`;
  }
  return freshness.summary;
}

async function loadReportReviewCheckpoint(args: {
  readonly instance: Awaited<ReturnType<typeof loadWorkflowInstancePaths>>;
  readonly reviewStateFile: string;
}): Promise<OperatorControlReportReviewCheckpoint> {
  try {
    const synced = await syncOperatorReportReviews({
      instance: args.instance,
      reviewStateFile: args.reviewStateFile,
    });
    if (synced.pending.length === 0) {
      return {
        kind: "report-review",
        state: "clear",
        summary:
          "Completed-run report review is clear for this cycle; no report-ready or review-blocked entries are pending.",
        reviewStateFile: args.reviewStateFile,
        pending: [],
      };
    }
    const first = synced.pending[0];
    if (first === undefined) {
      throw new Error("Pending report review summary was missing.");
    }
    return {
      kind: "report-review",
      state: "blocked",
      summary: `Completed-run report review must be handled before ordinary queue work. ${synced.pending.length.toString()} review item(s) are pending; first is issue #${first.issueNumber.toString()} [${first.status}].`,
      reviewStateFile: args.reviewStateFile,
      pending: synced.pending,
    };
  } catch (error) {
    return {
      kind: "report-review",
      state: "blocked",
      summary: `Completed-run report review could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      reviewStateFile: args.reviewStateFile,
      pending: [],
    };
  }
}

async function loadReleaseCheckpoint(args: {
  readonly releaseStateFile: string;
}): Promise<OperatorControlReleaseCheckpoint> {
  try {
    const releaseState = await readOperatorReleaseState(args.releaseStateFile);
    const advancementState = releaseState.evaluation.advancementState;
    const promotionState = releaseState.promotion.state;
    const blocked =
      advancementState === "blocked-by-prerequisite-failure" ||
      advancementState === "blocked-review-needed" ||
      promotionState === "blocked-review-needed" ||
      promotionState === "sync-failed";
    return {
      kind: "release",
      state: blocked ? "blocked" : "clear",
      summary: blocked
        ? `Release checkpoint blocks downstream advancement or landing: ${releaseState.evaluation.summary} Promotion: ${releaseState.promotion.summary}`
        : releaseState.evaluation.summary,
      releaseStateFile: args.releaseStateFile,
      advancementState,
      promotionState,
      blockingPrerequisiteNumber:
        releaseState.evaluation.blockingPrerequisite?.issueNumber ?? null,
    };
  } catch (error) {
    return {
      kind: "release",
      state: "blocked",
      summary: `Release checkpoint could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      releaseStateFile: args.releaseStateFile,
      advancementState: "unavailable",
      promotionState: "unavailable",
      blockingPrerequisiteNumber: null,
    };
  }
}

function determineBlockingCheckpoint(args: {
  readonly runtime: OperatorControlRuntimeCheckpoint;
  readonly reportReview: OperatorControlReportReviewCheckpoint;
  readonly release: OperatorControlReleaseCheckpoint;
}): OperatorControlBlockingCheckpoint | null {
  if (args.runtime.state === "blocked") {
    return "runtime";
  }
  if (args.reportReview.state === "blocked") {
    return "report-review";
  }
  if (args.release.state === "blocked") {
    return "release";
  }
  return null;
}

function determinePosture(
  args: {
    readonly runtime: OperatorControlRuntimeCheckpoint;
    readonly reportReview: OperatorControlReportReviewCheckpoint;
    readonly release: OperatorControlReleaseCheckpoint;
    readonly actionCandidates: readonly OperatorControlActionCandidate[];
  },
  blockingCheckpoint: OperatorControlBlockingCheckpoint | null,
): OperatorControlPosture {
  if (blockingCheckpoint === "runtime") {
    return "runtime-blocked";
  }
  if (blockingCheckpoint === "report-review") {
    return "report-review-blocked";
  }
  if (blockingCheckpoint === "release") {
    return "release-blocked";
  }
  return args.actionCandidates.length > 0 ? "action-required" : "clear";
}

function buildActionCheckpoint(
  candidates: readonly OperatorControlActionCandidate[],
  blockingCheckpoint: OperatorControlBlockingCheckpoint | null,
): OperatorControlActionCheckpoint {
  const itemState: OperatorControlActionItem["state"] =
    blockingCheckpoint === null ? "pending" : "blocked";
  const items: OperatorControlActionItem[] = candidates.map((candidate) => ({
    ...candidate,
    state: itemState,
    blockedBy: blockingCheckpoint,
  }));
  if (items.length === 0) {
    return {
      kind: "actions",
      state: "clear",
      summary:
        "No operator-gated plan-review or landing action is pending after the earlier checkpoints.",
      items,
    };
  }
  if (blockingCheckpoint !== null) {
    return {
      kind: "actions",
      state: "blocked",
      summary: `${items.length.toString()} operator-gated action(s) are waiting behind the ${blockingCheckpoint} checkpoint.`,
      items,
    };
  }
  return {
    kind: "actions",
    state: "pending",
    summary: `${items.length.toString()} operator-gated action(s) are pending for this cycle.`,
    items,
  };
}

function summarizePosture(args: {
  readonly posture: OperatorControlPosture;
  readonly runtime: OperatorControlRuntimeCheckpoint;
  readonly reportReview: OperatorControlReportReviewCheckpoint;
  readonly release: OperatorControlReleaseCheckpoint;
  readonly actions: OperatorControlActionCheckpoint;
}): string {
  switch (args.posture) {
    case "runtime-blocked":
      return args.runtime.summary;
    case "report-review-blocked":
      return args.reportReview.summary;
    case "release-blocked":
      return args.release.summary;
    case "action-required":
      return args.actions.items[0]?.summary ?? args.actions.summary;
    case "clear":
      return "All mandatory operator checkpoints are clear for this cycle.";
  }
}

function determineNextActionSummary(args: {
  readonly posture: OperatorControlPosture;
  readonly runtime: OperatorControlRuntimeCheckpoint;
  readonly reportReview: OperatorControlReportReviewCheckpoint;
  readonly release: OperatorControlReleaseCheckpoint;
  readonly actions: OperatorControlActionCheckpoint;
}): string | null {
  switch (args.posture) {
    case "runtime-blocked":
      return args.runtime.summary;
    case "report-review-blocked":
      return args.reportReview.pending[0]?.summary ?? args.reportReview.summary;
    case "release-blocked":
      return args.release.summary;
    case "action-required":
      return args.actions.items[0]?.summary ?? null;
    case "clear":
      return null;
  }
}

export function renderOperatorControlState(
  document: OperatorControlStateDocument,
): string {
  const lines = [
    `Posture: ${document.posture}`,
    `Summary: ${document.summary}`,
    `Blocking checkpoint: ${document.blockingCheckpoint ?? "none"}`,
    `Workflow: ${document.paths.workflowPath}`,
    `Selected instance root: ${document.paths.selectedInstanceRoot}`,
    "",
    "Runtime checkpoint:",
    `  State: ${document.runtime.state}`,
    `  Summary: ${document.runtime.summary}`,
    `  Factory control: ${document.runtime.controlState}`,
    `  Freshness: ${document.runtime.freshnessKind}`,
    "",
    "Report review checkpoint:",
    `  State: ${document.reportReview.state}`,
    `  Summary: ${document.reportReview.summary}`,
    `  Review state file: ${document.reportReview.reviewStateFile}`,
    "",
    "Release checkpoint:",
    `  State: ${document.release.state}`,
    `  Summary: ${document.release.summary}`,
    `  Release state file: ${document.release.releaseStateFile}`,
    "",
    "Operator-gated actions:",
  ];
  if (document.actions.items.length === 0) {
    lines.push("  none");
  } else {
    for (const item of document.actions.items) {
      lines.push(
        `  - [${item.state}] ${item.kind} issue #${item.issueNumber.toString()}${item.pullRequestNumber === null ? "" : ` pr #${item.pullRequestNumber.toString()}`}: ${item.summary}`,
      );
    }
  }
  return lines.join("\n");
}

export function describeRuntimeEvidence(
  freshness: OperatorRuntimeFreshnessSnapshot,
): string {
  return [
    `running runtime: ${renderFactoryRuntimeIdentity(freshness.runningRuntimeIdentity)}`,
    `current runtime: ${renderFactoryRuntimeIdentity(freshness.currentRuntimeIdentity)}`,
    `running workflow: ${renderFactoryWorkflowIdentity(freshness.runningWorkflowIdentity)}`,
    `current workflow: ${renderFactoryWorkflowIdentity(freshness.currentWorkflowIdentity)}`,
  ].join("; ");
}
