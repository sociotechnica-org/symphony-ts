#!/usr/bin/env node
import path from "node:path";
import {
  refreshOperatorControlState,
  renderOperatorControlState,
} from "../src/observability/operator-control-state.js";

interface Args {
  readonly workflowPath?: string;
  readonly operatorRepoRoot: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const workflowPath = readOptionalOptionValue(argv, "--workflow");
  return {
    ...(workflowPath === null ? {} : { workflowPath }),
    operatorRepoRoot: path.resolve(
      readOptionalOptionValue(argv, "--operator-repo-root") ?? process.cwd(),
    ),
    json: argv.includes("--json"),
  };
}

function readOptionalOptionValue(
  argv: readonly string[],
  option: string,
): string | null {
  const index = argv.indexOf(option);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const document = await refreshOperatorControlState({
    workflowPath: path.resolve(args.workflowPath ?? "WORKFLOW.md"),
    operatorRepoRoot: args.operatorRepoRoot,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
    return;
  }

  process.stdout.write(`${renderOperatorControlState(document)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
