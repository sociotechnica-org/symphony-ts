import type { ChildProcess } from "node:child_process";

const PROCESS_POLL_ATTEMPTS = 50;
const PROCESS_POLL_INTERVAL_MS = 20;
const PROCESS_TERMINATION_GRACE_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalDetachedProcessGroupLeader(
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code !== "ESRCH") {
      // Detached test children should be their own process-group leaders.
      // Falling back to pid-only signaling after any other error would risk
      // hiding a descendant leak behind a partially successful shutdown.
      throw error;
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

async function waitForExitWithAttempts(
  pid: number,
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(pid, 0);
      await delay(PROCESS_POLL_INTERVAL_MS);
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") {
        return;
      }
      if (systemError.code === "EPERM") {
        await delay(PROCESS_POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

export async function waitForExit(pid: number): Promise<void> {
  await waitForExitWithAttempts(pid, PROCESS_POLL_ATTEMPTS);
}

export async function assertExited(pid: number): Promise<void> {
  await waitForExitWithAttempts(pid, 1);
}

async function waitForDetachedProcessGroupExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < PROCESS_POLL_ATTEMPTS; attempt += 1) {
    try {
      process.kill(-pid, 0);
      await delay(PROCESS_POLL_INTERVAL_MS);
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") {
        return;
      }
      if (systemError.code === "EPERM") {
        await delay(PROCESS_POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Timed out waiting for process group ${pid} to exit`);
}

type TrackedStream = {
  closed?: boolean;
  destroyed?: boolean;
  readable?: boolean;
  readableEnded?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
};

function isStreamOpen(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream | null,
): boolean {
  if (stream === null) {
    return false;
  }

  const tracked = stream as TrackedStream;
  if (tracked.closed === true || tracked.destroyed === true) {
    return false;
  }
  if (tracked.readable === true && tracked.readableEnded !== true) {
    return true;
  }
  if (tracked.writable === true && tracked.writableEnded !== true) {
    return true;
  }

  return false;
}

async function waitForClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    !isStreamOpen(child.stdin) &&
    !isStreamOpen(child.stdout) &&
    !isStreamOpen(child.stderr)
  ) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for pid ${child.pid?.toString() ?? "unknown"} to close`,
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("error", onError);
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.once("close", onClose);
    child.once("error", onError);
  });
}

export async function terminateChildProcess(
  child: ChildProcess,
  graceMs = PROCESS_TERMINATION_GRACE_MS,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await waitForClose(child, graceMs);
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForClose(child, graceMs);
    await waitForExit(pid);
    await waitForDetachedProcessGroupExit(pid);
    return;
  }

  let closeError: unknown;
  // terminateChildProcess is only used with detached test children, so the
  // child pid is also the process-group leader we can target via -pid.
  signalDetachedProcessGroupLeader(pid, "SIGTERM");

  try {
    await waitForClose(child, graceMs);
  } catch {
    signalDetachedProcessGroupLeader(pid, "SIGKILL");
    try {
      await waitForClose(child, graceMs);
    } catch (error) {
      closeError = error;
    }
  }

  try {
    await waitForExit(pid);
  } catch (error) {
    throw closeError ?? error;
  }
  // Detached test children lead their own process groups. Waiting for the
  // group to disappear keeps descendant shells from leaking past test exit.
  try {
    await waitForDetachedProcessGroupExit(pid);
  } catch (error) {
    throw closeError ?? error;
  }
}
