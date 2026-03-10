import { TrackerError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";
import type {
  LinearIssueSnapshot,
  LinearProjectSnapshot,
  LinearWorkflowState,
} from "./linear-normalize.js";

export type LinearIssueClassification =
  | "ready"
  | "running"
  | "failed"
  | "completed"
  | "ignored";

export function classifyLinearIssue(
  issue: LinearIssueSnapshot,
  config: LinearTrackerConfig,
): LinearIssueClassification {
  if (!issue.assignedToWorker) {
    return "ignored";
  }

  if (config.terminalStates.includes(issue.state.name)) {
    return "completed";
  }

  switch (issue.workpad?.status) {
    case "failed":
      return "failed";
    case "running":
    case "retry-scheduled":
    case "handoff-ready":
      return "running";
    case "completed":
      return "completed";
    default:
      break;
  }

  if (config.activeStates.includes(issue.state.name)) {
    return "ready";
  }

  return "ignored";
}

export function resolveLinearClaimState(
  project: LinearProjectSnapshot,
  issue: LinearIssueSnapshot,
  config: LinearTrackerConfig,
): LinearWorkflowState | null {
  const currentIndex = config.activeStates.indexOf(issue.state.name);
  if (currentIndex < 0) {
    return null;
  }

  const nextStateName = config.activeStates[currentIndex + 1] ?? null;
  if (nextStateName === null || nextStateName === issue.state.name) {
    return null;
  }

  return resolveStateByName(project, nextStateName);
}

export function resolveLinearTerminalState(
  project: LinearProjectSnapshot,
  config: LinearTrackerConfig,
): LinearWorkflowState {
  for (const stateName of config.terminalStates) {
    const match = project.states.find((state) => state.name === stateName);
    if (match !== undefined) {
      return match;
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

  if (
    issue.workpad?.status === "handoff-ready" ||
    issue.workpad?.status === "completed" ||
    config.terminalStates.includes(issue.state.name)
  ) {
    return {
      kind: "handoff-ready",
      branchName,
      pullRequest: null,
      checks: [],
      pendingCheckNames: [],
      failingCheckNames: [],
      actionableReviewFeedback: [],
      unresolvedThreadIds: [],
      summary: `Linear issue ${issue.identifier} is ready for completion`,
    };
  }

  return missingLinearLifecycle(
    branchName,
    `Linear issue ${issue.identifier} has not reached handoff-ready`,
  );
}

export function missingLinearLifecycle(
  branchName: string,
  summary: string,
): HandoffLifecycle {
  return {
    kind: "missing-target",
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

function resolveStateByName(
  project: LinearProjectSnapshot,
  stateName: string,
): LinearWorkflowState {
  const match = project.states.find((state) => state.name === stateName);
  if (match !== undefined) {
    return match;
  }
  throw new TrackerError(
    `Linear project ${project.slugId} is missing configured state '${stateName}'`,
  );
}
