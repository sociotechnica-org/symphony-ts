import { describe, expect, it } from "vitest";
import { resolveOperatorLoopConfig } from "../../src/config/operator-loop.js";

describe("operator loop config resolution", () => {
  it("builds a codex provider-template command when provider and model are selected", () => {
    const resolved = resolveOperatorLoopConfig({
      argv: ["--provider", "codex", "--model", "gpt-5.4-mini"],
      env: {},
    });

    expect(resolved.provider).toBe("codex");
    expect(resolved.model).toBe("gpt-5.4-mini");
    expect(resolved.commandSource).toBe("provider-template");
    expect(resolved.baseCommand).toContain("codex exec");
    expect(resolved.baseCommand).toContain("--model gpt-5.4-mini");
  });

  it("builds a claude provider-template command when claude is selected", () => {
    const resolved = resolveOperatorLoopConfig({
      argv: ["--provider", "claude"],
      env: {},
    });

    expect(resolved.provider).toBe("claude");
    expect(resolved.model).toBeNull();
    expect(resolved.commandSource).toBe("provider-template");
    expect(resolved.baseCommand).toContain("claude -p");
    expect(resolved.baseCommand).toContain("--output-format json");
  });

  it("lets explicit provider/model flags override SYMPHONY_OPERATOR_COMMAND", () => {
    const resolved = resolveOperatorLoopConfig({
      argv: ["--provider", "codex", "--model", "gpt-5.4-mini"],
      env: {
        SYMPHONY_OPERATOR_COMMAND:
          "claude -p --output-format json --permission-mode bypassPermissions --model sonnet",
      },
    });

    expect(resolved.provider).toBe("codex");
    expect(resolved.commandSource).toBe("provider-template");
    expect(resolved.baseCommand).toContain("gpt-5.4-mini");
    expect(resolved.baseCommand).not.toContain("claude");
  });

  it("uses a raw cli operator command as the highest-precedence escape hatch", () => {
    const resolved = resolveOperatorLoopConfig({
      argv: [
        "--operator-command",
        "claude -p --output-format json --permission-mode bypassPermissions --model sonnet",
      ],
      env: {
        SYMPHONY_OPERATOR_COMMAND:
          "codex exec --dangerously-bypass-approvals-and-sandbox -C . -",
      },
    });

    expect(resolved.provider).toBe("claude");
    expect(resolved.model).toBe("sonnet");
    expect(resolved.commandSource).toBe("cli-command");
    expect(resolved.baseCommand).toContain("claude -p");
  });

  it("rejects mixing the raw command escape hatch with model flags", () => {
    expect(() =>
      resolveOperatorLoopConfig({
        argv: [
          "--operator-command",
          "codex exec --dangerously-bypass-approvals-and-sandbox -C . -",
          "--model",
          "gpt-5.4-mini",
        ],
        env: {},
      }),
    ).toThrowError("--operator-command cannot be combined with --model");
  });
});
