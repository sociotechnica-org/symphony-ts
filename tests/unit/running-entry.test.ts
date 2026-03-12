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
});
