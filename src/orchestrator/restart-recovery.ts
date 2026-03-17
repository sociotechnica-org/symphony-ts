import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { IssueLeaseSnapshot } from "./issue-lease.js";

export type RestartRecoveryFactoryState =
  | "idle"
  | "reconciling"
  | "degraded"
  | "ready";

export type RestartRecoveryDecisionKind =
  | "adopted"
  | "recovered-shutdown"
  | "requeued"
  | "suppressed-terminal"
  | "degraded";

export interface RestartRecoveryDecision {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly branchName: string;
  readonly decision: RestartRecoveryDecisionKind;
  readonly leaseState: IssueLeaseSnapshot["kind"];
  readonly lifecycleKind: HandoffLifecycle["kind"] | null;
  readonly summary: string;
  readonly shouldDispatch: boolean;
}

function isTerminalOrHandedOffLifecycle(lifecycle: HandoffLifecycle): boolean {
  return lifecycle.kind !== "missing-target";
}

export function decideRestartRecovery(input: {
  readonly issue: RuntimeIssue;
  readonly branchName: string;
  readonly snapshot: IssueLeaseSnapshot;
  readonly lifecycle: HandoffLifecycle | null;
}): RestartRecoveryDecision {
  const { issue, branchName, snapshot, lifecycle } = input;

  if (snapshot.kind === "active") {
    return {
      issueNumber: issue.number,
      issueIdentifier: issue.identifier,
      branchName,
      decision: "adopted",
      leaseState: snapshot.kind,
      lifecycleKind: lifecycle?.kind ?? null,
      summary: `Adopted healthy inherited ownership for ${issue.identifier}.`,
      shouldDispatch: false,
    };
  }

  if (lifecycle !== null && isTerminalOrHandedOffLifecycle(lifecycle)) {
    return {
      issueNumber: issue.number,
      issueIdentifier: issue.identifier,
      branchName,
      decision: "suppressed-terminal",
      leaseState: snapshot.kind,
      lifecycleKind: lifecycle.kind,
      summary: `Suppressed restart rerun for ${issue.identifier} because tracker handoff is already ${lifecycle.kind}.`,
      shouldDispatch: true,
    };
  }

  if (
    snapshot.kind === "shutdown-terminated" ||
    snapshot.kind === "shutdown-forced"
  ) {
    return {
      issueNumber: issue.number,
      issueIdentifier: issue.identifier,
      branchName,
      decision: "recovered-shutdown",
      leaseState: snapshot.kind,
      lifecycleKind: lifecycle?.kind ?? null,
      summary: `Recovered intentional shutdown residue for ${issue.identifier}.`,
      shouldDispatch: true,
    };
  }

  return {
    issueNumber: issue.number,
    issueIdentifier: issue.identifier,
    branchName,
    decision: "requeued",
    leaseState: snapshot.kind,
    lifecycleKind: lifecycle?.kind ?? null,
    summary:
      snapshot.kind === "missing"
        ? `Recovered ${issue.identifier} with no inherited local ownership.`
        : `Recovered stale inherited ownership for ${issue.identifier}.`,
    shouldDispatch: true,
  };
}
