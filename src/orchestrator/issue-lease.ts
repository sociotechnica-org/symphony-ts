import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunSession, RunSpawnEvent } from "../domain/run.js";
import type { Logger } from "../observability/logger.js";

function isStaleLeaseError(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR" || code === "ESRCH";
}

export interface ActiveRunLeaseRecord {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly branchName: string;
  readonly runSessionId: string;
  readonly attempt: number;
  readonly ownerPid: number;
  readonly runnerPid: number | null;
  readonly runRecordedAt: string;
  readonly runnerStartedAt: string | null;
  readonly updatedAt: string;
}

export interface IssueLeaseSnapshot {
  readonly kind:
    | "missing"
    | "active"
    | "stale-owner"
    | "stale-owner-runner"
    | "invalid";
  readonly issueNumber: number;
  readonly lockDir: string | null;
  readonly ownerPid: number | null;
  readonly ownerAlive: boolean | null;
  readonly runnerPid: number | null;
  readonly runnerAlive: boolean | null;
  readonly record: ActiveRunLeaseRecord | null;
}

const RUN_RECORD_FILE = "run.json";
const PID_FILE = "pid";
type SignalDelivery = "sent" | "missing" | "denied";

export class LocalIssueLeaseManager {
  readonly #workspaceRoot: string;
  readonly #logger: Logger;

  constructor(workspaceRoot: string, logger: Logger) {
    this.#workspaceRoot = workspaceRoot;
    this.#logger = logger;
  }

