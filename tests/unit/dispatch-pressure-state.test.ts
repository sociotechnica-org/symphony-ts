import { describe, expect, it } from "vitest";
import {
  activateDispatchPressure,
  clearDispatchPressure,
  createDispatchPressureState,
  getActiveDispatchPressure,
} from "../../src/orchestrator/dispatch-pressure-state.js";

describe("dispatch-pressure-state", () => {
  it("activates then extends provider pressure windows", () => {
    const state = createDispatchPressureState();
    const baseNow = Date.now();

    const activated = activateDispatchPressure(state, 1, {
      retryClass: "provider-rate-limit",
      reason: "429 Too Many Requests",
      observedAt: new Date(baseNow).toISOString(),
      resumeAt: baseNow + 60_000,
      rateLimits: null,
    });
    expect(activated.transition).toBe("activated");
    expect(activated.pressure.resumeAt).toBe(
      new Date(baseNow + 60_000).toISOString(),
    );

    const extended = activateDispatchPressure(state, 2, {
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: new Date(baseNow + 30_000).toISOString(),
      resumeAt: baseNow + 5 * 60_000,
      rateLimits: null,
    });
    expect(extended.transition).toBe("extended");
    expect(extended.pressure).toEqual({
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: new Date(baseNow + 30_000).toISOString(),
      resumeAt: new Date(baseNow + 5 * 60_000).toISOString(),
    });
  });

  it("treats expired pressure as inactive", () => {
    const state = createDispatchPressureState();
    activateDispatchPressure(state, 1, {
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

  it("retains other contributors when one pressure source clears", () => {
    const state = createDispatchPressureState();
    const baseNow = Date.now();
    activateDispatchPressure(state, 1, {
      retryClass: "provider-rate-limit",
      reason: "429 Too Many Requests",
      observedAt: new Date(baseNow).toISOString(),
      resumeAt: baseNow + 5 * 60_000,
      rateLimits: null,
    });
    activateDispatchPressure(state, 2, {
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: new Date(baseNow + 30_000).toISOString(),
      resumeAt: baseNow + 10 * 60_000,
      rateLimits: null,
    });

    clearDispatchPressure(state, 1);

    expect(getActiveDispatchPressure(state)).toEqual({
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached",
      observedAt: new Date(baseNow + 30_000).toISOString(),
      resumeAt: new Date(baseNow + 10 * 60_000).toISOString(),
    });
  });
});
