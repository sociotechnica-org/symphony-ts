import type {
  FactoryControlState,
  FactoryControlStatusSnapshot,
} from "../cli/factory-control.js";
import type { FactoryRuntimeIdentity } from "./runtime-identity.js";
import type { FactoryWorkflowIdentity } from "./workflow-identity.js";

export type OperatorRuntimeFreshnessKind =
  | "fresh"
  | "stale-runtime-idle"
  | "stale-runtime-busy"
  | "stale-workflow-idle"
  | "stale-workflow-busy"
  | "stale-runtime-and-workflow-idle"
  | "stale-runtime-and-workflow-busy"
  | "stopped"
  | "unavailable";

export interface OperatorRuntimeFreshnessSnapshot {
  readonly kind: OperatorRuntimeFreshnessKind;
  readonly shouldRestart: boolean;
  readonly runningRuntimeIdentity: FactoryRuntimeIdentity | null;
  readonly currentRuntimeIdentity: FactoryRuntimeIdentity | null;
  readonly runtimeHeadSha: string | null;
  readonly currentRuntimeHeadSha: string | null;
  readonly engineHeadSha: string | null;
  readonly runningWorkflowIdentity: FactoryWorkflowIdentity | null;
  readonly currentWorkflowIdentity: FactoryWorkflowIdentity | null;
  readonly runtimeChanged: boolean;
  readonly workflowChanged: boolean;
  readonly unavailableReasons: readonly string[];
  readonly controlState: FactoryControlState;
  readonly factoryState: string | null;
  readonly activeIssueCount: number;
  readonly summary: string;
}

export function assessOperatorRuntimeFreshness(args: {
  readonly status: FactoryControlStatusSnapshot;
  readonly currentRuntimeIdentity: FactoryRuntimeIdentity | null;
  readonly currentWorkflowIdentity: FactoryWorkflowIdentity | null;
}): OperatorRuntimeFreshnessSnapshot {
  const runtimeHeadSha = args.status.startup?.runtimeIdentity?.headSha ?? null;
  const currentRuntimeHeadSha = args.currentRuntimeIdentity?.headSha ?? null;
  const runningWorkflowIdentity = args.status.startup?.workflowIdentity ?? null;
  const currentWorkflowIdentity = args.currentWorkflowIdentity;
  const controlState = args.status.controlState;
  const factoryState = args.status.statusSnapshot?.factoryState ?? null;
  const activeIssueCount = args.status.statusSnapshot?.activeIssues.length ?? 0;

  if (controlState !== "running") {
    return {
      kind: "stopped",
      shouldRestart: false,
      runningRuntimeIdentity: args.status.startup?.runtimeIdentity ?? null,
      currentRuntimeIdentity: args.currentRuntimeIdentity,
      runtimeHeadSha,
      currentRuntimeHeadSha,
      engineHeadSha: currentRuntimeHeadSha,
      runningWorkflowIdentity,
      currentWorkflowIdentity,
      runtimeChanged: false,
      workflowChanged: false,
      unavailableReasons: [],
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Factory is not currently running; use the normal health-recovery flow before freshness restarts.",
    };
  }

  const unavailableReasons = collectUnavailableReasons({
    currentRuntimeHeadSha,
    runtimeHeadSha,
    runningWorkflowIdentity,
    currentWorkflowIdentity,
  });
  if (unavailableReasons.length > 0) {
    return {
      kind: "unavailable",
      shouldRestart: false,
      runningRuntimeIdentity: args.status.startup?.runtimeIdentity ?? null,
      currentRuntimeIdentity: args.currentRuntimeIdentity,
      runtimeHeadSha,
      currentRuntimeHeadSha,
      engineHeadSha: currentRuntimeHeadSha,
      runningWorkflowIdentity,
      currentWorkflowIdentity,
      runtimeChanged: false,
      workflowChanged: false,
      unavailableReasons,
      controlState,
      factoryState,
      activeIssueCount,
      summary: `Could not determine whether a restart is required: ${unavailableReasons.join("; ")}`,
    };
  }

  const runtimeChanged = runtimeHeadSha !== currentRuntimeHeadSha;
  const workflowChanged = workflowIdentityChanged(
    runningWorkflowIdentity,
    currentWorkflowIdentity,
  );

  if (!runtimeChanged && !workflowChanged) {
    return {
      kind: "fresh",
      shouldRestart: false,
      runningRuntimeIdentity: args.status.startup?.runtimeIdentity ?? null,
      currentRuntimeIdentity: args.currentRuntimeIdentity,
      runtimeHeadSha,
      currentRuntimeHeadSha,
      engineHeadSha: currentRuntimeHeadSha,
      runningWorkflowIdentity,
      currentWorkflowIdentity,
      runtimeChanged,
      workflowChanged,
      unavailableReasons: [],
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Factory runtime and selected workflow already match the current detached runtime checkout and repository-owned workflow contract.",
    };
  }

  return {
    kind: deriveStaleKind({ runtimeChanged, workflowChanged, factoryState }),
    shouldRestart: factoryState === "idle",
    runningRuntimeIdentity: args.status.startup?.runtimeIdentity ?? null,
    currentRuntimeIdentity: args.currentRuntimeIdentity,
    runtimeHeadSha,
    currentRuntimeHeadSha,
    engineHeadSha: currentRuntimeHeadSha,
    runningWorkflowIdentity,
    currentWorkflowIdentity,
    runtimeChanged,
    workflowChanged,
    unavailableReasons: [],
    controlState,
    factoryState,
    activeIssueCount,
    summary: summarizeStaleness({
      runtimeChanged,
      workflowChanged,
      factoryState,
    }),
  };
}

