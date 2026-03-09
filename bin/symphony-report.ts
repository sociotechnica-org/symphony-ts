#!/usr/bin/env node
import { runReportCli } from "../src/cli/report.js";

runReportCli(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
