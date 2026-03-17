import { describe, expect, it } from "vitest";
import { decideRestartRecovery } from "../../src/orchestrator/restart-recovery.js";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import type { IssueLeaseSnapshot } from "../../src/orchestrator/issue-lease.js";

function createSnapshot(kind: IssueLeaseSnapshot["kind"]): IssueLeaseSnapshot {
  return {
    kind,
    issueNumber: 163,
    lockDir: kind === "missing" ? null : "/tmp/.symphony-locks/163",
    ownerPid: kind === "missing" ? null : 1234,
    ownerAlive: kind === "missing" ? null : kind === "active" ? true : false,
    runnerPid:
      kind === "stale-owner-runner" || kind === "shutdown-forced" ? 5678 : null,
    runnerAlive:
      kind === "stale-owner-runner" || kind === "shutdown-forced" ? true : null,
    record: null,
  };
}

describe("restart recovery decision policy", () => {
  it("adopts healthy inherited ownership", () => {
    const issue = createIssue(163, "symphony:running");
    const decision = decideRestartRecovery({
      issue,
      branchName: "symphony/163",
      snapshot: createSnapshot("active"),
      lifecycle: null,
    });

    expect(decision.decision).toBe("adopted");
    expect(decision.shouldDispatch).toBe(false);
  });

  it("requeues stale inherited ownership when tracker is still executable", () => {
    const issue = createIssue(163, "symphony:running");
    const decision = decideRestartRecovery({
      issue,
      branchName: "symphony/163",
      snapshot: createSnapshot("stale-owner-runner"),
      lifecycle: createLifecycle("missing-target", "symphony/163"),
    });

    expect(decision.decision).toBe("requeued");
    expect(decision.shouldDispatch).toBe(true);
  });

  it("recovers intentional shutdown residue before re-dispatch", () => {
    const issue = createIssue(163, "symphony:running");
    const decision = decideRestartRecovery({
      issue,
      branchName: "symphony/163",
      snapshot: createSnapshot("shutdown-forced"),
      lifecycle: createLifecycle("missing-target", "symphony/163"),
    });

    expect(decision.decision).toBe("recovered-shutdown");
    expect(decision.shouldDispatch).toBe(true);
  });

  it("suppresses duplicate reruns when tracker handoff is already beyond execution", () => {
    const issue = createIssue(163, "symphony:running");
    const decision = decideRestartRecovery({
      issue,
      branchName: "symphony/163",
      snapshot: createSnapshot("stale-owner"),
      lifecycle: createLifecycle("awaiting-human-review", "symphony/163"),
    });

    expect(decision.decision).toBe("suppressed-terminal");
    expect(decision.lifecycleKind).toBe("awaiting-human-review");
    expect(decision.shouldDispatch).toBe(true);
  });
});
