import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryControlStatusSnapshot } from "../../src/cli/factory-control.js";
import { FACTORY_ATTACH_MACOS_HELPER_SOURCE } from "../../src/cli/factory-attach-macos-helper-source.js";
import {
  attachFactory,
  createFactoryAttachLaunchEnvironment,
  createFactoryAttachLaunchSpec,
  resolveAttachSession,
  selectFactoryAttachTerm,
  type FactoryAttachChild,
  type FactoryAttachTerminal,
} from "../../src/cli/factory-attach.js";

class MockStream extends EventEmitter {
  isTTY = true;
  readonly writes: Array<string | Uint8Array> = [];

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(chunk);
    return true;
  }
}

class MockInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = false;
  paused = false;

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {
    this.resumed = true;
  }

  pause(): void {
    this.paused = true;
  }
}

class MockAttachChild extends EventEmitter implements FactoryAttachChild {
  readonly stdin = new MockStream();
  readonly stdout = new MockStream();
  readonly stderr = new MockStream();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  pid: number | undefined = 4242;

  async waitForExit(): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }> {
    return await new Promise((resolve) => {
      this.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        resolve({ code, signal }),
      );
      this.once("error", (error: Error) => {
        throw error;
      });
    });
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
    this.emit("exit", null, signal ?? null);
  }
}

function createSnapshot(
  controlState: "running" | "stopped" | "degraded" = "running",
): FactoryControlStatusSnapshot {
  return {
    controlState,
    paths: {
      repoRoot: "/repo",
      runtimeRoot: "/repo/.tmp/factory-main",
      workflowPath: "/repo/WORKFLOW.md",
      statusFilePath: "/repo/.tmp/status.json",
      startupFilePath: "/repo/.tmp/startup.json",
    },
    sessionName: "symphony-factory-instance",
    factoryHalt: {
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    },
    sessions:
      controlState === "running"
        ? [
            {
              id: "1234.symphony-factory-instance",
              pid: 1234,
              name: "symphony-factory-instance",
              state: "Detached",
            },
          ]
        : [],
    workerAlive: controlState === "running",
    startup: null,
    snapshotFreshness: {
      freshness: controlState === "running" ? "fresh" : "unavailable",
      reason:
        controlState === "running" ? "current-snapshot" : "missing-snapshot",
      summary:
        controlState === "running"
          ? "The snapshot belongs to the live factory runtime."
          : "No runtime snapshot is available.",
      workerAlive: controlState === "running" ? true : null,
      publicationState: controlState === "running" ? "current" : null,
    },
    statusSnapshot: null,
    processIds: controlState === "degraded" ? [1234] : [],
    problems:
      controlState === "degraded" ? ["multiple detached screen sessions"] : [],
  };
}

function createTerminal(): {
  readonly terminal: FactoryAttachTerminal;
  readonly stdin: MockInput;
  readonly stdout: MockStream;
  readonly stderr: MockStream;
} {
  const stdin = new MockInput();
  const stdout = new MockStream();
  const stderr = new MockStream();
  return {
    terminal: { stdin, stdout, stderr },
    stdin,
    stdout,
    stderr,
  };
}

