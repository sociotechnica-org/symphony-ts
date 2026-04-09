#!/usr/bin/env node
import { inspectFactoryControl } from "../src/cli/factory-control.js";
import { collectFactoryRuntimeIdentity } from "../src/observability/runtime-identity.js";
import { assessOperatorRuntimeFreshness } from "../src/observability/operator-runtime-freshness.js";
import {
  collectFactoryWorkflowIdentity,
  renderFactoryWorkflowIdentity,
} from "../src/observability/workflow-identity.js";
import { renderFactoryRuntimeIdentity } from "../src/observability/runtime-identity.js";

interface Args {
  readonly workflowPath?: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const workflowPath = readOptionalOptionValue(argv, "--workflow");
  // Accept the old flag for compatibility with older operator scripts even
  // though runtime freshness now reads the selected instance runtime checkout.
  readOptionalOptionValue(argv, "--operator-repo-root");
  return {
    ...(workflowPath === null ? {} : { workflowPath }),
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
    `Restart assessment: ${result.kind}`,
    `Running runtime: ${renderFactoryRuntimeIdentity(result.runningRuntimeIdentity ?? null)}`,
    `Current runtime: ${renderFactoryRuntimeIdentity(result.currentRuntimeIdentity ?? null)}`,
    `Running workflow: ${renderFactoryWorkflowIdentity(result.runningWorkflowIdentity)}`,
    `Current workflow: ${renderFactoryWorkflowIdentity(result.currentWorkflowIdentity)}`,
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
  const currentRuntimeIdentity = await collectFactoryRuntimeIdentity(
    status.paths.runtimeRoot,
  );
  const currentWorkflowIdentity = await collectFactoryWorkflowIdentity(
    status.paths.workflowPath,
  );
  const result = assessOperatorRuntimeFreshness({
    status,
    currentRuntimeIdentity,
    currentWorkflowIdentity,
  });

  if (args.json) {
    // Keep the deprecated engineHeadSha alias in the serialized snapshot for
    // older operator consumers that still read that field.
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
