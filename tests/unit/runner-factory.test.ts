import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../../src/domain/workflow.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { createRunner } from "../../src/runner/factory.js";
import { GenericCommandRunner } from "../../src/runner/generic-command.js";

function createAgentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    runner: {
      kind: "codex",
    },
    command: "codex exec -",
    promptTransport: "stdin",
    timeoutMs: 1_000,
    maxTurns: 1,
    env: {},
    ...overrides,
  };
}

describe("createRunner", () => {
  it("returns a CodexRunner for codex workflow config", () => {
    const runner = createRunner(createAgentConfig({}), new JsonLogger());

    expect(runner).toBeInstanceOf(CodexRunner);
  });

  it("returns a GenericCommandRunner for generic command workflow config", () => {
    const runner = createRunner(
      createAgentConfig({
        runner: {
          kind: "generic-command",
        },
        command: "claude --print",
      }),
      new JsonLogger(),
    );

    expect(runner).toBeInstanceOf(GenericCommandRunner);
  });

  it("returns a ClaudeCodeRunner for claude-code workflow config", () => {
    const runner = createRunner(
      createAgentConfig({
        runner: {
          kind: "claude-code",
        },
        command:
          "claude -p --output-format json --permission-mode bypassPermissions",
      }),
      new JsonLogger(),
    );

    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
  });
});
