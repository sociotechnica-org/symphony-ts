import { describe, expect, it } from "vitest";
import {
  createRunningEntry,
  integrateCodexUpdate,
  normalizeEventName,
} from "../../src/orchestrator/running-entry.js";

describe("normalizeEventName", () => {
  it("maps underscore-style events to canonical slash form", () => {
    expect(normalizeEventName("turn_completed")).toBe("turn/completed");
    expect(normalizeEventName("turn_failed")).toBe("turn/failed");
    expect(normalizeEventName("turn_cancelled")).toBe("turn/cancelled");
    expect(normalizeEventName("session_started")).toBe("session/started");
  });

  it("passes through slash-style and unknown events unchanged", () => {
    expect(normalizeEventName("turn/completed")).toBe("turn/completed");
    expect(normalizeEventName("codex/event/token_count")).toBe(
      "codex/event/token_count",
    );
    expect(normalizeEventName("unknown_event")).toBe("unknown_event");
  });
});

describe("integrateCodexUpdate", () => {
  it("increments turnCount for slash-style completed events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    expect(entry.codexTokenState).toBe("pending");

    integrateCodexUpdate(entry, {
      event: "turn/completed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(entry.turnCount).toBe(1);
  });

  it("increments turnCount for underscore-style completed events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "turn_completed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(entry.turnCount).toBe(1);
  });

  it("stores normalized event name in lastCodexEvent", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "turn_completed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(entry.lastCodexEvent).toBe("turn/completed");
  });

  it("extracts tokens from nested Codex JSON-RPC payload", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    const result = integrateCodexUpdate(entry, {
      event: "reasoning",
      payload: {
        method: "notifications/message",
        params: {
          msg: {
            payload: {
              type: "reasoning",
              text: "Analyzing...",
              total_token_usage: {
                input_tokens: 800,
                output_tokens: 400,
                total_tokens: 1200,
              },
            },
          },
        },
      },
      timestamp: new Date().toISOString(),
    });

    expect(result.tokenDelta.inputTokens).toBe(800);
    expect(result.tokenDelta.outputTokens).toBe(400);
    expect(result.tokenDelta.totalTokens).toBe(1200);
    expect(entry.codexInputTokens).toBe(800);
    expect(entry.codexOutputTokens).toBe(400);
    expect(entry.codexTotalTokens).toBe(1200);
    expect(entry.codexTokenState).toBe("observed");
  });

  it("extracts tokens from top-level Codex event_msg payloads", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    const result = integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 123,
              output_tokens: 45,
              total_tokens: 168,
            },
          },
        },
      },
      timestamp: new Date().toISOString(),
    });

    expect(result.tokenDelta).toEqual({
      costUsd: 0,
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
    });
    expect(entry.codexInputTokens).toBe(123);
    expect(entry.codexOutputTokens).toBe(45);
    expect(entry.codexTotalTokens).toBe(168);
    expect(entry.codexTokenState).toBe("observed");
  });

  it("extracts session ID from nested Codex JSON-RPC payload", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "codex/event/session.start",
      payload: {
        method: "notifications/message",
        params: {
          msg: {
            payload: {
              type: "session.start",
              session_id: "smoke-sess-001",
            },
          },
        },
      },
      timestamp: new Date().toISOString(),
    });

    expect(entry.sessionId).toBe("smoke-sess-001");
  });

  it("never decreases token high-water marks", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    // First report: set baseline
    integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      timestamp: new Date().toISOString(),
    });
    expect(entry.codexInputTokens).toBe(100);
    expect(entry.codexLastReportedInputTokens).toBe(100);

    // Second report: lower value (API quirk) — high-water mark should not decrease
    integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { input_tokens: 80, output_tokens: 50, total_tokens: 130 },
      timestamp: new Date().toISOString(),
    });
    // Delta is clamped to 0, so running total stays at 100
    expect(entry.codexInputTokens).toBe(100);
    // High-water mark stays at 100, not lowered to 80
    expect(entry.codexLastReportedInputTokens).toBe(100);

    // Third report: normal increase from 120 — delta computed against stable high-water mark
    integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { input_tokens: 120, output_tokens: 60, total_tokens: 180 },
      timestamp: new Date().toISOString(),
    });
    expect(entry.codexInputTokens).toBe(120); // 100 + (120 - 100)
    expect(entry.codexLastReportedInputTokens).toBe(120);
  });

  it("keeps pending token state across non-token events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "thread/started",
      payload: {
        method: "thread/started",
        params: { thread: { id: "thread-live-123" } },
      },
      timestamp: new Date().toISOString(),
    });

    expect(entry.codexTokenState).toBe("pending");
    expect(entry.codexTotalTokens).toBe(0);
  });

  it("does not regress from observed back to pending on later non-token events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      timestamp: new Date().toISOString(),
    });
    integrateCodexUpdate(entry, {
      event: "thread/started",
      payload: {
        method: "thread/started",
        params: { thread: { id: "thread-live-123" } },
      },
      timestamp: new Date().toISOString(),
    });

    expect(entry.codexTokenState).toBe("observed");
    expect(entry.codexTotalTokens).toBe(150);
  });

  it("keeps token state pending for cost-only accounting events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    const result = integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { cost_usd: 1.25 },
      timestamp: new Date().toISOString(),
    });

    expect(result.tokenDelta).toEqual({
      costUsd: 1.25,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(entry.accounting).toEqual({
      status: "partial",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: 1.25,
    });
    expect(entry.codexTokenState).toBe("pending");
    expect(entry.codexTotalTokens).toBe(0);
  });

  it("preserves per-field token nullability across later non-token events", () => {
    const entry = createRunningEntry(99, "issue-99", "open", 1);

    integrateCodexUpdate(entry, {
      event: "codex/event/token_count",
      payload: { input_tokens: 100 },
      timestamp: new Date().toISOString(),
    });
    integrateCodexUpdate(entry, {
      event: "thread/started",
      payload: {
        method: "thread/started",
        params: { thread: { id: "thread-live-123" } },
      },
      timestamp: new Date().toISOString(),
    });

    expect(entry.accounting).toEqual({
      status: "partial",
      inputTokens: 100,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
    expect(entry.codexTokenState).toBe("observed");
  });
});
