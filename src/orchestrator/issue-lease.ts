import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/logger.js";

function isStaleLeaseError(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR" || code === "ESRCH";
}

export class LocalIssueLeaseManager {
  readonly #workspaceRoot: string;
  readonly #logger: Logger;

  constructor(workspaceRoot: string, logger: Logger) {
    this.#workspaceRoot = workspaceRoot;
    this.#logger = logger;
  }

  async acquire(issueNumber: number): Promise<string | null> {
    const lockDir = path.join(
      this.#workspaceRoot,
      ".symphony-locks",
      issueNumber.toString(),
    );
    const pidFile = path.join(lockDir, "pid");
    for (;;) {
      try {
        await fs.mkdir(lockDir, { recursive: false });
        await fs.writeFile(pidFile, `${process.pid}\n`, "utf8");
        return lockDir;
      } catch (error) {
        const systemError = error as NodeJS.ErrnoException;
        if (systemError.code === "ENOENT") {
          await fs.mkdir(path.dirname(lockDir), { recursive: true });
          continue;
        }
        if (systemError.code === "EEXIST") {
          if (await this.#isStaleLease(pidFile)) {
            await fs.rm(lockDir, { recursive: true, force: true });
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

  async #isStaleLease(pidFile: string): Promise<boolean> {
    try {
      const rawPid = await fs.readFile(pidFile, "utf8");
      const pid = Number.parseInt(rawPid.trim(), 10);
      if (!Number.isInteger(pid)) {
        return true;
      }
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      return isStaleLeaseError(systemError.code);
    }
  }
}
