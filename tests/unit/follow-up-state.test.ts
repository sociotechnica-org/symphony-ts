import { describe, expect, it } from "vitest";
import { createIssue, createLifecycle } from "../support/pull-request.js";
import {
  clearFollowUpRuntimeState,
  createFollowUpRuntimeState,
  noteLifecycleObservation,
  resolveRunSequence,
} from "../../src/orchestrator/follow-up-state.js";

describe("follow-up-state", () => {
  it("keeps lifecycle-driven run sequence separate from failure retries", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(16);

    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("awaiting-system-checks", "symphony/16"),
    );

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);

    noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("rework-required", "symphony/16"),
    );

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

    noteLifecycleObservation(
      state,
      issue.number,
      2,
      createLifecycle("rework-required", "symphony/17"),
    );
    noteLifecycleObservation(
      state,
      issue.number,
      3,
      createLifecycle("rework-required", "symphony/17"),
    );

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(4);
  });

  it("clears issue run-sequence state", () => {
    const state = createFollowUpRuntimeState();
    const issue = createIssue(18);
    noteLifecycleObservation(
      state,
      issue.number,
      1,
      createLifecycle("rework-required", "symphony/18"),
    );
    expect(resolveRunSequence(state, issue.number, new Map())).toBe(2);

    clearFollowUpRuntimeState(state, issue.number);

    expect(resolveRunSequence(state, issue.number, new Map())).toBe(1);
  });
});
