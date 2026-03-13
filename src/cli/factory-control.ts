import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { loadWorkflowWorkspaceRoot } from "../config/workflow.js";
import {
  deriveStatusFilePath,
  isProcessAlive,
  parseFactoryStatusSnapshotContent,
  renderFactoryStatusSnapshot,
  type FactoryStatusSnapshot,
} from "../observability/status.js";

const execFile = promisify(execFileCallback);

export const FACTORY_RUNTIME_DIRECTORY = path.join(".tmp", "factory-main");
export const FACTORY_SCREEN_SESSION_NAME = "symphony-factory";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export interface FactoryPaths {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly workflowPath: string;
  readonly statusFilePath: string;
}

export interface HostProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface ScreenSessionSnapshot {
  readonly id: string;
  readonly pid: number;
  readonly name: string;
  readonly state: string;
}

export type FactoryControlState = "stopped" | "running" | "degraded";

export interface FactoryControlStatusSnapshot {
  readonly controlState: FactoryControlState;
  readonly paths: FactoryPaths;
  readonly sessionName: string;
  readonly sessions: readonly ScreenSessionSnapshot[];
  readonly workerAlive: boolean;
  readonly statusSnapshot: FactoryStatusSnapshot | null;
  readonly processIds: readonly number[];
  readonly problems: readonly string[];
}

export interface FactoryControlStartResult {
  readonly kind: "started" | "already-running";
  readonly status: FactoryControlStatusSnapshot;
}

export interface FactoryControlStopResult {
  readonly kind: "stopped" | "already-stopped";
  readonly status: FactoryControlStatusSnapshot;
  // PIDs that were sent at least one termination signal while stopping.
  readonly terminatedPids: readonly number[];
}

interface StatusSnapshotReadResult {
  readonly raw: string | null;
  readonly snapshot: FactoryStatusSnapshot | null;
  readonly error: Error | null;
}

