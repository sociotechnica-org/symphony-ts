import type {
  FactoryControlState,
  FactoryControlStatusSnapshot,
} from "../cli/factory-control.js";
import type { FactoryRuntimeIdentity } from "./runtime-identity.js";

export type OperatorRuntimeFreshnessKind =
  | "fresh"
  | "stale-idle"
  | "stale-busy"
  | "stopped"
  | "engine-head-unavailable"
  | "runtime-head-unavailable";

export interface OperatorRuntimeFreshnessSnapshot {
  readonly kind: OperatorRuntimeFreshnessKind;
  readonly shouldRestart: boolean;
  readonly runtimeHeadSha: string | null;
  readonly engineHeadSha: string | null;
  readonly controlState: FactoryControlState;
  readonly factoryState: string | null;
  readonly activeIssueCount: number;
  readonly summary: string;
}

export function assessOperatorRuntimeFreshness(args: {
  readonly status: FactoryControlStatusSnapshot;
  readonly engineRuntimeIdentity: FactoryRuntimeIdentity | null;
}): OperatorRuntimeFreshnessSnapshot {
  const runtimeHeadSha = args.status.startup?.runtimeIdentity?.headSha ?? null;
  const engineHeadSha = args.engineRuntimeIdentity?.headSha ?? null;
  const controlState = args.status.controlState;
  const factoryState = args.status.statusSnapshot?.factoryState ?? null;
  const activeIssueCount = args.status.statusSnapshot?.activeIssues.length ?? 0;

  if (controlState !== "running") {
    return {
      kind: "stopped",
      shouldRestart: false,
      runtimeHeadSha,
      engineHeadSha,
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Factory is not currently running; use the normal health-recovery flow before freshness restarts.",
    };
  }

  if (engineHeadSha === null) {
    return {
      kind: "engine-head-unavailable",
      shouldRestart: false,
      runtimeHeadSha,
      engineHeadSha,
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Could not determine the engine checkout head; investigate the operator repo checkout before applying freshness restarts.",
    };
  }

  if (runtimeHeadSha === null) {
    return {
      kind: "runtime-head-unavailable",
      shouldRestart: false,
      runtimeHeadSha,
      engineHeadSha,
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Could not determine the running factory head; investigate startup/runtime identity before applying freshness restarts.",
    };
  }

  if (runtimeHeadSha === engineHeadSha) {
    return {
      kind: "fresh",
      shouldRestart: false,
      runtimeHeadSha,
      engineHeadSha,
      controlState,
      factoryState,
      activeIssueCount,
      summary: "Factory runtime is already on the current engine head.",
    };
  }

  if (factoryState === "idle") {
    return {
      kind: "stale-idle",
      shouldRestart: true,
      runtimeHeadSha,
      engineHeadSha,
      controlState,
      factoryState,
      activeIssueCount,
      summary:
        "Factory runtime is behind the current engine head and the instance is idle; restart it before ordinary queue work.",
    };
  }

  return {
    kind: "stale-busy",
    shouldRestart: false,
    runtimeHeadSha,
    engineHeadSha,
    controlState,
    factoryState,
    activeIssueCount,
    summary:
      "Factory runtime is behind the current engine head but the instance is busy; defer restart until the next idle or post-merge checkpoint.",
  };
}
