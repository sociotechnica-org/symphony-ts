#!/usr/bin/env node
import { runCli } from "../src/cli/index.js";

runCli(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
