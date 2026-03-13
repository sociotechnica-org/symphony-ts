import { describe, expect, it } from "vitest";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  clearFollowUpRuntimeState,
  createFollowUpRuntimeState,
  noteLifecycleObservation,
  noteRetryScheduled,
  resolveFailureRetryAttempt,
  resolveRunSequence,
} from "../../src/orchestrator/follow-up-state.js";

describe("follow-up-state", () => {
  it("keeps run sequence and continuation reason separate from failure retries", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(16);

    const first = noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-system-checks", "symphony/16"),
    );

    expect(first.continuationReason).toBe("waiting-system-checks");
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);

    const second = noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("rework-required", "symphony/16"),
    );

    expect(second.continuationReason).toBe("rework");
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(3);
  });

  it("keeps repeated rework loops active without exhausting a review budget", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(17);

    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-system-checks", "symphony/17"),
    );

    const firstFollowUp = noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("rework-required", "symphony/17"),
    );
    const secondFollowUp = noteLifecycleObservation(
      state,
      issue.number,
      3,
      createLifecycle("rework-required", "symphony/17"),
    );

    expect(firstFollowUp.continuationReason).toBe("rework");
    expect(secondFollowUp.continuationReason).toBe("rework");
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(4);
  });

  it("creates retry state and clears issue follow-up state", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(18);
    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("rework-required", "symphony/18"),
    );

    const retry = noteRetryScheduled(state, issue, 1, 1, 10, "boom");

    expect(retry.issue.number).toBe(18);
    expect(retry.nextAttempt).toBe(2);
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(2);

    clearFollowUpRuntimeState(state, issue.number);

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(1);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(1);
  });

  it("stores explicit waiting and rework continuation reasons", () => {
    const state = createFollowUpRuntimeState();

    expect(
      noteLifecycleObservation(
        state,
        19,
        1,
        createLifecycle("awaiting-human-review", "symphony/19"),
      ).continuationReason,
    ).toBe("waiting-human-review");
    expect(state.activeContinuationByIssueNumber.get(19)).toBe(
      "waiting-human-review",
    );
    expect(
      noteLifecycleObservation(
        state,
        19,
        2,
        createLifecycle("rework-required", "symphony/19"),
      ).continuationReason,
    ).toBe("rework");
    expect(state.activeContinuationByIssueNumber.get(19)).toBe("rework");
  });

  it("keeps failure retry attempts separate from run sequence", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(20);

    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-system-checks", "symphony/20"),
    );
    noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("rework-required", "symphony/20"),
    );

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(3);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(1);

    noteRetryScheduled(state, issue, 3, 1, 10, "boom");

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(4);
    expect(resolveFailureRetryAttempt(state, issue.number)).toBe(2);
  });
});
