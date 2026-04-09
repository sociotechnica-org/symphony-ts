import { chmod, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

type TuiUseRawSnapshot = {
  readonly lines: readonly string[];
  readonly cursor: {
    readonly x: number;
    readonly y: number;
  };
  readonly changed: boolean;
  readonly highlights: readonly TuiUseHighlight[];
  readonly title: string;
  readonly is_fullscreen: boolean;
};

type TuiUseSessionInstance = {
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly cols: number;
  readonly rows: number;
  snapshot: () => TuiUseRawSnapshot;
  wait: (timeoutMs?: number, text?: string) => Promise<TuiUseRawSnapshot>;
  press: (key: string) => void;
  kill: () => void;
};

type TuiUseSessionConstructor = new (
  id: string,
  command: string,
  options: {
    readonly cwd?: string;
    readonly label?: string;
    readonly cols?: number;
    readonly rows?: number;
  },
) => TuiUseSessionInstance;

export interface TuiUseHighlight {
  readonly line: number;
  readonly col_start: number;
  readonly col_end: number;
  readonly text: string;
}

export interface TuiUseSnapshot {
  readonly session_id: string;
  readonly screen: string;
  readonly cursor: {
    readonly x: number;
    readonly y: number;
  };
  readonly changed: boolean;
  readonly status: "running" | "exited";
  readonly exit_code: number | null;
  readonly title: string;
  readonly is_fullscreen: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly highlights: readonly TuiUseHighlight[];
}

export interface TuiUseHarnessOptions {
  readonly homeDir: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface TuiUseStartOptions {
  readonly cwd?: string;
  readonly label?: string;
  readonly cols?: number;
  readonly rows?: number;
}

let installReady: Promise<void> | null = null;
let sessionConstructor: TuiUseSessionConstructor | null = null;

export async function createTuiUseHarness(
  options: TuiUseHarnessOptions,
): Promise<TuiUseHarness> {
  await ensureTuiUseInstallReady();
  await mkdir(options.homeDir, { recursive: true });
  return new TuiUseHarness(options);
}

export class TuiUseHarness {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  #currentSession: {
    readonly id: string;
    readonly instance: TuiUseSessionInstance;
  } | null = null;

  constructor(options: TuiUseHarnessOptions) {
    this.#cwd = options.cwd;
    this.#env = sanitizeTuiUseEnv({
      ...(options.env ?? process.env),
      HOME: options.homeDir,
    });
  }

  async start(
    command: string,
    options: TuiUseStartOptions = {},
  ): Promise<string> {
    await this.killCurrentSession();
    const sessionId = randomUUID();
    const sessionOptions: ConstructorParameters<TuiUseSessionConstructor>[2] = {
      cwd: options.cwd ?? this.#cwd,
      cols: options.cols ?? 140,
      rows: options.rows ?? 40,
      ...(options.label === undefined ? {} : { label: options.label }),
    };
    const Session = resolveSessionConstructor();
    const session = withOverriddenEnv(this.#env, () => {
      return new Session(sessionId, command, sessionOptions);
    });
    this.#currentSession = {
      id: sessionId,
      instance: session,
    };
    return sessionId;
  }

  async snapshot(): Promise<TuiUseSnapshot> {
    const session = this.#requireCurrentSession();
    return mapSnapshot(
      session.id,
      session.instance,
      session.instance.snapshot(),
    );
  }

  async waitForChange(timeoutMs = 1_000): Promise<TuiUseSnapshot> {
    const session = this.#requireCurrentSession();
    return mapSnapshot(
      session.id,
      session.instance,
      await session.instance.wait(timeoutMs),
    );
  }

  async waitForSnapshot(
    predicate: (snapshot: TuiUseSnapshot) => boolean,
    options?: {
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
      readonly description?: string;
    },
  ): Promise<TuiUseSnapshot> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot: TuiUseSnapshot;

    for (;;) {
      const snapshot = await this.snapshot();
      lastSnapshot = snapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      try {
        await this.waitForChange(Math.min(pollIntervalMs, remainingMs));
      } catch {
        // tui-use may reject when the session exits or when no change arrives
        // before the wait timeout. Re-check via snapshot() so callers can
        // observe the current terminal state before failing.
      }
    }

    throw buildWaitForSnapshotTimeoutError(options?.description, lastSnapshot);
  }

  async press(key: string): Promise<void> {
    this.#requireCurrentSession().instance.press(key);
  }

  async kill(): Promise<void> {
    await this.killCurrentSession();
  }

  async cleanup(): Promise<void> {
    await this.killCurrentSession();
  }

  async killCurrentSession(): Promise<void> {
    const session = this.#currentSession;
    if (session === null) {
      return;
    }
    this.#currentSession = null;
    session.instance.kill();
    await waitForSessionExit(session.instance);
  }

  #requireCurrentSession(): {
    readonly id: string;
    readonly instance: TuiUseSessionInstance;
  } {
    if (this.#currentSession === null) {
      throw new Error("No active tui-use session is available.");
    }
    return this.#currentSession;
  }
}

