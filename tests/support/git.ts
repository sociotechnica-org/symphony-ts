import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createSeedRemote(): Promise<{
  readonly rootDir: string;
  readonly remotePath: string;
}> {
  const rootDir = await createTempDir("symphony-git-");
  const seedPath = path.join(rootDir, "seed");
  const remotePath = path.join(rootDir, "remote.git");
  await fs.mkdir(seedPath, { recursive: true });
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: seedPath });
  await execFileAsync("git", ["config", "user.name", "Symphony Test"], {
    cwd: seedPath,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "symphony-test@example.com"],
    { cwd: seedPath },
  );
  await fs.writeFile(path.join(seedPath, "README.md"), "# mock repo\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: seedPath });
  await execFileAsync("git", ["commit", "-m", "initial commit"], {
    cwd: seedPath,
  });
  await execFileAsync("git", ["remote", "add", "origin", remotePath], {
    cwd: seedPath,
  });
  await execFileAsync("git", ["push", "-u", "origin", "main"], {
    cwd: seedPath,
  });
  return { rootDir, remotePath };
}

export async function readRemoteBranchFile(
  remotePath: string,
  branchName: string,
  filePath: string,
): Promise<string> {
  const checkoutDir = await createTempDir("symphony-verify-");
  try {
    await execFileAsync("git", ["clone", remotePath, checkoutDir]);
    await execFileAsync("git", ["checkout", branchName], { cwd: checkoutDir });
    return await fs.readFile(path.join(checkoutDir, filePath), "utf8");
  } finally {
    await fs.rm(checkoutDir, { recursive: true, force: true });
  }
}

export async function countRemoteBranchCommits(
  remotePath: string,
  branchName: string,
): Promise<number> {
  const checkoutDir = await createTempDir("symphony-verify-");
  try {
    await execFileAsync("git", ["clone", remotePath, checkoutDir]);
    await execFileAsync("git", ["checkout", branchName], { cwd: checkoutDir });
    const result = await execFileAsync(
      "git",
      ["rev-list", "--count", branchName, "^origin/main"],
      { cwd: checkoutDir },
    );
    return Number(result.stdout.trim());
  } finally {
    await fs.rm(checkoutDir, { recursive: true, force: true });
  }
}
