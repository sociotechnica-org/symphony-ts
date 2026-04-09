#!/usr/bin/env node
import {
  assertOperatorRuntimeBootstrap,
  parseOperatorLoopCliArgs,
  renderOperatorLoopUsage,
  resolveOperatorRuntimeContext,
} from "../src/operator/context.js";
import { runOperatorLoop } from "../src/operator/runtime.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${renderOperatorLoopUsage()}\n`);
    return;
  }

  const cli = parseOperatorLoopCliArgs(argv);
  const context = resolveOperatorRuntimeContext({
    repoRoot: cli.repoRoot,
    promptFile: cli.promptFile,
    argv: cli.publicArgv,
    env: process.env,
  });
  await assertOperatorRuntimeBootstrap(context);
  const exitCode = await runOperatorLoop(context);
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
