import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReportCli } from "../../src/cli/report.js";
import { readIssueArtifactEvents } from "../../src/observability/issue-artifacts.js";
import { MockGitHubServer } from "../support/mock-github-server.js";
import { createTempDir } from "../support/git.js";
import {
  seedSuccessfulIssueArtifacts,
  writeReportWorkflow,
} from "../support/issue-report-fixtures.js";

const tempRoots: string[] = [];

describe("report review CLI", () => {
  let server: MockGitHubServer;
  let originalPath: string | undefined;
  let originalMockApi: string | undefined;
  let originalGhToken: string | undefined;

  beforeEach(async () => {
    server = new MockGitHubServer();
    await server.start();
    originalPath = process.env.PATH;
    originalMockApi = process.env.MOCK_GITHUB_API_URL;
    originalGhToken = process.env.GH_TOKEN;
    process.env.PATH = `${path.resolve("tests/fixtures")}${path.delimiter}${originalPath ?? ""}`;
    process.env.MOCK_GITHUB_API_URL = server.baseUrl;
    process.env.GH_TOKEN = "test-token";
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalMockApi === undefined) {
      delete process.env.MOCK_GITHUB_API_URL;
    } else {
      process.env.MOCK_GITHUB_API_URL = originalMockApi;
    }
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
    vi.restoreAllMocks();
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
    await server.stop();
  });

  it("lists pending completed-run report reviews and creates follow-up issues from findings", async () => {
    const instanceRoot = await createTempDir("symphony-report-review-cli-");
    tempRoots.push(instanceRoot);
    const workflowPath = await writeReportWorkflow(instanceRoot);
    await seedSuccessfulIssueArtifacts(
      path.join(instanceRoot, ".tmp", "workspaces"),
      44,
    );

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await runReportCli([
      "node",
      "symphony-report",
      "review-pending",
      "--workflow",
      workflowPath,
      "--operator-repo-root",
      instanceRoot,
      "--json",
    ]);

    const pendingPayload = JSON.parse(stdout.join("")) as {
      readonly reviewStateFile: string;
      readonly pending: Array<{
        readonly issueNumber: number;
        readonly status: string;
      }>;
    };
    expect(pendingPayload.pending).toEqual([
      expect.objectContaining({
        issueNumber: 44,
        status: "report-ready",
      }),
    ]);

    stdout.length = 0;
    await runReportCli([
      "node",
      "symphony-report",
      "review-follow-up",
      "--workflow",
      workflowPath,
      "--operator-repo-root",
      instanceRoot,
      "--issue",
      "44",
      "--title",
      "Capture missing merge and close facts in issue reports",
      "--body",
      "Report review for #44 found missing merge/close lifecycle facts in the generated issue report.",
      "--summary",
      "Filed a follow-up issue for missing merge/close lifecycle facts.",
      "--finding-key",
      "missing-merge-close-facts",
    ]);

    const issues = server.listIssues();
    expect(issues.at(-1)).toMatchObject({
      title: "Capture missing merge and close facts in issue reports",
      body: "Report review for #44 found missing merge/close lifecycle facts in the generated issue report.",
      state: "open",
    });
    await expect(
      fs.readFile(pendingPayload.reviewStateFile, "utf8"),
    ).resolves.toContain('"status": "reviewed-follow-up-filed"');
    await expect(
      fs.readFile(pendingPayload.reviewStateFile, "utf8"),
    ).resolves.toContain('"findingKey": "missing-merge-close-facts"');

    const events = await readIssueArtifactEvents(
      path.join(instanceRoot, ".tmp", "workspaces"),
      44,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "report-follow-up-filed",
          details: expect.objectContaining({
            command: "review-follow-up",
            source: "operator-cli",
            followUpIssueNumber: issues.at(-1)?.number,
          }),
        }),
      ]),
    );
  });
});
