import { describe, expect, it } from "vitest";
import { sanitizeTuiUseEnv } from "../support/tui-use.js";

describe("sanitizeTuiUseEnv", () => {
  it("removes inherited Node and Vitest env keys after the final merge", () => {
    const sanitized = sanitizeTuiUseEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/tui-use-home",
      NODE_OPTIONS: "--require vitest/hooks",
      NODE_ENV: "test",
      VITEST_POOL_ID: "7",
      __VITEST_WORKER__: "1",
      SYMPHONY_KEEP_ME: "present",
    });

    expect(sanitized["PATH"]).toBe("/usr/bin");
    expect(sanitized["HOME"]).toBe("/tmp/tui-use-home");
    expect(sanitized["SYMPHONY_KEEP_ME"]).toBe("present");
    expect(sanitized["NODE_OPTIONS"]).toBeUndefined();
    expect(sanitized["NODE_ENV"]).toBeUndefined();
    expect(sanitized["VITEST_POOL_ID"]).toBeUndefined();
    expect(sanitized["__VITEST_WORKER__"]).toBeUndefined();
  });
});