  async acquire(issueNumber: number): Promise<string | null> {
    const lockDir = this.#lockDir(issueNumber);
    const pidFile = this.#pidFile(lockDir);
    for (;;) {
      try {
        await fs.mkdir(lockDir, { recursive: false });
        try {
          await fs.writeFile(pidFile, `${process.pid}\n`, "utf8");
        } catch (error) {
          try {
            await fs.rm(lockDir, { recursive: true, force: true });
          } catch (cleanupError) {
            this.#logger.warn("Failed to clean up incomplete issue lease", {
              issueNumber,
              lockDir,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            });
          }
          throw error;
        }
        return lockDir;
      } catch (error) {
        const systemError = error as NodeJS.ErrnoException;
        if (systemError.code === "ENOENT") {
          await fs.mkdir(path.dirname(lockDir), { recursive: true });
          continue;
        }
        if (systemError.code === "EEXIST") {
          const recovered = await this.reconcile(issueNumber);
          if (recovered.kind !== "active") {
            continue;
          }
          this.#logger.info("Issue already leased by another local worker", {
            issueNumber,
          });
          return null;
        }
        throw error;
      }
    }
  }

  async release(lockDir: string): Promise<void> {
    await fs.rm(lockDir, { recursive: true, force: true });
  }

  async recordRun(lockDir: string, session: RunSession): Promise<void> {
    const record: ActiveRunLeaseRecord = {
      issueNumber: session.issue.number,
      issueIdentifier: session.issue.identifier,
      branchName: session.workspace.branchName,
      runSessionId: session.id,
      attempt: session.attempt.sequence,
      ownerPid: process.pid,
      runnerPid: null,
      runRecordedAt: new Date().toISOString(),
      runnerStartedAt: null,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      this.#recordFile(lockDir),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  recordRunnerSpawn(lockDir: string, event: RunSpawnEvent): void {
    const record = this.#readRecordSync(lockDir);
    if (record === null) {
      return;
    }
    const nextRecord: ActiveRunLeaseRecord = {
      ...record,
      runnerPid: event.pid,
      runnerStartedAt: event.spawnedAt,
      updatedAt: event.spawnedAt,
    };
    fsSync.writeFileSync(
      this.#recordFile(lockDir),
      JSON.stringify(nextRecord, null, 2),
      "utf8",
    );
  }

  async inspect(issueNumber: number): Promise<IssueLeaseSnapshot> {
    const lockDir = this.#lockDir(issueNumber);
    try {
      await fs.stat(lockDir);
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (isStaleLeaseError(systemError.code)) {
        return {
          kind: "missing",
          issueNumber,
          lockDir: null,
          ownerPid: null,
          ownerAlive: null,
          runnerPid: null,
          runnerAlive: null,
          record: null,
        };
      }
      throw error;
    }

    const [ownerPid, record] = await Promise.all([
      this.#readOwnerPid(lockDir),
      this.#readRecord(lockDir),
    ]);

    const ownerAlive =
      ownerPid === null ? null : this.#isProcessAlive(ownerPid);
    const runnerPid = record?.runnerPid ?? null;
    const runnerAlive =
      runnerPid === null ? null : this.#isProcessAlive(runnerPid);

    if (ownerPid === null) {
      return {
        kind: "invalid",
        issueNumber,
        lockDir,
        ownerPid,
        ownerAlive,
        runnerPid,
        runnerAlive,
        record,
      };
    }

    if (ownerAlive) {
      return {
        kind: "active",
        issueNumber,
        lockDir,
        ownerPid,
        ownerAlive,
        runnerPid,
        runnerAlive,
        record,
      };
    }

    return {
      kind: runnerAlive ? "stale-owner-runner" : "stale-owner",
      issueNumber,
      lockDir,
      ownerPid,
      ownerAlive,
      runnerPid,
      runnerAlive,
      record,
    };
  }

  async reconcile(issueNumber: number): Promise<IssueLeaseSnapshot> {
    const snapshot = await this.inspect(issueNumber);
    if (snapshot.kind === "missing" || snapshot.kind === "active") {
      return snapshot;
    }

    if (
      (snapshot.kind === "stale-owner-runner" || snapshot.kind === "invalid") &&
      snapshot.runnerPid !== null
    ) {
      await this.#terminateRunner(issueNumber, snapshot.runnerPid);
    }

    if (snapshot.lockDir === null) {
      throw new Error(
        `Invariant violated: non-active lease snapshot for issue ${issueNumber.toString()} had no lockDir`,
      );
    }

    await fs.rm(snapshot.lockDir, { recursive: true, force: true });

    return snapshot;
  }

  #lockDir(issueNumber: number): string {
    return path.join(
      this.#workspaceRoot,
      ".symphony-locks",
      issueNumber.toString(),
    );
  }

  #pidFile(lockDir: string): string {
    return path.join(lockDir, PID_FILE);
  }

  #recordFile(lockDir: string): string {
    return path.join(lockDir, RUN_RECORD_FILE);
  }

  async #readOwnerPid(lockDir: string): Promise<number | null> {
    try {
      const rawPid = await fs.readFile(this.#pidFile(lockDir), "utf8");
      const pid = Number.parseInt(rawPid.trim(), 10);
      return Number.isInteger(pid) ? pid : null;
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (isStaleLeaseError(systemError.code)) {
        return null;
      }
      throw error;
    }
  }

  async #readRecord(lockDir: string): Promise<ActiveRunLeaseRecord | null> {
    try {
      const raw = await fs.readFile(this.#recordFile(lockDir), "utf8");
      return JSON.parse(raw) as ActiveRunLeaseRecord;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      const systemError = error as NodeJS.ErrnoException;
      if (isStaleLeaseError(systemError.code)) {
        return null;
      }
      throw error;
    }
  }

  #readRecordSync(lockDir: string): ActiveRunLeaseRecord | null {
    try {
      const raw = fsSync.readFileSync(this.#recordFile(lockDir), "utf8");
      return JSON.parse(raw) as ActiveRunLeaseRecord;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      const systemError = error as NodeJS.ErrnoException;
      if (isStaleLeaseError(systemError.code)) {
        return null;
      }
      throw error;
    }
  }

  #isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      return systemError.code === "EPERM";
    }
  }

  async #terminateRunner(issueNumber: number, pid: number): Promise<void> {
    const sigtermResult = this.#sendSignal(pid, "SIGTERM");
    if (sigtermResult !== "sent") {
      if (sigtermResult === "denied") {
        this.#logger.warn(
          "Unable to signal orphaned runner process; clearing lease anyway",
          {
            issueNumber,
            runnerPid: pid,
            signal: "SIGTERM",
          },
        );
      }
      return;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.#isProcessAlive(pid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const sigkillResult = this.#sendSignal(pid, "SIGKILL");
    if (sigkillResult === "sent") {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (!this.#isProcessAlive(pid)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } else if (sigkillResult === "missing") {
      return;
    } else if (sigkillResult === "denied") {
      this.#logger.warn(
        "Unable to signal orphaned runner process; clearing lease anyway",
        {
          issueNumber,
          runnerPid: pid,
          signal: "SIGKILL",
        },
      );
      return;
    }

    this.#logger.warn(
      "Orphaned runner process did not terminate cleanly; clearing lease anyway",
      {
        issueNumber,
        runnerPid: pid,
      },
    );
  }

  #sendSignal(pid: number, signal: NodeJS.Signals): SignalDelivery {
    try {
      process.kill(pid, signal);
      return "sent";
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (isStaleLeaseError(systemError.code)) {
        return "missing";
      }
      if (systemError.code === "EPERM") {
        return "denied";
      }
      throw error;
    }
  }
}
