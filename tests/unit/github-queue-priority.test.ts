import { describe, expect, it } from "vitest";
import { normalizeGitHubQueuePriority } from "../../src/tracker/github-queue-priority.js";

describe("normalizeGitHubQueuePriority", () => {
  it("normalizes numeric GitHub project field values into queue priority", () => {
    expect(
      normalizeGitHubQueuePriority(
        {
          kind: "number",
          value: 2,
        },
        {
          enabled: true,
          projectNumber: 7,
          fieldName: "Priority",
        },
      ),
    ).toEqual({
      rank: 2,
      label: "2",
    });
  });

  it("normalizes mapped single-select values into queue priority", () => {
    expect(
      normalizeGitHubQueuePriority(
        {
          kind: "single_select",
          value: "P1",
        },
        {
          enabled: true,
          projectNumber: 7,
          fieldName: "Priority",
          optionRankMap: {
            P0: 0,
            P1: 1,
          },
        },
      ),
    ).toEqual({
      rank: 1,
      label: "P1",
    });
  });

  it("falls back to null for unmapped or unsupported values", () => {
    expect(
      normalizeGitHubQueuePriority(
        {
          kind: "text",
          value: "urgent",
        },
        {
          enabled: true,
          projectNumber: 7,
          fieldName: "Priority",
        },
      ),
    ).toBeNull();
    expect(
      normalizeGitHubQueuePriority(
        {
          kind: "unsupported",
        },
        {
          enabled: true,
          projectNumber: 7,
          fieldName: "Priority",
        },
      ),
    ).toBeNull();
  });
});