async function waitForAsyncSetup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createSpawnedChild(): EventEmitter & {
  pid: number;
  stdin: MockStream;
  stdout: MockStream;
  stderr: MockStream;
  kill: (signal?: NodeJS.Signals) => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: MockStream;
    stdout: MockStream;
    stderr: MockStream;
    kill: (signal?: NodeJS.Signals) => void;
  };
  child.pid = 4242;
  child.stdin = new MockStream();
  child.stdout = new MockStream();
  child.stderr = new MockStream();
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFactoryAttachLaunchSpec", () => {
  it("uses the compiled helper on macOS", async () => {
    const buildMacOsAttachHelper = vi.fn(
      async () => "/tmp/factory-attach-helper",
    );

    await expect(
      createFactoryAttachLaunchSpec("1234.session", "darwin", {
        buildMacOsAttachHelper,
      }),
    ).resolves.toEqual({
      command: "/tmp/factory-attach-helper",
      args: ["1234.session"],
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(buildMacOsAttachHelper).toHaveBeenCalledTimes(1);
  });

  it("keeps the script wrapper on Linux", async () => {
    await expect(
      createFactoryAttachLaunchSpec("1234.session", "linux"),
    ).resolves.toEqual({
      command: "script",
      args: [
        "-q",
        "-f",
        "-e",
        "-c",
        "'screen' '-x' '1234.session'",
        "/dev/null",
      ],
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("rejects unsupported platforms before building a launch command", async () => {
    await expect(
      createFactoryAttachLaunchSpec("1234.session", "win32"),
    ).rejects.toThrowError(/only supported on macOS and Linux/);
  });
});

describe("selectFactoryAttachTerm", () => {
  it("preserves a compatible inherited TERM", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "xterm-ghostty",
      }),
    ).toEqual({
      term: "xterm-ghostty",
      source: "passthrough",
      reason: "compatible",
      inheritedTerm: "xterm-ghostty",
    });
  });

  it("normalizes surrounding TERM whitespace without treating the result as passthrough", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: " xterm-ghostty  ",
      }),
    ).toEqual({
      term: "xterm-ghostty",
      source: "normalized",
      reason: "trimmed",
      inheritedTerm: " xterm-ghostty  ",
    });
  });

  it("uses a closer short-form alias for known long screen-incompatible terms", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "rxvt-unicode-256color",
      }),
    ).toEqual({
      term: "rxvt-256color",
      source: "fallback",
      reason: "alias",
      inheritedTerm: "rxvt-unicode-256color",
    });
  });

  it("matches known TERM aliases case-insensitively", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "RXVT-UNICODE-256COLOR",
      }),
    ).toEqual({
      term: "rxvt-256color",
      source: "fallback",
      reason: "alias",
      inheritedTerm: "RXVT-UNICODE-256COLOR",
    });
  });

  it("preserves the raw inherited TERM in fallback selections", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: " rxvt-unicode-256color ",
      }),
    ).toEqual({
      term: "rxvt-256color",
      source: "fallback",
      reason: "alias",
      inheritedTerm: " rxvt-unicode-256color ",
    });
  });

  it("falls back to a generic 256-color terminal for other long 256-color terms", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "this-terminal-name-is-definitely-too-long-256color",
      }),
    ).toEqual({
      term: "xterm-256color",
      source: "fallback",
      reason: "too-long",
      inheritedTerm: "this-terminal-name-is-definitely-too-long-256color",
    });
  });

  it("does not infer color capability from embedded words in long TERM names", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "no-color-direct-mode-extra",
      }),
    ).toEqual({
      term: "xterm",
      source: "fallback",
      reason: "too-long",
      inheritedTerm: "no-color-direct-mode-extra",
    });
  });

  it("falls back when TERM is missing", () => {
    expect(selectFactoryAttachTerm({})).toEqual({
      term: "xterm-256color",
      source: "fallback",
      reason: "missing",
      inheritedTerm: null,
    });
  });

  it("treats whitespace-only TERM values as empty while preserving the raw metadata", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "   ",
      }),
    ).toEqual({
      term: "xterm-256color",
      source: "fallback",
      reason: "missing",
      inheritedTerm: "   ",
    });
  });

  it("treats an empty TERM value as empty while preserving the raw metadata", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "",
      }),
    ).toEqual({
      term: "xterm-256color",
      source: "fallback",
      reason: "missing",
      inheritedTerm: "",
    });
  });

  it("falls back when TERM contains invalid shell-unfriendly characters", () => {
    expect(
      selectFactoryAttachTerm({
        TERM: "broken term",
      }),
    ).toEqual({
      term: "xterm",
      source: "fallback",
      reason: "invalid",
      inheritedTerm: "broken term",
    });
  });
});

