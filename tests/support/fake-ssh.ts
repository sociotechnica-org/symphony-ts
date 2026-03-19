import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "./git.js";

export async function createFakeSshExecutable(): Promise<string> {
  const dir = await createTempDir("fake-ssh-");
  const executablePath = path.join(dir, "ssh");
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
let destinationIndex = args.findIndex((arg) => !arg.startsWith("-"));
if (destinationIndex < 0) {
  process.stderr.write("fake ssh expected a destination\\n");
  process.exit(1);
}
const commandArgs = args.slice(destinationIndex + 1);
if (commandArgs.length === 0) {
  process.stderr.write("fake ssh expected a remote command\\n");
  process.exit(1);
}

const child = spawn("sh", ["-lc", commandArgs.join(" ")], {
  stdio: "inherit",
  env: {
    ...process.env,
    FAKE_SSH_DESTINATION: args[destinationIndex],
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
`,
    "utf8",
  );
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}