export interface FactoryControlDeps {
  readonly cwd?: () => string;
  readonly pathExists?: (targetPath: string) => Promise<boolean>;
  readonly loadWorkflowWorkspaceRoot?: (
    workflowPath: string,
  ) => Promise<string>;
  readonly readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  readonly listProcesses?: () => Promise<readonly HostProcessSnapshot[]>;
  readonly listScreenSessions?: () => Promise<readonly ScreenSessionSnapshot[]>;
  readonly launchScreenSession?: (options: {
    readonly runtimeRoot: string;
    readonly sessionName: string;
  }) => Promise<void>;
  readonly quitScreenSession?: (sessionId: string) => Promise<void>;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export async function resolveFactoryPaths(
  deps: FactoryControlDeps = {},
): Promise<FactoryPaths> {
  const cwd = deps.cwd ?? (() => process.cwd());
  const pathExists = deps.pathExists ?? defaultPathExists;
  const loadWorkspaceRoot =
    deps.loadWorkflowWorkspaceRoot ?? loadWorkflowWorkspaceRoot;

  const repoRoot = await findFactoryRepoRoot(cwd(), pathExists);
  const runtimeRoot = path.join(repoRoot, FACTORY_RUNTIME_DIRECTORY);

  const workflowPath = path.join(runtimeRoot, "WORKFLOW.md");
  if (!(await pathExists(workflowPath))) {
    throw new Error(
      `Factory runtime workflow not found at ${workflowPath}. The runtime checkout is incomplete.`,
    );
  }

  const workspaceRoot = await loadWorkspaceRoot(workflowPath).catch((error) => {
    throw new Error(
      `Could not determine the factory status file path from ${workflowPath}.`,
      { cause: error as Error },
    );
  });

  return {
    repoRoot,
    runtimeRoot,
    workflowPath,
    statusFilePath: deriveStatusFilePath(workspaceRoot),
  };
}

export async function inspectFactoryControl(
  deps: FactoryControlDeps = {},
): Promise<FactoryControlStatusSnapshot> {
  const paths = await resolveFactoryPaths(deps);
  return inspectFactoryControlAtPaths(paths, deps);
}

export async function startFactory(
  deps: FactoryControlDeps = {},
): Promise<FactoryControlStartResult> {
  const paths = await resolveFactoryPaths(deps);
  const current = await inspectFactoryControlAtPaths(paths, deps);
  if (current.controlState === "running") {
    return {
      kind: "already-running",
      status: current,
    };
  }

  if (current.controlState === "degraded" && current.sessions.length > 1) {
    throw new Error(
      "Factory control found multiple detached screen sessions; run 'symphony factory stop' after inspecting the runtime.",
    );
  }

  if (current.controlState === "degraded") {
    await stopFactoryAtPaths(paths, deps);
  }

  const launchScreenSession =
    deps.launchScreenSession ?? defaultLaunchScreenSession;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  await launchScreenSession({
    runtimeRoot: paths.runtimeRoot,
    sessionName: FACTORY_SCREEN_SESSION_NAME,
  });

  const deadline = now() + START_TIMEOUT_MS;
  for (;;) {
    const status = await inspectFactoryControlAtPaths(paths, deps);
    if (status.controlState === "running") {
      return {
        kind: "started",
        status,
      };
    }
    if (now() >= deadline) {
      throw new Error(
        `Factory start timed out before a healthy runtime appeared under ${paths.runtimeRoot}.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function stopFactory(
  deps: FactoryControlDeps = {},
): Promise<FactoryControlStopResult> {
  const paths = await resolveFactoryPaths(deps);
  return stopFactoryAtPaths(paths, deps);
}

export function renderFactoryControlStatus(
  snapshot: FactoryControlStatusSnapshot,
  options?: {
    readonly format?: "human" | "json";
  },
): string {
  const format = options?.format ?? "human";
  if (format === "json") {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }

  const lines = [
    `Factory control: ${snapshot.controlState}`,
    `Repository root: ${snapshot.paths.repoRoot}`,
    `Runtime root: ${snapshot.paths.runtimeRoot}`,
    `Screen session: ${snapshot.sessionName}`,
  ];

  if (snapshot.sessions.length === 0) {
    lines.push("Screen session state: none");
  } else {
    lines.push(
      `Screen session state: ${snapshot.sessions
        .map((session) => `${session.id} (${session.state})`)
        .join(", ")}`,
    );
  }

  if (snapshot.problems.length > 0) {
    lines.push(`Problems: ${snapshot.problems.join(" | ")}`);
  }

  if (snapshot.statusSnapshot === null) {
    lines.push(`Status snapshot: ${snapshot.paths.statusFilePath}`);
    lines.push("Status detail: no readable runtime snapshot");
  } else {
    lines.push("");
    lines.push(
      renderFactoryStatusSnapshot(snapshot.statusSnapshot, {
        workerAlive: snapshot.workerAlive,
        statusFilePath: snapshot.paths.statusFilePath,
      }),
    );
  }

  if (
    snapshot.controlState !== "stopped" &&
    snapshot.statusSnapshot === null &&
    snapshot.processIds.length > 0
  ) {
    lines.push(`Tracked PIDs: ${snapshot.processIds.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function parsePsOutput(output: string): readonly HostProcessSnapshot[] {
  const processes: HostProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    processes.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      command: match[3]!,
    });
  }
  return processes;
}

export function parseScreenLsOutput(
  output: string,
): readonly ScreenSessionSnapshot[] {
  const sessions: ScreenSessionSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\.([^\s]+)(?:\s+\([^)]+\))*\s+\(([^)]+)\)\s*$/.exec(
      line,
    );
    if (!match) {
      continue;
    }
    const state = match[3]!;
    if (/^dead$/i.test(state)) {
      continue;
    }
    sessions.push({
      id: `${match[1]!}.${match[2]!}`,
      pid: Number.parseInt(match[1]!, 10),
      name: match[2]!,
      state,
    });
  }
  return sessions;
}

export function parseScreenLsFailureOutput(
  stdout: string,
  stderr: string,
): readonly ScreenSessionSnapshot[] | null {
  if (
    stdout.includes("No Sockets found") ||
    stderr.includes("No Sockets found")
  ) {
    return [];
  }

  const sessions = parseScreenLsOutput(stdout);
  return sessions.length > 0 ? sessions : null;
}

export function collectDescendantProcessIds(
  processes: readonly HostProcessSnapshot[],
  rootPids: readonly number[],
): readonly number[] {
  const byParent = new Map<number, number[]>();
  for (const processSnapshot of processes) {
    const children = byParent.get(processSnapshot.ppid) ?? [];
    children.push(processSnapshot.pid);
    byParent.set(processSnapshot.ppid, children);
  }

  const seen = new Set<number>();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    for (const childPid of byParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }

  return [...seen];
}