describe("createFactoryAttachLaunchEnvironment", () => {
  it("overrides only TERM in the attach child environment", () => {
    expect(
      createFactoryAttachLaunchEnvironment({
        TERM: "rxvt-unicode-256color",
        LANG: "en_US.UTF-8",
        CUSTOM_VALUE: "kept",
      }),
    ).toEqual({
      TERM: "rxvt-256color",
      LANG: "en_US.UTF-8",
      CUSTOM_VALUE: "kept",
    });
  });

  it("trims compatible TERM values before passing them to the attach child", () => {
    expect(
      createFactoryAttachLaunchEnvironment({
        TERM: " xterm-ghostty  ",
        LANG: "en_US.UTF-8",
      }),
    ).toEqual({
      TERM: "xterm-ghostty",
      LANG: "en_US.UTF-8",
    });
  });
});

describe("FACTORY_ATTACH_MACOS_HELPER_SOURCE", () => {
  it("treats EIO from the PTY master read as a normal detach boundary", () => {
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "if (errno == EIO) {\n          break;\n        }",
    );
  });

  it("lets terminate signals interrupt select instead of restarting it", () => {
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "terminate_action.sa_flags = 0;",
    );
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "resize_action.sa_flags = SA_RESTART;",
    );
  });

  it("preserves errno across signal handlers that perform syscalls", () => {
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "static void on_resize_signal(int signal_number) {\n  int saved_errno = errno;",
    );
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "sync_window_size();\n  errno = saved_errno;\n}",
    );
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "static void on_terminate_signal(int signal_number) {\n  int saved_errno = errno;",
    );
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "(void)kill(child_pid, SIGTERM);\n  }\n  errno = saved_errno;\n}",
    );
  });

  it("closes the PTY master in the child before execing screen", () => {
    expect(FACTORY_ATTACH_MACOS_HELPER_SOURCE).toContain(
      "if (child_pid == 0) {\n    (void)close(master_fd);\n    if (login_tty(slave_fd) == -1) {",
    );
  });
});

describe("resolveAttachSession", () => {
  it("returns the single healthy session for running control", () => {
    expect(resolveAttachSession(createSnapshot())).toMatchObject({
      id: "1234.symphony-factory-instance",
    });
  });

  it("fails clearly for stopped control", () => {
    expect(() => resolveAttachSession(createSnapshot("stopped"))).toThrowError(
      /requires a running detached runtime/,
    );
  });

  it("fails clearly for degraded control", () => {
    expect(() => resolveAttachSession(createSnapshot("degraded"))).toThrowError(
      /factory control is degraded/,
    );
  });

  it("fails clearly if running control reports an unexpected session count", () => {
    const snapshot = {
      ...createSnapshot(),
      sessions: [],
    } satisfies FactoryControlStatusSnapshot;

    expect(() => resolveAttachSession(snapshot)).toThrowError(
      /expected exactly one detached session/,
    );
  });
});

