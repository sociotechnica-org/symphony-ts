import { describe, expect, it } from "vitest";
import {
  compareQueuePriority,
  compareRuntimeIssuesByQueuePriority,
} from "../../src/domain/queue-priority.js";
import type { RuntimeIssue } from "../../src/domain/issue.js";

function createIssue(
  number: number,
  queuePriority: RuntimeIssue["queuePriority"] = null,
): RuntimeIssue {
  const timestamp = "2026-03-19T00:00:00.000Z";
  return {
    id: String(number),
    identifier: `sociotechnica-org/symphony-ts#${number}`,
    number,
    title: `Issue ${number}`,
    description: "",
    labels: ["symphony:ready"],
    state: "open",
    url: `https://example.test/issues/${number}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    queuePriority,
    blockedBy: [],
  };
}

describe("queue priority comparator", () => {
  it("prefers lower normalized ranks", () => {
    expect(
      compareQueuePriority({ rank: 1, label: "P1" }, { rank: 3, label: "P3" }),
    ).toBeLessThan(0);
  });

  it("sorts populated priority ahead of missing priority", () => {
    expect(compareQueuePriority({ rank: 2, label: "P2" }, null)).toBeLessThan(
      0,
    );
    expect(
      compareQueuePriority(undefined, { rank: 2, label: "P2" }),
    ).toBeGreaterThan(0);
  });

  it("falls back to issue number ordering when ranks are equal", () => {
    const lowerIssueNumber = createIssue(7, { rank: 2, label: "P2" });
    const higherIssueNumber = createIssue(11, { rank: 2, label: "Urgent" });

    expect(
      compareRuntimeIssuesByQueuePriority(lowerIssueNumber, higherIssueNumber),
    ).toBeLessThan(0);
  });

  it("falls back to issue number ordering when both priorities are missing", () => {
    expect(
      compareRuntimeIssuesByQueuePriority(createIssue(3), createIssue(9)),
    ).toBeLessThan(0);
  });
});
