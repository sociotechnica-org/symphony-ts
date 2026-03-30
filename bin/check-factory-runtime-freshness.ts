#!/usr/bin/env node
import path from "node:path";
import { inspectFactoryControl } from "../src/cli/factory-control.js";
import { collectFactoryRuntimeIdentity } from "../src/observability/runtime-identity.js";
import { assessOperatorRuntimeFreshness } from "../src/observability/operator-runtime-freshness.js";

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

function renderText(
  result: ReturnType<typeof assessOperatorRuntimeFreshness>,
): string {
  return [
    `Freshness: ${result.kind}`,
    `Runtime head: ${result.runtimeHeadSha ?? "unavailable"}`,
    `Engine head: ${result.engineHeadSha ?? "unavailable"}`,
    `Control state: ${result.controlState}`,
    `Factory state: ${result.factoryState ?? "unavailable"}`,
    `Active issues: ${result.activeIssueCount.toString()}`,
    `Should restart now: ${result.shouldRestart ? "yes" : "no"}`,
    `Summary: ${result.summary}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const status = await inspectFactoryControl({
    ...(args.workflowPath === undefined
      ? {}
      : { workflowPath: args.workflowPath }),
  });
  const engineRuntimeIdentity = await collectFactoryRuntimeIdentity(
    args.operatorRepoRoot,
  );
  const result = assessOperatorRuntimeFreshness({
    status,
    engineRuntimeIdentity,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${renderText(result)}\n`);
}

main().catch((error: Error) => {
  process.stderr.write(
    error.stack ? `${error.stack}\n` : `${error.name}: ${error.message}\n`,
  );
  process.exit(1);
});
