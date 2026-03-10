import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { syncGitMirror } from "../../src/startup/github-mirror.js";
import { createSeedRemote, createTempDir } from "../support/git.js";

const execFileAsync = promisify(execFile);

describe("github mirror", () => {
  it("clones and fast-forwards a local mirror from the source remote", async () => {
    const { remotePath } = await createSeedRemote();
    const mirrorRoot = await createTempDir("symphony-mirror-");
    const mirrorDir = path.join(mirrorRoot, "github", "upstream");

    await syncGitMirror({
      sourceUrl: remotePath,
      branch: "main",
      mirrorDir,
    });

    expect(await fs.readFile(path.join(mirrorDir, "README.md"), "utf8")).toContain(
      "# mock repo",
    );

    const writerDir = await createTempDir("symphony-mirror-writer-");
    await execFileAsync("git", ["clone", remotePath, writerDir]);
    await execFileAsync("git", ["checkout", "main"], { cwd: writerDir });
    await execFileAsync("git", ["config", "user.name", "Symphony Test"], {
      cwd: writerDir,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "symphony-test@example.com"],
      { cwd: writerDir },
    );
    await fs.writeFile(path.join(writerDir, "CHANGELOG.md"), "updated\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: writerDir });
    await execFileAsync("git", ["commit", "-m", "update mirror source"], {
      cwd: writerDir,
    });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: writerDir });

    await syncGitMirror({
      sourceUrl: remotePath,
      branch: "main",
      mirrorDir,
    });

    expect(
      (await fs.readFile(path.join(mirrorDir, "CHANGELOG.md"), "utf8")).trim(),
    ).toBe("updated");
  });
});
