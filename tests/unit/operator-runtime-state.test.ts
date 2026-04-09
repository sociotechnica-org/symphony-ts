import { describe, expect, it } from "vitest";
import {
  assertOperatorRuntimeTransition,
  canTransitionOperatorRuntimeState,
} from "../../src/operator/state-machine.js";

describe("operator runtime state machine", () => {
  it("allows the documented success path through one wake-up cycle", () => {
    expect(
      canTransitionOperatorRuntimeState({
        from: "bootstrapping",
        to: "acquiring-loop-lock",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "acquiring-loop-lock",
        to: "preparing-cycle",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "preparing-cycle",
        to: "acquiring-active-lease",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "acquiring-active-lease",
        to: "running-command",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "running-command",
        to: "post-cycle-refresh",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "post-cycle-refresh",
        to: "recording-success",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "recording-success",
        to: "sleeping",
      }),
    ).toBe(true);
  });

  it("allows the failure and stop paths called out in the plan", () => {
    expect(
      canTransitionOperatorRuntimeState({
        from: "acquiring-active-lease",
        to: "recording-failure",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "recording-failure",
        to: "retrying",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "retrying",
        to: "preparing-cycle",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "running-command",
        to: "stopping",
      }),
    ).toBe(true);
    expect(
      canTransitionOperatorRuntimeState({
        from: "stopping",
        to: "stopped",
      }),
    ).toBe(true);
  });

  it("rejects invalid jumps that would skip the explicit cycle checkpoints", () => {
    expect(() =>
      assertOperatorRuntimeTransition({
        from: "bootstrapping",
        to: "running-command",
      }),
    ).toThrow("invalid runtime state transition");
    expect(() =>
      assertOperatorRuntimeTransition({
        from: "sleeping",
        to: "recording-success",
      }),
    ).toThrow("invalid runtime state transition");
    expect(() =>
      assertOperatorRuntimeTransition({
        from: "stopped",
        to: "bootstrapping",
      }),
    ).toThrow("invalid runtime state transition");
  });
});