async function inspectFactoryControlAtPaths(
  paths: FactoryPaths,
  deps: FactoryControlDeps,
): Promise<FactoryControlStatusSnapshot> {
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const listScreenSessions =
    deps.listScreenSessions ?? defaultListScreenSessions;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;

  const [processes, sessions, snapshotRead] = await Promise.all([
    listProcesses(),
    listScreenSessions(),
    readStatusSnapshot(paths.statusFilePath, deps),
  ]);

  const matchingSessions = sessions.filter(
    (session) => session.name === FACTORY_SCREEN_SESSION_NAME,
  );
  const liveSessions = matchingSessions.filter(
    (session) => !/^dead$/i.test(session.state),
  );
  const processIds = collectObservedFactoryPids(
    processes,
    liveSessions,
    snapshotRead.snapshot,
    isAlive,
  );
  const problems: string[] = [];

  if (liveSessions.length > 1) {
    problems.push(
      `multiple detached screen sessions match ${FACTORY_SCREEN_SESSION_NAME}`,
    );
  }
  if (snapshotRead.error !== null) {
    problems.push(snapshotRead.error.message);
  }

  const workerAlive =
    snapshotRead.snapshot === null
      ? false
      : isAlive(snapshotRead.snapshot.worker.pid);

  let controlState: FactoryControlState = "stopped";
  if (liveSessions.length === 0 && processIds.length === 0) {
    controlState = "stopped";
  } else if (
    liveSessions.length === 1 &&
    snapshotRead.snapshot !== null &&
    workerAlive &&
    problems.length === 0
  ) {
    controlState = "running";
  } else {
    controlState = "degraded";
    if (
      snapshotRead.snapshot !== null &&
      !workerAlive &&
      !problems.includes("worker pid from status snapshot is not alive")
    ) {
      problems.push("worker pid from status snapshot is not alive");
    }
    if (liveSessions.length === 0 && processIds.length > 0) {
      problems.push(
        "detached screen session is missing but factory-owned processes remain",
      );
    }
    if (liveSessions.length > 0 && snapshotRead.snapshot === null) {
      problems.push(
        "screen session exists but no readable runtime status snapshot was found",
      );
    }
  }

  return {
    controlState,
    paths,
    sessionName: FACTORY_SCREEN_SESSION_NAME,
    sessions: liveSessions,
    workerAlive,
    statusSnapshot: snapshotRead.snapshot,
    processIds,
    problems,
  };
}

