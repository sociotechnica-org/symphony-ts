import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli/index.js";
import {
  defaultMirrorDir,
  resolveGitRemoteUrl,
  syncGitMirror,
} from "../src/startup/github-mirror.js";

function repoRootFromScript(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "..");
}

function shouldSync(argv: readonly string[]): boolean {
  return argv[2] === "run";
}

async function main(argv: readonly string[]): Promise<void> {
  if (shouldSync(argv)) {
    const repoRoot = repoRootFromScript();
    const sourceUrl = await resolveGitRemoteUrl(repoRoot);
    await syncGitMirror({
      sourceUrl,
      branch: "main",
      mirrorDir: defaultMirrorDir(repoRoot),
    });
  }

  await runCli(argv);
}

main(process.argv).catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
