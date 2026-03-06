import { describe, expect, it } from "vitest";
import {
  nextPollDelayMilliseconds,
  normalizeReviewThreads,
  summarizeChecks,
} from "../../skills/fix-ci/scripts/fix-ci-lib.mjs";

describe("fix-ci skill", () => {
  it("treats incomplete checks as pending", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "IN_PROGRESS",
        conclusion: "",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("pending");
    expect(summary.pending).toHaveLength(1);
  });

  it("treats failing completed checks as failure", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("failure");
    expect(summary.failed).toHaveLength(1);
  });

  it("keeps failed checks visible while other checks are still pending", () => {
    const summary = summarizeChecks([
      {
        name: "failed-check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/check/failed",
        workflowName: "CI",
      },
      {
        name: "pending-check",
        status: "IN_PROGRESS",
        conclusion: "",
        detailsUrl: "https://example.test/check/pending",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("pending");
    expect(summary.failed).toHaveLength(1);
  });

  it("treats unknown completed conclusions as failure", () => {
    const summary = summarizeChecks([
      {
        name: "weird-check",
        status: "COMPLETED",
        conclusion: "",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(summary.overall).toBe("failure");
    expect(summary.unknown).toHaveLength(1);
  });

  it("treats unresolved review threads as failure once checks are complete", () => {
    const summary = summarizeChecks(
      [
        {
          name: "check",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://example.test/check",
          workflowName: "CI",
        },
      ],
      [
        {
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                author: { login: "greptile-apps" },
                body: "Please fix this",
                path: "src/example.ts",
              },
            ],
          },
        },
      ],
    );

    expect(summary.overall).toBe("failure");
    expect(summary.unresolvedThreads).toHaveLength(1);
  });

  it("preserves review thread ids for later resolution", () => {
    const threads = normalizeReviewThreads([
      {
        id: "THREAD_123",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [],
        },
      },
    ]);

    expect(threads[0]?.id).toBe("THREAD_123");
  });

  it("treats successful completed checks as success", () => {
    const summary = summarizeChecks([
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
      {
        name: "Greptile Review",
        status: "COMPLETED",
        conclusion: "NEUTRAL",
        detailsUrl: "https://example.test/review",
        workflowName: "",
      },
    ]);

    expect(summary.overall).toBe("success");
    expect(summary.failed).toHaveLength(0);
  });

  it("caps the next poll delay at the remaining timeout", () => {
    const delay = nextPollDelayMilliseconds({
      startedAt: 1_000,
      now: 5_500,
      intervalSeconds: 15,
      timeoutSeconds: 6,
    });

    expect(delay).toBe(1_500);
  });
});
