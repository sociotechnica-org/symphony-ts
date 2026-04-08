import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "../support/git.js";
import {
  assertExited,
  terminateChildProcess,
  waitForExit,
} from "../support/process.js";

async function waitForFile(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.access(targetPath);
      return;
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw new Error(`Timed out waiting for ${targetPath}`);
}

describe("process test support", () => {
  const createdPaths = new Set<string>();

  afterEach(async () => {
    for (const targetPath of createdPaths) {
      await fs.rm(targetPath, { recursive: true, force: true });
    }
    createdPaths.clear();
  });

  it("terminates detached subprocess descendants together with the parent group", async () => {
    const tempDir = await createTempDir("symphony-process-support-");
    const pidFile = path.join(tempDir, "descendant.pid");
    createdPaths.add(tempDir);

    const child = spawn(
      "node",
      [
        "-e",
        `
          const fs = require("node:fs");
          const { spawn } = require("node:child_process");
          const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
          );
          fs.writeFileSync(process.argv[1], String(child.pid));
          setInterval(() => {}, 1000);
        `,
        pidFile,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    await waitForFile(pidFile);
    const descendantPid = Number.parseInt(
      await fs.readFile(pidFile, "utf8"),
      10,
    );
    expect(descendantPid).toBeGreaterThan(0);

    await terminateChildProcess(child);
    // terminateChildProcess already waited for the detached parent's process
    // group to disappear, so this is a strict descendant-exit assertion.
    await assertExited(descendantPid);
  });

  it("terminates detached subprocess descendants after the parent exits first", async () => {
    const tempDir = await createTempDir("symphony-process-support-exited-parent-");
    const pidFile = path.join(tempDir, "descendant.pid");
    createdPaths.add(tempDir);

    const child = spawn(
      "node",
      [
        "-e",
        `
          const fs = require("node:fs");
          const { spawn } = require("node:child_process");
          const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
          );
          child.unref();
          fs.writeFileSync(process.argv[1], String(child.pid));
          process.exit(0);
        `,
        pidFile,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    await waitForFile(pidFile);
    const descendantPid = Number.parseInt(
      await fs.readFile(pidFile, "utf8"),
      10,
    );
    expect(descendantPid).toBeGreaterThan(0);

    await waitForExit(child.pid!);
    await terminateChildProcess(child);
    await assertExited(descendantPid);
  });
});
