import { TrackerError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";
import type {
  LinearComment,
  LinearIssueSnapshot,
  LinearProjectSnapshot,
} from "./linear-normalize.js";
import {
  parsePlanReviewSignal,
  type PlanReviewSignal,
} from "./plan-review-signal.js";
import { sameLinearStateName } from "./linear-state-name.js";

export type LinearIssueClassification =
  | "ready"
  | "running"
  | "failed"
  | "completed"
  | "ignored";

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

  if (matchesConfiguredStateName(config.terminalStates, issue.state.name)) {
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

  return matchesConfiguredStateName(config.activeStates, issue.state.name)
    ? "ready"
    : "ignored";
}

export function resolveLinearClaimStateName(
  issue: LinearIssueSnapshot,
  config: LinearTrackerConfig,
): string | null {
  const currentIndex = indexOfConfiguredStateName(
    config.activeStates,
    issue.state.name,
  );
  if (currentIndex < 0) {
    return null;
  }

  const nextStateName = config.activeStates[currentIndex + 1] ?? null;
  // Treat duplicate adjacent entries as a degenerate no-op transition rather
  // than attempting to "advance" the issue into the state it already has.
  if (
    nextStateName === null ||
    sameLinearStateName(nextStateName, issue.state.name)
  ) {
    return null;
  }

  return nextStateName;
}

export function resolveLinearTerminalStateName(
  project: LinearProjectSnapshot,
  config: LinearTrackerConfig,
): string {
  for (const stateName of config.terminalStates) {
    const projectStateName = findProjectStateName(project, stateName);
    if (projectStateName !== null) {
      return projectStateName;
    }
  }
  throw new TrackerError(
    `Linear project ${project.slugId} does not expose any configured terminal state`,
  );
}

export function isLinearTerminalWorkflowState(
  stateName: string,
  config: LinearTrackerConfig,
): boolean {
  return matchesConfiguredStateName(config.terminalStates, stateName);
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
  const hasHandoffMarker = issue.workpad?.status === "handoff-ready";

  if (matchesConfiguredStateName(config.terminalStates, stateName)) {
    return linearLifecycle(
      "handoff-ready",
      branchName,
      `Linear issue ${issue.identifier} reached terminal state '${stateName}'`,
    );
  }

  if (sameLinearStateName(stateName, REWORK_STATE_NAME)) {
    return linearLifecycle(
      "actionable-follow-up",
      branchName,
      `Linear issue ${issue.identifier} is waiting on rework in '${stateName}'`,
    );
  }

  if (sameLinearStateName(stateName, MERGING_STATE_NAME)) {
    return linearLifecycle(
      "awaiting-system-checks",
      branchName,
      `Linear issue ${issue.identifier} is waiting for landing in '${stateName}'`,
    );
  }

  if (
    sameLinearStateName(stateName, HUMAN_REVIEW_STATE_NAME) ||
    hasHandoffMarker
  ) {
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

  if (matchesConfiguredStateName(config.activeStates, stateName)) {
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
      sameLinearStateName(state.name, HUMAN_REVIEW_STATE_NAME),
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
): PlanReviewSignal | null {
  return (
    comments
      .map((comment, index) => ({ comment, index }))
      .sort((left, right) => {
        const timeDiff =
          Date.parse(left.comment.createdAt) -
          Date.parse(right.comment.createdAt);
        return timeDiff !== 0 ? timeDiff : left.index - right.index;
      })
      .map(({ comment }) => parsePlanReviewSignal(comment.body))
      .filter((signal): signal is PlanReviewSignal => signal !== null)
      .at(-1) ?? null
  );
}

export function isLinearReviewWorkflowState(stateName: string): boolean {
  return (
    sameLinearStateName(stateName, HUMAN_REVIEW_STATE_NAME) ||
    sameLinearStateName(stateName, REWORK_STATE_NAME) ||
    sameLinearStateName(stateName, MERGING_STATE_NAME)
  );
}

function matchesConfiguredStateName(
  configuredStateNames: readonly string[],
  stateName: string,
): boolean {
  return indexOfConfiguredStateName(configuredStateNames, stateName) >= 0;
}

function indexOfConfiguredStateName(
  configuredStateNames: readonly string[],
  stateName: string,
): number {
  return configuredStateNames.findIndex((candidate) =>
    sameLinearStateName(candidate, stateName),
  );
}

function findProjectStateName(
  project: LinearProjectSnapshot,
  configuredStateName: string,
): string | null {
  return (
    project.states.find((state) =>
      sameLinearStateName(state.name, configuredStateName),
    )?.name ?? null
  );
}
