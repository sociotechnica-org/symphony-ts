import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
} from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectFactoryControl,
  type FactoryControlStatusSnapshot,
} from "./factory-control.js";
import { FACTORY_ATTACH_MACOS_HELPER_SOURCE } from "./factory-attach-macos-helper-source.js";

const LOCAL_DETACH_BYTES = new Set([0x03]);

export interface FactoryAttachTerminal {
  readonly stdin: {
    readonly isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
    resume: () => void;
    pause: () => void;
    on: (event: "data", listener: (chunk: Buffer) => void) => void;
    off: (event: "data", listener: (chunk: Buffer) => void) => void;
  };
  readonly stdout: {
    readonly isTTY?: boolean;
    write: (chunk: string | Uint8Array) => boolean;
  };
  readonly stderr: {
    write: (chunk: string | Uint8Array) => boolean;
  };
}

export interface FactoryAttachInput {
  write: (chunk: string | Uint8Array) => boolean;
}

export interface FactoryAttachOutput {
  on: (event: "data", listener: (chunk: Buffer) => void) => void;
}

export interface FactoryAttachChild {
  readonly pid: number | undefined;
  readonly stdin: FactoryAttachInput | null;
  readonly stdout: FactoryAttachOutput | null;
  readonly stderr: FactoryAttachOutput | null;
  readonly waitForExit: () => Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly kill: (signal?: NodeJS.Signals) => void;
}

export interface FactoryAttachDeps {
  readonly workflowPath?: string | null;
  readonly inspectFactoryControl?: (options?: {
    readonly workflowPath?: string | null;
  }) => Promise<FactoryControlStatusSnapshot>;
  readonly launchAttachChild?: (
    sessionId: string,
  ) => Promise<FactoryAttachChild> | FactoryAttachChild;
  readonly terminal?: FactoryAttachTerminal;
  readonly onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly offSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly onResize?: (listener: () => void) => void;
  readonly offResize?: (listener: () => void) => void;
  readonly killChild?: (
    child: FactoryAttachChild,
    signal?: NodeJS.Signals,
  ) => void;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly platform?: NodeJS.Platform;
  readonly spawnChildProcess?: typeof spawn;
  readonly buildMacOsAttachHelper?: () => Promise<string>;
}

export async function attachFactory(
  deps: FactoryAttachDeps = {},
): Promise<void> {
  const inspect = deps.inspectFactoryControl ?? inspectFactoryControl;
  const terminal = deps.terminal ?? defaultTerminal();
  const onSignal =
    deps.onSignal ?? ((signal, listener) => process.on(signal, listener));
  const offSignal =
    deps.offSignal ?? ((signal, listener) => process.off(signal, listener));
  const onResize =
    deps.onResize ?? ((listener) => process.on("SIGWINCH", listener));
  const offResize =
    deps.offResize ?? ((listener) => process.off("SIGWINCH", listener));
  const killChild =
    deps.killChild ?? ((child, signal = "SIGTERM") => child.kill(signal));
  const signalProcess =
    deps.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const platform = deps.platform ?? process.platform;
  const launchAttachChild =
    deps.launchAttachChild ??
    ((sessionId) => {
      const launchOptions: {
        readonly platform: NodeJS.Platform;
        readonly spawnChildProcess?: typeof spawn;
        readonly buildMacOsAttachHelper?: () => Promise<string>;
      } = {
        platform,
        ...(deps.spawnChildProcess === undefined
          ? {}
          : { spawnChildProcess: deps.spawnChildProcess }),
        ...(deps.buildMacOsAttachHelper === undefined
          ? {}
          : { buildMacOsAttachHelper: deps.buildMacOsAttachHelper }),
      };
      return defaultLaunchAttachChild(sessionId, launchOptions);
    });

  if (!terminal.stdin.isTTY || !terminal.stdout.isTTY) {
    throw new Error(
      "Factory attach requires an interactive TTY on stdin and stdout.",
    );
  }
  if (typeof terminal.stdin.setRawMode !== "function") {
    throw new Error(
      "Factory attach requires terminal raw-mode support on stdin.",
    );
  }

  const inspectOptions =
    deps.workflowPath === undefined
      ? undefined
      : { workflowPath: deps.workflowPath };
  const status = await inspect(inspectOptions);
  const targetSession = resolveAttachSession(status);

  terminal.stderr.write(
    "Factory attach: Ctrl-C exits this attach client only.\n",
  );

  const child = await launchAttachChild(targetSession.id);
  const stdout = child.stdout;
  const stderr = child.stderr;
  const childStdin = child.stdin;

  if (stdout !== null) {
    stdout.on("data", (chunk) => {
      terminal.stdout.write(chunk);
    });
  }
  if (stderr !== null) {
    stderr.on("data", (chunk) => {
      terminal.stderr.write(chunk);
    });
  }

  let detachedLocally = false;
  let terminalRestored = false;
  const restoreErrors: Error[] = [];

  const restoreTerminal = (): void => {
    if (terminalRestored) {
      return;
    }
    terminalRestored = true;
    try {
      terminal.stdin.off("data", onStdinData);
      terminal.stdin.setRawMode?.(false);
      terminal.stdin.pause();
    } catch (error) {
      restoreErrors.push(error as Error);
    }
    offSignal("SIGINT", onInterruptSignal);
    offSignal("SIGTERM", onInterruptSignal);
    offResize(onResizeSignal);
  };

  const detachLocalClient = (): void => {
    if (detachedLocally) {
      return;
    }
    detachedLocally = true;
    restoreTerminal();
    killChild(child, "SIGTERM");
  };

  const onInterruptSignal = (): void => {
    detachLocalClient();
  };

  const onResizeSignal = (): void => {
    if (child.pid !== undefined) {
      try {
        signalProcess(child.pid, "SIGWINCH");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
      }
    }
  };

  const onStdinData = (chunk: Buffer): void => {
    const forwardChunk = takeForwardChunkBeforeDetach(chunk);
    if (forwardChunk !== null && childStdin !== null) {
      childStdin.write(forwardChunk);
    }
    if (containsLocalDetachByte(chunk)) {
      detachLocalClient();
      return;
    }
  };

  onSignal("SIGINT", onInterruptSignal);
  onSignal("SIGTERM", onInterruptSignal);
  onResize(onResizeSignal);

  terminal.stdin.setRawMode(true);
  terminal.stdin.resume();
  terminal.stdin.on("data", onStdinData);

  try {
    const { code, signal } = await child.waitForExit();
    restoreTerminal();
    if (restoreErrors.length > 0) {
      throw new Error(
        `Factory attach restored the worker safely but failed to restore the local terminal cleanly: ${restoreErrors[0]!.message}`,
        { cause: restoreErrors[0] },
      );
    }
    if (code === 0 || signal === "SIGTERM") {
      return;
    }
    throw new Error(
      `Factory attach ended unexpectedly${renderExitDetail(code, signal)}.`,
    );
  } finally {
    restoreTerminal();
  }
}

