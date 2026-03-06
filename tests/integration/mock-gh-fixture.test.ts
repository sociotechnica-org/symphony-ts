import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockGitHubServer } from "../support/mock-github-server.js";

const execFileAsync = promisify(execFile);

describe("mock gh fixture", () => {
  let server: MockGitHubServer;

  beforeEach(async () => {
    server = new MockGitHubServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("escapes JSON payload fields when creating pull requests", async () => {
    await execFileAsync(
      "tests/fixtures/gh",
      [
        "pr",
        "create",
        "--title",
        'Title with "quotes"',
        "--body",
        'Body with "quotes" and \\slashes\\',
        "--head",
        "symphony/1",
        "--base",
        "main",
      ],
      {
        env: {
          ...process.env,
          MOCK_GITHUB_API_URL: server.baseUrl,
        },
      },
    );

    expect(server.getPullRequests()).toEqual([
      {
        title: 'Title with "quotes"',
        body: 'Body with "quotes" and \\slashes\\',
        head: "symphony/1",
        base: "main",
      },
    ]);
  });
});
