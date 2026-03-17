import { describe, expect, it } from "vitest";
import {
  activateDispatchPressure,
  createDispatchPressureState,
  getActiveDispatchPressure,
} from "../../src/orchestrator/dispatch-pressure-state.js";

describe("dispatch-pressure-state", () => {
  it("activates then extends provider pressure windows", () => {
    const state = createDispatchPressureState();

    const activated = activateDispatchPressure(state, {
      retryClass: "provider-rate-limit",
      reason: "429 Too Many Requests",
      observedAt: "2026-03-17T12:00:00.000Z",
      resumeAt: Date.parse("2026-03-17T12:01:00.000Z"),
      rateLimits: null,
    });
    expect(activated.transition).toBe("activated");
    expect(activated.pressure.resumeAt).toBe("2026-03-17T12:01:00.000Z");

    const extended = activateDispatchPressure(state, {
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: "2026-03-17T12:00:30.000Z",
      resumeAt: Date.parse("2026-03-17T12:05:00.000Z"),
      rateLimits: null,
    });
    expect(extended.transition).toBe("extended");
    expect(extended.pressure).toEqual({
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: "2026-03-17T12:00:30.000Z",
      resumeAt: "2026-03-17T12:05:00.000Z",
    });
  });

  it("treats expired pressure as inactive", () => {
    const state = createDispatchPressureState();
    activateDispatchPressure(state, {
      retryClass: "provider-rate-limit",
      reason: "429 Too Many Requests",
      observedAt: "2026-03-17T12:00:00.000Z",
      resumeAt: Date.parse("2026-03-17T12:00:05.000Z"),
      rateLimits: null,
    });

    expect(
      getActiveDispatchPressure(state, Date.parse("2026-03-17T12:00:04.000Z")),
    ).not.toBeNull();
    expect(
      getActiveDispatchPressure(state, Date.parse("2026-03-17T12:00:05.000Z")),
    ).toBeNull();
  });
});