function createLinuxFactoryAttachCommand(sessionId: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: "script",
    args: [
      "-q",
      "-f",
      "-e",
      "-c",
      escapeShellCommand(["screen", "-x", sessionId]),
      "/dev/null",
    ],
  };
}

export interface FactoryAttachLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdio: StdioOptions;
}

export async function createFactoryAttachLaunchSpec(
  sessionId: string,
  platform: NodeJS.Platform,
  deps: {
    readonly buildMacOsAttachHelper?: () => Promise<string>;
  } = {},
): Promise<FactoryAttachLaunchSpec> {
  if (platform === "darwin") {
    const buildMacOsAttachHelper =
      deps.buildMacOsAttachHelper ?? ensureMacOsAttachHelper;
    return {
      command: await buildMacOsAttachHelper(),
      args: [sessionId],
      stdio: ["pipe", "pipe", "pipe"],
    };
  }

  if (platform !== "linux") {
    throw new Error(
      `Factory attach is only supported on macOS and Linux today; got ${platform}.`,
    );
  }

  const { command, args } = createLinuxFactoryAttachCommand(sessionId);
  return {
    command,
    args,
    stdio: ["pipe", "pipe", "pipe"],
  };
}

export function resolveAttachSession(
  snapshot: FactoryControlStatusSnapshot,
): FactoryControlStatusSnapshot["sessions"][number] {
  if (snapshot.controlState === "running" && snapshot.sessions.length === 1) {
    const session = snapshot.sessions[0];
    if (session !== undefined) {
      return session;
    }
  }

  const detail =
    snapshot.problems.length > 0
      ? ` Problems: ${snapshot.problems.join(" | ")}`
      : "";
  if (snapshot.controlState === "stopped") {
    throw new Error(
      `Factory attach requires a running detached runtime for ${snapshot.paths.workflowPath}, but factory control is stopped. Use 'symphony factory start' or inspect with 'symphony factory status'.`,
    );
  }
  if (snapshot.controlState === "running") {
    throw new Error(
      `Factory attach expected exactly one detached session for ${snapshot.paths.workflowPath}, but found ${snapshot.sessions.length.toString()} while factory control reported running.`,
    );
  }
  throw new Error(
    `Factory attach requires one healthy detached runtime for ${snapshot.paths.workflowPath}, but factory control is ${snapshot.controlState}.${detail}`,
  );
}