async function ensureTuiUseInstallReady(): Promise<void> {
  installReady ??= ensureTuiUseInstallReadyOnce().catch((error) => {
    installReady = null;
    throw error;
  });
  await installReady;
}

async function ensureTuiUseInstallReadyOnce(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const nodePtyRoot = resolveNodePtyRoot();
  const helperCandidates = [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "build", "Debug", "spawn-helper"),
    path.join(
      nodePtyRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
  ];

  await Promise.all(
    helperCandidates.map((candidatePath) =>
      chmod(candidatePath, 0o755).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return;
        }
        throw error;
      }),
    ),
  );

  resolveSessionConstructor();
}

async function waitForSessionExit(
  session: TuiUseSessionInstance,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (session.status !== "exited") {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for tui-use session to exit.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function mapSnapshot(
  sessionId: string,
  session: TuiUseSessionInstance,
  snapshot: TuiUseRawSnapshot,
): TuiUseSnapshot {
  return {
    session_id: sessionId,
    screen: snapshot.lines.join("\n"),
    cursor: snapshot.cursor,
    changed: snapshot.changed,
    status: session.status,
    exit_code: session.exitCode,
    title: snapshot.title,
    is_fullscreen: snapshot.is_fullscreen,
    cols: session.cols,
    rows: session.rows,
    highlights: snapshot.highlights,
  };
}

function resolveTuiUseRoot(): string {
  return path.dirname(require.resolve("tui-use/package.json"));
}

export function resolveNodePtyRoot(): string {
  return path.dirname(
    require.resolve("node-pty/package.json", {
      paths: [resolveTuiUseRoot()],
    }),
  );
}

export function resolveTuiUseSessionModulePath(): string {
  return require.resolve("tui-use/dist/session.js");
}

function resolveSessionConstructor(): TuiUseSessionConstructor {
  if (sessionConstructor !== null) {
    return sessionConstructor;
  }

  try {
    const loaded = require(resolveTuiUseSessionModulePath()) as {
      readonly Session: TuiUseSessionConstructor;
    };
    sessionConstructor = loaded.Session;
    return sessionConstructor;
  } catch (error) {
    throw new Error(
      "Failed to load tui-use session support. If native build scripts were skipped, run `pnpm rebuild tui-use node-pty` and retry.",
      { cause: error },
    );
  }
}

export function sanitizeTuiUseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv = { ...env };
  delete sanitizedEnv["NODE_OPTIONS"];
  delete sanitizedEnv["NODE_ENV"];
  for (const key of Object.keys(sanitizedEnv)) {
    if (key.startsWith("VITEST") || key.startsWith("__VITEST")) {
      delete sanitizedEnv[key];
    }
  }
  return sanitizedEnv;
}

export function resetTuiUseStateForTests(): void {
  installReady = null;
  sessionConstructor = null;
}

export function setTuiUseSessionConstructorForTests(
  constructor: TuiUseSessionConstructor | null,
): void {
  sessionConstructor = constructor;
}

function buildWaitForSnapshotTimeoutError(
  description: string | undefined,
  lastSnapshot: TuiUseSnapshot,
): Error {
  return new Error(
    `Timed out waiting for tui-use snapshot${
      description === undefined ? "" : `: ${description}`
    }\n\nLast screen:\n${lastSnapshot.screen}`,
  );
}

function withOverriddenEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const originalEnv = { ...process.env };
  applyProcessEnv(env);
  try {
    return fn();
  } finally {
    applyProcessEnv(originalEnv);
  }
}

function applyProcessEnv(env: NodeJS.ProcessEnv): void {
  const nextKeys = new Set(Object.keys(env));
  for (const key of Object.keys(process.env)) {
    if (!nextKeys.has(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
}
