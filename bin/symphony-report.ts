#!/usr/bin/env node
import { runReportCli } from "../src/cli/report.js";

runReportCli(process.argv).catch((error: Error) => {
  process.stderr.write(
    error.stack ? `${error.stack}\n` : `${error.name}: ${error.message}\n`,
  );
  process.exit(1);
});