function defaultTerminal(): FactoryAttachTerminal {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

async function defaultLaunchAttachChild(
  sessionId: string,
  options: {
    readonly platform: NodeJS.Platform;
    readonly spawnChildProcess?: typeof spawn;
    readonly buildMacOsAttachHelper?: () => Promise<string>;
  },
): Promise<FactoryAttachChild> {
  const { command, args, stdio } = await createFactoryAttachLaunchSpec(
    sessionId,
    options.platform,
    options.buildMacOsAttachHelper === undefined
      ? {}
      : { buildMacOsAttachHelper: options.buildMacOsAttachHelper },
  );
  const spawnChildProcess = options.spawnChildProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnChildProcess(command, [...args], {
      stdio,
      env: process.env,
    });
  } catch (error) {
    throw wrapAttachLaunchError(error as Error, options.platform);
  }
  const stdioChild = child as Partial<ChildProcessWithoutNullStreams>;
  return {
    pid: child.pid,
    stdin: stdioChild.stdin ?? null,
    stdout: stdioChild.stdout ?? null,
    stderr: stdioChild.stderr ?? null,
    waitForExit: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          child.off("exit", onExit);
          reject(wrapAttachLaunchError(error, options.platform));
        };
        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          child.off("error", onError);
          resolve({ code, signal });
        };
        child.once("error", onError);
        child.once("exit", onExit);
      }),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function ensureMacOsAttachHelper(): Promise<string> {
  const helperDirectory = join(tmpdir(), "symphony-ts");
  const sourcePath = join(helperDirectory, "factory-attach-macos-helper-v1.c");
  const binaryPath = join(helperDirectory, "factory-attach-macos-helper-v1");

  await mkdir(helperDirectory, { recursive: true });

  const existingSource = await readFile(sourcePath, "utf8").catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existingSource !== FACTORY_ATTACH_MACOS_HELPER_SOURCE) {
    await writeFile(sourcePath, FACTORY_ATTACH_MACOS_HELPER_SOURCE, "utf8");
  }

  const sourceStats = await stat(sourcePath);
  const binaryStats = await stat(binaryPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (
    binaryStats === null ||
    binaryStats.mtimeMs < sourceStats.mtimeMs ||
    binaryStats.size === 0
  ) {
    await compileMacOsAttachHelper(sourcePath, binaryPath);
  }

  return binaryPath;
}

async function compileMacOsAttachHelper(
  sourcePath: string,
  binaryPath: string,
): Promise<void> {
  const tempBinaryPath = `${binaryPath}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  let renamed = false;

  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const compiler = spawn(
        "cc",
        ["-O2", "-Wall", "-Wextra", "-o", tempBinaryPath, sourcePath],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: process.env,
        },
      );

      compiler.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      compiler.once("error", (error) => {
        reject(wrapMacOsAttachHelperBuildError(error as Error));
      });
      compiler.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          wrapMacOsAttachHelperBuildError(
            new Error(
              `Factory attach could not build the macOS PTY helper${renderExitDetail(code, signal)}${stderr === "" ? "" : `: ${stderr.trim()}`}`,
            ),
          ),
        );
      });
    });
    await rename(tempBinaryPath, binaryPath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(tempBinaryPath).catch(() => {});
    }
  }
}

function containsLocalDetachByte(chunk: Buffer): boolean {
  return [...chunk].some((byte) => LOCAL_DETACH_BYTES.has(byte));
}

function takeForwardChunkBeforeDetach(chunk: Buffer): Buffer | null {
  const detachOffset = chunk.findIndex((byte) => LOCAL_DETACH_BYTES.has(byte));
  if (detachOffset === -1) {
    return chunk;
  }
  if (detachOffset === 0) {
    return null;
  }
  return chunk.subarray(0, detachOffset);
}

function escapeShellCommand(args: readonly string[]): string {
  return args.map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(" ");
}

function wrapAttachLaunchError(error: Error, platform: NodeJS.Platform): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOEXEC") {
    if (platform === "darwin") {
      return new Error(
        "Factory attach could not start the local macOS PTY helper. Re-run 'symphony factory attach' to rebuild it if needed.",
        { cause: error },
      );
    }
    return new Error(
      "Factory attach requires the local 'script' terminal helper. Install a Unix 'script' command before using 'symphony factory attach'.",
      { cause: error },
    );
  }
  return new Error("Factory attach could not start the local attach broker.", {
    cause: error,
  });
}

function wrapMacOsAttachHelperBuildError(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new Error(
      "Factory attach on macOS requires a local C compiler to build the PTY helper. Install Xcode Command Line Tools or another 'cc' provider before using 'symphony factory attach'.",
      { cause: error },
    );
  }
  return new Error(
    "Factory attach could not build the local macOS PTY helper.",
    {
      cause: error,
    },
  );
}

function renderExitDetail(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal !== null) {
    return ` (signal ${signal})`;
  }
  if (code !== null) {
    return ` (exit ${code.toString()})`;
  }
  return "";
}
