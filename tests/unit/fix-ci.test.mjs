import { describe, expect, it } from "vitest";
import {
  fetchReviewThreads,
  parseRepo,
  nextPollDelayMilliseconds,
  normalizeChecks,
  normalizeReviewThreads,
  summarizeChecks,
  validateRepoName,
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

  it("preserves thread comment details when passed pre-normalized threads", () => {
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
          id: "THREAD_123",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              authorLogin: "greptile-apps",
              body: "Please fix this",
              path: "src/example.ts",
            },
          ],
        },
      ],
    );

    expect(summary.overall).toBe("failure");
    expect(summary.unresolvedThreads[0]?.comments[0]?.authorLogin).toBe(
      "greptile-apps",
    );
    expect(summary.unresolvedThreads[0]?.comments[0]?.path).toBe(
      "src/example.ts",
    );
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

  it("validates repo names in owner/name form", () => {
    expect(validateRepoName("sociotechnica-org/symphony-ts")).toBe(
      "sociotechnica-org/symphony-ts",
    );
    expect(() => validateRepoName("badformat")).toThrow(
      "Repo must be in owner/name form",
    );
  });

  it("parses validated repo names", () => {
    expect(parseRepo("sociotechnica-org/symphony-ts")).toEqual({
      owner: "sociotechnica-org",
      name: "symphony-ts",
    });
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

  it("normalizes missing check names to empty strings", () => {
    const checks = normalizeChecks([
      {
        name: null,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/check",
        workflowName: "CI",
      },
    ]);

    expect(checks[0]?.name).toBe("");
  });

  it("fetches review threads across multiple pages", async () => {
    const responses = [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: "CURSOR_1",
                  },
                  nodes: [
                    {
                      id: "THREAD_1",
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [] },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: "CURSOR_2",
                  },
                  nodes: [
                    {
                      id: "THREAD_2",
                      isResolved: true,
                      isOutdated: false,
                      comments: { nodes: [] },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
    ];
    const calls = [];
    const execFileAsync = async (_command, args) => {
      calls.push(args);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected extra fetch");
      }
      return response;
    };

    const threads = await fetchReviewThreads(
      20,
      "sociotechnica-org/symphony-ts",
      execFileAsync,
    );

    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.id)).toEqual([
      "THREAD_1",
      "THREAD_2",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("after=CURSOR_1");
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