async function stopFactoryAtPaths(
  paths: FactoryPaths,
  deps: FactoryControlDeps,
): Promise<FactoryControlStopResult> {
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const quitScreenSession = deps.quitScreenSession ?? defaultQuitScreenSession;
  const signalProcess =
    deps.signalProcess ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  const initialStatus = await inspectFactoryControlAtPaths(paths, deps);
  if (initialStatus.controlState === "stopped") {
    return {
      kind: "already-stopped",
      status: initialStatus,
      terminatedPids: [],
    };
  }

  await Promise.all(
    initialStatus.sessions.map((session) =>
      quitScreenSession(session.id).catch((error) => {
        if (isMissingScreenSessionError(error)) {
          return;
        }
        throw new Error(
          `Failed to stop detached screen session ${session.id}.`,
          {
            cause: error as Error,
          },
        );
      }),
    ),
  );

  let targetPids = new Set<number>(initialStatus.processIds);
  targetPids.delete(process.pid);
  const terminatedPids = new Set<number>();
  const deadline = now() + STOP_TIMEOUT_MS;
  let escalated = false;
  let awaitingPostKillPoll = false;

  for (;;) {
    const processes = await listProcesses();
    const liveProcessIds = new Set(
      processes.map((processSnapshot) => processSnapshot.pid),
    );
    targetPids = new Set(
      collectDescendantProcessIds(processes, [...targetPids]).filter(
        (pid) => pid !== process.pid,
      ),
    );
    const remaining = [...targetPids].filter((pid) => liveProcessIds.has(pid));

    if (remaining.length === 0) {
      const finalStatus = await inspectFactoryControlAtPaths(paths, deps);
      return {
        kind: "stopped",
        status: finalStatus,
        terminatedPids: [...terminatedPids],
      };
    }

    for (const pid of remaining) {
      try {
        signalProcess(pid, escalated ? "SIGKILL" : "SIGTERM");
        terminatedPids.add(pid);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
      }
    }

    if (now() >= deadline) {
      if (escalated) {
        if (awaitingPostKillPoll) {
          awaitingPostKillPoll = false;
        } else {
          throw new Error(
            `Factory stop timed out; processes still running: ${remaining.join(", ")}`,
          );
        }
      } else {
        escalated = true;
        awaitingPostKillPoll = true;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function findFactoryRepoRoot(
  startingPath: string,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<string> {
  let current = path.resolve(startingPath);

  for (;;) {
    const runtimeRoot = path.join(current, FACTORY_RUNTIME_DIRECTORY);
    if (await pathExists(runtimeRoot)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find a repository root containing ${FACTORY_RUNTIME_DIRECTORY} from ${startingPath}. Run 'symphony factory' from the repository root.`,
      );
    }
    current = parent;
  }
}

function collectObservedFactoryPids(
  processes: readonly HostProcessSnapshot[],
  sessions: readonly ScreenSessionSnapshot[],
  snapshot: FactoryStatusSnapshot | null,
  isAlive: (pid: number) => boolean,
): readonly number[] {
  const rootPids = new Set<number>(sessions.map((session) => session.pid));

  if (snapshot !== null) {
    for (const pid of collectSnapshotProcessIds(snapshot)) {
      if (isAlive(pid)) {
        rootPids.add(pid);
      }
    }
  }

  return collectDescendantProcessIds(processes, [...rootPids]).filter(
    (pid) => pid !== process.pid,
  );
}

function collectSnapshotProcessIds(
  snapshot: FactoryStatusSnapshot,
): readonly number[] {
  const pids = new Set<number>();
  pids.add(snapshot.worker.pid);
  for (const issue of snapshot.activeIssues) {
    if (issue.ownerPid !== null && issue.ownerPid > 0) {
      pids.add(issue.ownerPid);
    }
    if (issue.runnerPid !== null && issue.runnerPid > 0) {
      pids.add(issue.runnerPid);
    }
  }
  return [...pids];
}

async function readStatusSnapshot(
  filePath: string,
  deps: FactoryControlDeps,
): Promise<StatusSnapshotReadResult> {
  const readFile = deps.readFile ?? fs.readFile;
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      raw,
      snapshot: parseFactoryStatusSnapshotContent(raw, filePath),
      error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        raw: null,
        snapshot: null,
        error: null,
      };
    }

    return {
      raw: null,
      snapshot: null,
      error: new Error(
        `Failed to read factory status snapshot at ${filePath}. Re-run 'symphony run' inside the runtime checkout to regenerate it.`,
        { cause: error as Error },
      ),
    };
  }
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function defaultListProcesses(): Promise<readonly HostProcessSnapshot[]> {
  const { stdout } = await execFile("ps", ["-ax", "-o", "pid=,ppid=,command="]);
  return parsePsOutput(stdout);
}

async function defaultListScreenSessions(): Promise<
  readonly ScreenSessionSnapshot[]
> {
  try {
    const { stdout } = await execFile("screen", ["-ls"]);
    return parseScreenLsOutput(stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOEXEC") {
      throw new Error(
        "Could not run 'screen'. Install GNU Screen before using 'symphony factory'.",
        { cause: error as Error },
      );
    }
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    const sessions = parseScreenLsFailureOutput(stdout, stderr);
    if (sessions !== null) {
      return sessions;
    }
    throw error;
  }
}

async function defaultLaunchScreenSession(options: {
  readonly runtimeRoot: string;
  readonly sessionName: string;
}): Promise<void> {
  await execFile(
    "screen",
    ["-dmS", options.sessionName, "pnpm", "tsx", "bin/symphony.ts", "run"],
    {
      cwd: options.runtimeRoot,
    },
  );
}

async function defaultQuitScreenSession(sessionId: string): Promise<void> {
  await execFile("screen", ["-S", sessionId, "-X", "quit"]);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingScreenSessionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ESRCH") {
    return true;
  }

  const stdout = String(
    (error as { stdout?: string } | undefined)?.stdout ?? "",
  );
  const stderr = String(
    (error as { stderr?: string } | undefined)?.stderr ?? "",
  );
  const message = error instanceof Error ? error.message : "";
  const combined = `${stdout}\n${stderr}\n${message}`.toLowerCase();
  return (
    combined.includes("no screen session found") ||
    combined.includes("no such screen session") ||
    combined.includes("no such session")
  );
}
