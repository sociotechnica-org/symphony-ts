import { TrackerError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";
import type {
  LinearComment,
  LinearIssueSnapshot,
  LinearProjectSnapshot,
} from "./linear-normalize.js";

export type LinearIssueClassification =
  | "ready"
  | "running"
  | "failed"
  | "completed"
  | "ignored";

type LinearReviewSignal =
  | "plan-ready"
  | "changes-requested"
  | "approved"
  | "waived";

const HUMAN_REVIEW_STATE_NAME = "Human Review";
const REWORK_STATE_NAME = "Rework";
const MERGING_STATE_NAME = "Merging";

export function classifyLinearIssue(
  issue: LinearIssueSnapshot,
  config: LinearTrackerConfig,
): LinearIssueClassification {
  if (!issue.assignedToWorker) {
    return "ignored";
  }

  if (issue.workpad?.status === "completed") {
    return "completed";
  }

  if (config.terminalStates.includes(issue.state.name)) {
    return "running";
  }

  if (
    issue.workpad?.status === "failed" &&
    !isLinearReviewWorkflowState(issue.state.name)
  ) {
    return "failed";
  }

  if (
    issue.workpad?.status === "running" ||
    issue.workpad?.status === "retry-scheduled" ||
    issue.workpad?.status === "handoff-ready" ||
    isLinearReviewWorkflowState(issue.state.name)
  ) {
    return "running";
  }

  return config.activeStates.includes(issue.state.name) ? "ready" : "ignored";
}

export function resolveLinearClaimStateName(
  issue: LinearIssueSnapshot,
  config: LinearTrackerConfig,
): string | null {
  const currentIndex = config.activeStates.indexOf(issue.state.name);
  if (currentIndex < 0) {
    return null;
  }

  const nextStateName = config.activeStates[currentIndex + 1] ?? null;
  // Treat duplicate adjacent entries as a degenerate no-op transition rather
  // than attempting to "advance" the issue into the state it already has.
  if (nextStateName === null || nextStateName === issue.state.name) {
    return null;
  }

  return nextStateName;
}

export function resolveLinearTerminalStateName(
  project: LinearProjectSnapshot,
  config: LinearTrackerConfig,
): string {
  for (const stateName of config.terminalStates) {
    if (project.states.some((state) => state.name === stateName)) {
      return stateName;
    }
  }
  throw new TrackerError(
    `Linear project ${project.slugId} does not expose any configured terminal state`,
  );
}

export function createLinearHandoffLifecycle(
  issue: LinearIssueSnapshot | null,
  branchName: string,
  config: LinearTrackerConfig,
): HandoffLifecycle {
  if (issue === null) {
    return missingLinearLifecycle(
      branchName,
      `No Linear issue found for branch ${branchName}`,
    );
  }

  const reviewSignal = latestLinearReviewSignal(issue.comments);
  const stateName = issue.state.name;
  const hasHandoffMarker =
    issue.workpad?.status === "handoff-ready" ||
    issue.workpad?.status === "completed";

  if (config.terminalStates.includes(stateName)) {
    return linearLifecycle(
      "handoff-ready",
      branchName,
      `Linear issue ${issue.identifier} reached terminal state '${stateName}'`,
    );
  }

  if (sameStateName(stateName, REWORK_STATE_NAME)) {
    return linearLifecycle(
      "actionable-follow-up",
      branchName,
      `Linear issue ${issue.identifier} is waiting on rework in '${stateName}'`,
    );
  }

  if (sameStateName(stateName, MERGING_STATE_NAME)) {
    return linearLifecycle(
      "awaiting-system-checks",
      branchName,
      `Linear issue ${issue.identifier} is waiting for landing in '${stateName}'`,
    );
  }

  if (sameStateName(stateName, HUMAN_REVIEW_STATE_NAME) || hasHandoffMarker) {
    if (reviewSignal === "changes-requested") {
      return linearLifecycle(
        "actionable-follow-up",
        branchName,
        `Linear issue ${issue.identifier} has requested rework`,
      );
    }

    if (reviewSignal === "approved" || reviewSignal === "waived") {
      return linearLifecycle(
        "awaiting-system-checks",
        branchName,
        `Linear issue ${issue.identifier} was approved and is waiting for landing`,
      );
    }

    return linearLifecycle(
      "awaiting-human-handoff",
      branchName,
      `Linear issue ${issue.identifier} is waiting for human review`,
    );
  }

  if (config.activeStates.includes(stateName)) {
    return missingLinearLifecycle(
      branchName,
      `Linear issue ${issue.identifier} is still active in '${stateName}'`,
    );
  }

  return missingLinearLifecycle(
    branchName,
    `Linear issue ${issue.identifier} has no recognized handoff state in '${stateName}'`,
  );
}

export function resolveLinearHumanReviewStateName(
  project: LinearProjectSnapshot,
): string | null {
  return (
    project.states.find((state) =>
      sameStateName(state.name, HUMAN_REVIEW_STATE_NAME),
    )?.name ?? null
  );
}

export function missingLinearLifecycle(
  branchName: string,
  summary: string,
): HandoffLifecycle {
  return linearLifecycle("missing-target", branchName, summary);
}

export function linearTrackerSubject(config: LinearTrackerConfig): string {
  return `linear/${config.projectSlug}`;
}

export function extractIssueNumberFromBranchName(
  branchName: string,
): number | null {
  const branchLeaf = branchName.split("/").at(-1) ?? branchName;
  const match = branchLeaf.match(/^(\d+)(?:-|$)/u);
  if (!match || match[1] === undefined) {
    return null;
  }
  const issueNumber = Number(match[1]);
  return Number.isNaN(issueNumber) ? null : issueNumber;
}

function linearLifecycle(
  kind: HandoffLifecycle["kind"],
  branchName: string,
  summary: string,
): HandoffLifecycle {
  return {
    kind,
    branchName,
    pullRequest: null,
    checks: [],
    pendingCheckNames: [],
    failingCheckNames: [],
    actionableReviewFeedback: [],
    unresolvedThreadIds: [],
    summary,
  };
}

function latestLinearReviewSignal(
  comments: readonly LinearComment[],
): LinearReviewSignal | null {
  return (
    [...comments]
      .sort((left, right) => {
        const timeDiff =
          Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return timeDiff !== 0 ? timeDiff : left.id.localeCompare(right.id);
      })
      .map((comment) => parseLinearReviewSignal(comment.body))
      .filter((signal): signal is LinearReviewSignal => signal !== null)
      .at(-1) ?? null
  );
}

function parseLinearReviewSignal(body: string): LinearReviewSignal | null {
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

function isLinearReviewWorkflowState(stateName: string): boolean {
  return (
    sameStateName(stateName, HUMAN_REVIEW_STATE_NAME) ||
    sameStateName(stateName, REWORK_STATE_NAME) ||
    sameStateName(stateName, MERGING_STATE_NAME)
  );
}

function sameStateName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
