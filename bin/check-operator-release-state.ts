#!/usr/bin/env node
import path from "node:path";
import { loadWorkflowInstancePaths } from "../src/config/workflow.js";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../src/domain/instance-identity.js";
import {
  syncOperatorReleaseState,
  type OperatorReleaseStateDocument,
} from "../src/observability/operator-release-state.js";

interface Args {
  readonly workflowPath: string;
  readonly operatorRepoRoot: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  return {
    workflowPath: path.resolve(
      readOptionalOptionValue(argv, "--workflow") ?? "WORKFLOW.md",
    ),
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

function renderText(state: OperatorReleaseStateDocument, filePath: string): string {
  return [
    `Release state: ${state.evaluation.advancementState}`,
    `Release state file: ${filePath}`,
    `Release id: ${state.configuration.releaseId ?? "unconfigured"}`,
    `Blocking prerequisite: ${state.evaluation.blockingPrerequisite?.issueNumber.toString() ?? "none"}`,
    `Blocked downstream: ${
      state.evaluation.blockedDownstream.length === 0
        ? "none"
        : state.evaluation.blockedDownstream
            .map((issue) => `#${issue.issueNumber.toString()}`)
            .join(", ")
    }`,
    `Unresolved references: ${
      state.evaluation.unresolvedReferences.length === 0
        ? "none"
        : state.evaluation.unresolvedReferences
            .map((issue) => `#${issue.issueNumber.toString()}`)
            .join(", ")
    }`,
    `Updated at: ${state.updatedAt}`,
    `Summary: ${state.evaluation.summary}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const instance = await loadWorkflowInstancePaths(args.workflowPath);
  const identity = deriveSymphonyInstanceIdentity(args.workflowPath);
  const paths = deriveOperatorInstanceStatePaths({
    operatorRepoRoot: args.operatorRepoRoot,
    instanceKey: identity.instanceKey,
  });
  const state = await syncOperatorReleaseState({
    instance,
    releaseStateFile: paths.releaseStatePath,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        releaseStateFile: paths.releaseStatePath,
        state,
      })}\n`,
    );
    return;
  }

  process.stdout.write(`${renderText(state, paths.releaseStatePath)}\n`);
}

main().catch((error: Error) => {
  process.stderr.write(
    error.stack ? `${error.stack}\n` : `${error.name}: ${error.message}\n`,
  );
  process.exit(1);
});
