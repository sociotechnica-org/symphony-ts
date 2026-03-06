import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { LocalRunner } from "../../src/runner/local.js";

describe("LocalRunner", () => {
  it("handles a closed stdin pipe without crashing the process", async () => {
    const runner = new LocalRunner(
      {
        command:
          'node -e "process.stdin.destroy(); setTimeout(() => process.exit(0), 10)"',
        promptTransport: "stdin",
        timeoutMs: 5_000,
        env: {},
      },
      new JsonLogger(),
    );
    const session: RunSession = {
      id: "sociotechnica-org/symphony-ts#1/attempt-1",
      issue: {
        id: "1",
        identifier: "sociotechnica-org/symphony-ts#1",
        number: 1,
        title: "Runner stdin closes early",
        description: "",
        labels: [],
        state: "open",
        url: "https://example.test/issues/1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      workspace: {
        key: "sociotechnica-org_symphony-ts_1",
        issueId: "1",
        issueIdentifier: "sociotechnica-org/symphony-ts#1",
        path: process.cwd(),
        branchName: "symphony/1",
        createdNow: false,
      },
      prompt: "x".repeat(10_000_000),
      attempt: {
        sequence: 1,
      },
    };

    const result = await runner.run(session);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("stdin write failed");
  });
});