describe("attachFactory", () => {
  it("intercepts Ctrl-C locally and does not forward it to the child session", async () => {
    const { terminal, stdin, stderr } = createTerminal();
    const child = new MockAttachChild();
    const inspected = vi.fn(async () => createSnapshot());
    const killChild = vi.fn(
      (target: FactoryAttachChild, signal?: NodeJS.Signals) => {
        target.kill(signal);
      },
    );
    const signals = new Map<NodeJS.Signals, () => void>();

    const attachPromise = attachFactory({
      workflowPath: "/repo/WORKFLOW.md",
      inspectFactoryControl: inspected,
      terminal,
      launchAttachChild: () => child,
      killChild,
      onSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
      offSignal: (signal) => {
        signals.delete(signal);
      },
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    stdin.emit("data", Buffer.from([0x03]));
    await attachPromise;

    expect(inspected).toHaveBeenCalledWith({
      workflowPath: "/repo/WORKFLOW.md",
    });
    expect(killChild).toHaveBeenCalledWith(child, "SIGTERM");
    expect(child.stdin.writes).toEqual([]);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.paused).toBe(true);
    expect(signals.size).toBe(0);
    expect(String(stderr.writes[0])).toContain(
      "Ctrl-C exits this attach client only.",
    );
  });

  it("forwards normal input bytes to the attach child", async () => {
    const { terminal, stdin } = createTerminal();
    const child = new MockAttachChild();

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
      killChild: vi.fn((target, signal) => {
        target.kill(signal);
      }),
    });

    await waitForAsyncSetup();
    stdin.emit("data", Buffer.from("a"));
    child.emit("exit", 0, null);
    await attachPromise;

    expect(child.stdin.writes).toEqual([Buffer.from("a")]);
  });

  it("forwards bytes before Ctrl-C and then detaches locally", async () => {
    const { terminal, stdin } = createTerminal();
    const child = new MockAttachChild();
    const killChild = vi.fn(
      (target: FactoryAttachChild, signal?: NodeJS.Signals) => {
        target.kill(signal);
      },
    );

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
      killChild,
    });

    await waitForAsyncSetup();
    stdin.emit("data", Buffer.from([0x61, 0x62, 0x03, 0x63]));
    await attachPromise;

    expect(child.stdin.writes).toEqual([Buffer.from("ab")]);
    expect(killChild).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it("forwards SIGWINCH to the local attach child", async () => {
    const { terminal } = createTerminal();
    const child = new MockAttachChild();
    const signalProcess = vi.fn(() => true);
    let resizeListener: (() => void) | undefined;

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: (listener) => {
        resizeListener = listener;
      },
      offResize: vi.fn(),
      signalProcess,
      killChild: vi.fn((target, signal) => {
        target.kill(signal);
      }),
    });

    await waitForAsyncSetup();
    resizeListener?.();
    child.emit("exit", 0, null);
    await attachPromise;

    expect(signalProcess).toHaveBeenCalledWith(child.pid, "SIGWINCH");
  });

  it("ignores resize forwarding after the attach child exits", async () => {
    const { terminal } = createTerminal();
    const child = new MockAttachChild();
    const signalProcess = vi.fn(() => true);
    let resizeListener: (() => void) | undefined;

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: (listener) => {
        resizeListener = listener;
      },
      offResize: vi.fn(),
      signalProcess,
      killChild: vi.fn((target, signal) => {
        target.kill(signal);
      }),
    });

    await waitForAsyncSetup();
    child.pid = undefined;
    resizeListener?.();
    child.emit("exit", 0, null);
    await attachPromise;

    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("requires an interactive terminal", async () => {
    const { terminal, stdin } = createTerminal();
    stdin.isTTY = false;

    await expect(
      attachFactory({
        inspectFactoryControl: async () => createSnapshot(),
        terminal,
      }),
    ).rejects.toThrowError(/requires an interactive TTY/);
  });

  it("fails clearly when attach preflight is not healthy", async () => {
    const { terminal } = createTerminal();

    await expect(
      attachFactory({
        inspectFactoryControl: async () => createSnapshot("stopped"),
        terminal,
      }),
    ).rejects.toThrowError(/requires a running detached runtime/);
  });

  it("reports macOS helper launch failures without pointing users at script", async () => {
    const { terminal } = createTerminal();
    const spawnChildProcess = vi.fn(() => {
      const error = new Error("bad helper") as NodeJS.ErrnoException;
      error.code = "ENOEXEC";
      throw error;
    });

    await expect(
      attachFactory({
        inspectFactoryControl: async () => createSnapshot(),
        terminal,
        platform: "darwin",
        buildMacOsAttachHelper: async () => "/tmp/factory-attach-helper",
        spawnChildProcess:
          spawnChildProcess as typeof import("node:child_process").spawn,
      }),
    ).rejects.toThrowError(/local macOS PTY helper/);

    await expect(
      attachFactory({
        inspectFactoryControl: async () => createSnapshot(),
        terminal,
        platform: "darwin",
        buildMacOsAttachHelper: async () => "/tmp/factory-attach-helper",
        spawnChildProcess:
          spawnChildProcess as typeof import("node:child_process").spawn,
      }),
    ).rejects.not.toThrowError(/script/);
  });

  it("keeps the Linux launch guidance pointed at script", async () => {
    const { terminal } = createTerminal();
    const spawnChildProcess = vi.fn(() => {
      const error = new Error("missing script") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    await expect(
      attachFactory({
        inspectFactoryControl: async () => createSnapshot(),
        terminal,
        platform: "linux",
        spawnChildProcess:
          spawnChildProcess as typeof import("node:child_process").spawn,
      }),
    ).rejects.toThrowError(/local 'script' terminal helper/);
  });

  it("forwards the normalized TERM to the Linux attach child only", async () => {
    const { terminal } = createTerminal();
    const child = createSpawnedChild();
    const spawnChildProcess = vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: { readonly env?: NodeJS.ProcessEnv },
      ) => {
        expect(command).toBe("script");
        expect(args).toEqual([
          "-q",
          "-f",
          "-e",
          "-c",
          "'screen' '-x' '1234.symphony-factory-instance'",
          "/dev/null",
        ]);
        expect(options?.env).toMatchObject({
          TERM: "rxvt-256color",
          CUSTOM_VALUE: "kept",
        });
        expect(options?.env).not.toMatchObject({
          TERM: "rxvt-unicode-256color",
        });
        return child;
      },
    );

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      platform: "linux",
      inheritedEnv: {
        TERM: "rxvt-unicode-256color",
        CUSTOM_VALUE: "kept",
      },
      spawnChildProcess:
        spawnChildProcess as unknown as typeof import("node:child_process").spawn,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    child.emit("exit", 0, null);
    await attachPromise;
    expect(spawnChildProcess).toHaveBeenCalledTimes(1);
  });

  it("forwards the normalized TERM to the macOS attach helper", async () => {
    const { terminal } = createTerminal();
    const child = createSpawnedChild();
    const spawnChildProcess = vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: { readonly env?: NodeJS.ProcessEnv },
      ) => {
        expect(command).toBe("/tmp/factory-attach-helper");
        expect(args).toEqual(["1234.symphony-factory-instance"]);
        expect(options?.env).toMatchObject({
          TERM: "xterm-256color",
          CUSTOM_VALUE: "kept",
        });
        return child;
      },
    );

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      platform: "darwin",
      inheritedEnv: {
        TERM: "this-terminal-name-is-definitely-too-long-256color",
        CUSTOM_VALUE: "kept",
      },
      buildMacOsAttachHelper: async () => "/tmp/factory-attach-helper",
      spawnChildProcess:
        spawnChildProcess as unknown as typeof import("node:child_process").spawn,
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    child.emit("exit", 0, null);
    await attachPromise;
    expect(spawnChildProcess).toHaveBeenCalledTimes(1);
  });

  it("includes the attach TERM fallback in unexpected-exit errors", async () => {
    const { terminal } = createTerminal();
    const child = new MockAttachChild();

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      inheritedEnv: {
        TERM: "rxvt-unicode-256color",
      },
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    child.emit("exit", 1, null);

    await expect(attachPromise).rejects.toThrowError(
      /^Factory attach ended unexpectedly \(exit 1\)\. Attach TERM: rxvt-256color \(fallback from TERM=rxvt-unicode-256color\)\.$/,
    );
  });

  it("describes whitespace-only TERM fallbacks as an empty TERM", async () => {
    const { terminal } = createTerminal();
    const child = new MockAttachChild();

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      inheritedEnv: {
        TERM: "   ",
      },
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    child.emit("exit", 1, null);

    await expect(attachPromise).rejects.toThrowError(
      /^Factory attach ended unexpectedly \(exit 1\)\. Attach TERM: xterm-256color \(fallback from an empty TERM\)\.$/,
    );
  });

  it("describes empty-string TERM fallbacks as an empty TERM", async () => {
    const { terminal } = createTerminal();
    const child = new MockAttachChild();

    const attachPromise = attachFactory({
      inspectFactoryControl: async () => createSnapshot(),
      terminal,
      launchAttachChild: () => child,
      inheritedEnv: {
        TERM: "",
      },
      onSignal: vi.fn(),
      offSignal: vi.fn(),
      onResize: vi.fn(),
      offResize: vi.fn(),
    });

    await waitForAsyncSetup();
    child.emit("exit", 1, null);

    await expect(attachPromise).rejects.toThrowError(
      /^Factory attach ended unexpectedly \(exit 1\)\. Attach TERM: xterm-256color \(fallback from an empty TERM\)\.$/,
    );
  });
});