function collectUnavailableReasons(args: {
  readonly currentRuntimeHeadSha: string | null;
  readonly runtimeHeadSha: string | null;
  readonly runningWorkflowIdentity: FactoryWorkflowIdentity | null;
  readonly currentWorkflowIdentity: FactoryWorkflowIdentity | null;
}): string[] {
  const reasons: string[] = [];
  if (args.currentRuntimeHeadSha === null) {
    reasons.push(
      "current runtime checkout head is unavailable; inspect the selected instance runtime checkout",
    );
  }
  if (args.runtimeHeadSha === null) {
    reasons.push(
      "running factory runtime head is unavailable; inspect the startup snapshot",
    );
  }
  if (args.runningWorkflowIdentity?.contentHash === null) {
    reasons.push(
      summarizeWorkflowUnavailable(
        "running workflow identity",
        args.runningWorkflowIdentity,
      ),
    );
  }
  if (args.currentWorkflowIdentity?.contentHash === null) {
    reasons.push(
      summarizeWorkflowUnavailable(
        "current workflow identity",
        args.currentWorkflowIdentity,
      ),
    );
  }
  if (args.runningWorkflowIdentity === null) {
    reasons.push(
      "running workflow identity is unavailable; inspect the startup snapshot",
    );
  }
  if (args.currentWorkflowIdentity === null) {
    reasons.push(
      "current workflow identity is unavailable; inspect the selected WORKFLOW.md",
    );
  }
  return reasons;
}

function summarizeWorkflowUnavailable(
  label: string,
  identity: FactoryWorkflowIdentity | null,
): string {
  if (identity === null) {
    return `${label} is unavailable`;
  }
  const source =
    identity.detail === null
      ? identity.source
      : `${identity.source}: ${identity.detail}`;
  return `${label} is unavailable for ${identity.workflowPath} (${source})`;
}

function workflowIdentityChanged(
  running: FactoryWorkflowIdentity | null,
  current: FactoryWorkflowIdentity | null,
): boolean {
  if (
    running === null ||
    current === null ||
    running.contentHash === null ||
    current.contentHash === null
  ) {
    return false;
  }
  return (
    running.workflowPath !== current.workflowPath ||
    running.contentHash !== current.contentHash
  );
}

function deriveStaleKind(args: {
  readonly runtimeChanged: boolean;
  readonly workflowChanged: boolean;
  readonly factoryState: string | null;
}): OperatorRuntimeFreshnessKind {
  const suffix = args.factoryState === "idle" ? "idle" : "busy";
  if (args.runtimeChanged && args.workflowChanged) {
    return suffix === "idle"
      ? "stale-runtime-and-workflow-idle"
      : "stale-runtime-and-workflow-busy";
  }
  if (args.runtimeChanged) {
    return suffix === "idle" ? "stale-runtime-idle" : "stale-runtime-busy";
  }
  return suffix === "idle" ? "stale-workflow-idle" : "stale-workflow-busy";
}

function summarizeStaleness(args: {
  readonly runtimeChanged: boolean;
  readonly workflowChanged: boolean;
  readonly factoryState: string | null;
}): string {
  const cause =
    args.runtimeChanged && args.workflowChanged
      ? "the detached runtime checkout and selected workflow contract changed"
      : args.runtimeChanged
        ? "the detached runtime checkout changed"
        : "the selected workflow contract changed";
  if (args.factoryState === "idle") {
    return `Factory restart is required because ${cause} and the instance is idle; restart before ordinary queue work.`;
  }
  return `Factory restart is required because ${cause}, but the instance is busy; defer restart until the next idle or post-merge checkpoint.`;
}
