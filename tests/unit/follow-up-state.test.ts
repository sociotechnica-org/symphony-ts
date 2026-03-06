import { describe, expect, it } from "vitest";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  clearFollowUpRuntimeState,
  createFollowUpRuntimeState,
  noteLifecycleObservation,
  noteRetryScheduled,
  resolveRunSequence,
} from "../../src/orchestrator/follow-up-state.js";

describe("follow-up-state", () => {
  it("keeps run sequence and follow-up budget separate", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(16);

    const first = noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-review", "symphony/16"),
      2,
    );

    expect(first.kind).toBe("continue");
    expect(first.followUpAttempt).toBeNull();
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);

    const second = noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("needs-follow-up", "symphony/16"),
      2,
    );

    expect(second.kind).toBe("continue");
    expect(second.followUpAttempt).toBe(1);
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(3);
  });

  it("exhausts only actionable follow-up retries", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(17);

    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-review", "symphony/17"),
      2,
    );

    const firstFollowUp = noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("needs-follow-up", "symphony/17"),
      2,
    );
    const secondFollowUp = noteLifecycleObservation(
      state,
      issue.number,
      3,
      createLifecycle("needs-follow-up", "symphony/17"),
      2,
    );

    expect(firstFollowUp.kind).toBe("continue");
    expect(secondFollowUp.kind).toBe("exhausted");
    expect(secondFollowUp.followUpAttempt).toBe(2);
  });

  it("creates retry state and clears issue follow-up state", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(18);
    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("needs-follow-up", "symphony/18"),
      3,
    );

    const retry = noteRetryScheduled(state, issue, 1, 10, "boom");

    expect(retry.issue.number).toBe(18);
    expect(retry.nextAttempt).toBe(2);
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);

    clearFollowUpRuntimeState(state, issue.number);

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(1);
  });

  it("persists the exhausted follow-up count for downstream handling", () => {
    const state = createFollowUpRuntimeState();

    const decision = noteLifecycleObservation(
      state,
      19,
      2,
      createLifecycle("needs-follow-up", "symphony/19"),
      1,
    );

    expect(decision.kind).toBe("exhausted");
    expect(state.followUpAttemptsByIssueNumber.get(19)).toBe(1);
  });
});
