#!/usr/bin/env node
import path from "node:path";
import {
  writeOperatorStatusSnapshot,
  type OperatorStatusSnapshot,
} from "../src/observability/operator-status.js";

interface Args {
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  return {
    statusJsonPath: path.resolve(
      readRequiredOptionValue(argv, "--status-json"),
    ),
    statusMdPath: path.resolve(readRequiredOptionValue(argv, "--status-md")),
  };
}

function readRequiredOptionValue(
  argv: readonly string[],
  option: string,
): string {
  const index = argv.indexOf(option);
  if (index === -1) {
    throw new Error(`Missing required option ${option}`);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await readStdin()) as OperatorStatusSnapshot;
  await writeOperatorStatusSnapshot(
    {
      statusJsonPath: args.statusJsonPath,
      statusMdPath: args.statusMdPath,
    },
    snapshot,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
