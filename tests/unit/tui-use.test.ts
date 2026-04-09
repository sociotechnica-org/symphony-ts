import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetTuiUseStateForTests,
  resolveNodePtyRoot,
  resolveTuiUseSessionModulePath,
  sanitizeTuiUseEnv,
  setTuiUseSessionConstructorForTests,
  TuiUseHarness,
  type TuiUseHighlight,
} from "../support/tui-use.js";

class FakeSession {
  status: "running" | "exited" = "running";
  exitCode: number | null = null;
  readonly cols = 140;
  readonly rows = 40;
  #screen = "running screen";
  #waitCalls = 0;

  constructor(
    _id: string,
    _command: string,
    _options: {
      readonly cwd?: string;
      readonly label?: string;
      readonly cols?: number;
      readonly rows?: number;
    },
  ) {}

  snapshot() {
    return {
      lines: [this.#screen],
      cursor: { x: 0, y: 0 },
      changed: this.#waitCalls > 0,
      highlights: [] satisfies readonly TuiUseHighlight[],
      title: "",
      is_fullscreen: false,
    };
  }

  async wait(): Promise<{
    readonly lines: readonly string[];
    readonly cursor: {
      readonly x: number;
      readonly y: number;
    };
    readonly changed: boolean;
    readonly highlights: readonly TuiUseHighlight[];
    readonly title: string;
    readonly is_fullscreen: boolean;
  }> {
    this.#waitCalls += 1;
    this.status = "exited";
    this.exitCode = 0;
    this.#screen = "exited screen";
    throw new Error("session exited");
  }

  press() {}

  kill() {
    this.status = "exited";
    this.exitCode = 0;
  }
}

class EnvCapturingSession {
  static lastEnv: NodeJS.ProcessEnv | null = null;

  status: "running" | "exited" = "running";
  exitCode: number | null = null;
  readonly cols = 140;
  readonly rows = 40;

  constructor(
    _id: string,
    _command: string,
    _options: {
      readonly cwd?: string;
      readonly label?: string;
      readonly cols?: number;
      readonly rows?: number;
    },
  ) {
    EnvCapturingSession.lastEnv = { ...process.env };
  }

  snapshot() {
    return {
      lines: [""],
      cursor: { x: 0, y: 0 },
      changed: false,
      highlights: [] satisfies readonly TuiUseHighlight[],
      title: "",
      is_fullscreen: false,
    };
  }

  async wait() {
    return this.snapshot();
  }

  press() {}

  kill() {
    this.status = "exited";
    this.exitCode = 0;
  }
}

afterEach(() => {
  resetTuiUseStateForTests();
  EnvCapturingSession.lastEnv = null;
});

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

describe("tui-use module resolution", () => {
  it("resolves node-pty from the installed dependency graph", () => {
    const nodePtyRoot = resolveNodePtyRoot();

    expect(path.basename(nodePtyRoot)).toBe("node-pty");
    expect(existsSync(path.join(nodePtyRoot, "package.json"))).toBe(true);
  });

  it("resolves the installed tui-use session module", () => {
    const sessionModulePath = resolveTuiUseSessionModulePath();

    expect(
      sessionModulePath.endsWith(path.join("tui-use", "dist", "session.js")),
    ).toBe(true);
    expect(existsSync(sessionModulePath)).toBe(true);
  });
});

describe("TuiUseHarness.waitForSnapshot", () => {
  it("rechecks snapshot state after waitForChange rejects on session exit", async () => {
    setTuiUseSessionConstructorForTests(FakeSession);
    const harness = new TuiUseHarness({
      cwd: os.tmpdir(),
      homeDir: path.join(os.tmpdir(), "tui-use-test-home"),
    });

    await harness.start("fake-command");

    await expect(
      harness.waitForSnapshot((snapshot) => snapshot.status === "exited", {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        description: "session exit",
      }),
    ).resolves.toMatchObject({
      status: "exited",
      exit_code: 0,
      screen: "exited screen",
    });
  });
});

describe("TuiUseHarness env", () => {
  it("treats an explicit env as authoritative so deleted keys stay deleted", async () => {
    setTuiUseSessionConstructorForTests(EnvCapturingSession);
    const originalRepo = process.env["SYMPHONY_REPO"];
    process.env["SYMPHONY_REPO"] = "should-not-leak";

    try {
      const harness = new TuiUseHarness({
        cwd: os.tmpdir(),
        homeDir: path.join(os.tmpdir(), "tui-use-test-home"),
        env: {
          PATH: "/usr/bin",
          NODE_OPTIONS: "--require vitest/hooks",
          VITEST_POOL_ID: "7",
          SYMPHONY_KEEP_ME: "present",
        },
      });

      await harness.start("fake-command");

      expect(EnvCapturingSession.lastEnv?.["PATH"]).toBe("/usr/bin");
      expect(EnvCapturingSession.lastEnv?.["SYMPHONY_KEEP_ME"]).toBe("present");
      expect(EnvCapturingSession.lastEnv?.["NODE_OPTIONS"]).toBeUndefined();
      expect(EnvCapturingSession.lastEnv?.["VITEST_POOL_ID"]).toBeUndefined();
      expect(EnvCapturingSession.lastEnv?.["SYMPHONY_REPO"]).toBeUndefined();
    } finally {
      if (originalRepo === undefined) {
        delete process.env["SYMPHONY_REPO"];
      } else {
        process.env["SYMPHONY_REPO"] = originalRepo;
      }
    }
  });
});
