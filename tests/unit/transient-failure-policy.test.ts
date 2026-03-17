import { describe, expect, it } from "vitest";
import { classifyTransientFailure } from "../../src/orchestrator/transient-failure-policy.js";
import {
  extractRateLimitsSnapshot,
  extractTransientFailureSignal,
} from "../../src/runner/transient-failure.js";

describe("transient failure parsing and policy", () => {
  it("extracts provider rate-limit snapshots from runner updates", () => {
    const update = {
      event: "account/rateLimits/updated",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          rateLimits: {
            limitId: "core",
            primary: {
              used: 10,
              limit: 100,
              resetInMs: 45_000,
            },
            secondary: {
              used: 1,
              limit: 10,
              resetInMs: 5_000,
            },
            credits: "$8.00",
          },
        },
      },
    } as const;

    expect(extractRateLimitsSnapshot(update)).toEqual({
      limitId: "core",
      primary: {
        used: 10,
        limit: 100,
        resetInMs: 45_000,
      },
      secondary: {
        used: 1,
        limit: 10,
        resetInMs: 5_000,
      },
      credits: "$8.00",
    });
    expect(extractTransientFailureSignal(update)).toBeNull();
  });

  it("treats exhausted rate-limit snapshots as provider pressure", () => {
    const update = {
      event: "account/rateLimits/updated",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          rateLimits: {
            limitId: "core",
            primary: {
              used: 100,
              limit: 100,
              resetInMs: 45_000,
            },
            secondary: {
              used: 1,
              limit: 10,
              resetInMs: 5_000,
            },
            credits: "$8.00",
          },
        },
      },
    } as const;

    expect(extractTransientFailureSignal(update)).toEqual({
      retryClass: "provider-rate-limit",
      reason: "Provider rate-limit pressure is active.",
      observedAt: "2026-03-17T12:00:00.000Z",
      resumeAt: Date.parse("2026-03-17T12:00:45.000Z"),
      rateLimits: {
        limitId: "core",
        primary: {
          used: 100,
          limit: 100,
          resetInMs: 45_000,
        },
        secondary: {
          used: 1,
          limit: 10,
          resetInMs: 5_000,
        },
        credits: "$8.00",
      },
    });
  });

  it("derives resumeAt from exhausted buckets only", () => {
    const update = {
      event: "account/rateLimits/updated",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          rateLimits: {
            limitId: "core",
            primary: {
              used: 100,
              limit: 100,
              resetInMs: 45_000,
            },
            secondary: {
              used: 1,
              limit: 10,
              resetInMs: 90_000,
            },
          },
        },
      },
    } as const;

    expect(extractTransientFailureSignal(update)).toEqual({
      retryClass: "provider-rate-limit",
      reason: "Provider rate-limit pressure is active.",
      observedAt: "2026-03-17T12:00:00.000Z",
      resumeAt: Date.parse("2026-03-17T12:00:45.000Z"),
      rateLimits: {
        limitId: "core",
        primary: {
          used: 100,
          limit: 100,
          resetInMs: 45_000,
        },
        secondary: {
          used: 1,
          limit: 10,
          resetInMs: 90_000,
        },
        credits: null,
      },
    });
  });

  it("does not classify unrelated auth errors as account pressure", () => {
    const update = {
      event: "turn/failed",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          error: {
            message: "git auth failed for remote origin",
          },
        },
      },
    } as const;

    expect(extractTransientFailureSignal(update)).toBeNull();
  });

  it("does not classify git authentication required failures as account pressure", () => {
    const update = {
      event: "turn/failed",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          error: {
            message: "fatal: Authentication required",
          },
        },
      },
    } as const;

    expect(extractTransientFailureSignal(update)).toBeNull();
  });

  it("does not classify billing-feature failures as account pressure", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\ntest failed: billing address validator",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message: "Runner exited with 1\ntest failed: billing address validator",
      dispatchPressure: null,
    });
  });

  it("does not classify generic credit-domain failures as account pressure", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\ntest failed: credit card validator",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message: "Runner exited with 1\ntest failed: credit card validator",
      dispatchPressure: null,
    });
  });

  it("extracts account pressure from error-bearing runner updates", () => {
    const update = {
      event: "turn/failed",
      timestamp: "2026-03-17T12:00:00.000Z",
      payload: {
        params: {
          error: {
            message: "Billing hard limit reached for this account",
          },
        },
      },
    } as const;

    expect(extractTransientFailureSignal(update)).toEqual({
      retryClass: "provider-account-pressure",
      reason: "Billing hard limit reached for this account",
      observedAt: "2026-03-17T12:00:00.000Z",
      resumeAt: null,
      rateLimits: null,
    });
  });

  it("classifies message-only rate limits when no structured signal was captured", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\nHTTP 429 rate limit exceeded",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "provider-rate-limit",
      message: "Runner exited with 1\nHTTP 429 rate limit exceeded",
      dispatchPressure: {
        retryClass: "provider-rate-limit",
        reason: "Runner exited with 1\nHTTP 429 rate limit exceeded",
        observedAt: "2026-03-17T12:00:00.000Z",
        resumeAt: "2026-03-17T12:00:05.000Z",
      },
    });
  });

  it("does not classify unrelated 429 references as provider rate limits", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\nline 429: command not found",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message: "Runner exited with 1\nline 429: command not found",
      dispatchPressure: null,
    });
  });

  it("does not classify throttle-domain stderr as provider rate limits", () => {
    expect(
      classifyTransientFailure({
        message:
          "Runner exited with 1\ntest failed: throttle component not rendering",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message:
        "Runner exited with 1\ntest failed: throttle component not rendering",
      dispatchPressure: null,
    });
  });

  it("still classifies provider-style throttling messages in fallback mode", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\nrequest was throttled by the provider",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "provider-rate-limit",
      message: "Runner exited with 1\nrequest was throttled by the provider",
      dispatchPressure: {
        retryClass: "provider-rate-limit",
        reason: "Runner exited with 1\nrequest was throttled by the provider",
        observedAt: "2026-03-17T12:00:00.000Z",
        resumeAt: "2026-03-17T12:00:05.000Z",
      },
    });
  });

  it("does not classify generic account issue strings as provider account pressure", () => {
    expect(
      classifyTransientFailure({
        message:
          "Runner exited with 1\ntest failed: account issue creation returned 500",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message:
        "Runner exited with 1\ntest failed: account issue creation returned 500",
      dispatchPressure: null,
    });
  });

  it("keeps ordinary transient runner failures out of dispatch pause posture", () => {
    expect(
      classifyTransientFailure({
        message: "Runner exited with 1\nsegmentation fault",
        signal: null,
        observedAt: "2026-03-17T12:00:00.000Z",
        backoffMs: 5_000,
      }),
    ).toEqual({
      retryClass: "run-failure",
      message: "Runner exited with 1\nsegmentation fault",
      dispatchPressure: null,
    });
  });
});
