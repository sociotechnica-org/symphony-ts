#!/usr/bin/env node
import path from "node:path";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../src/domain/instance-identity.js";
import { promoteOperatorReadyIssues } from "../src/observability/operator-ready-promotion.js";

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

function renderText(args: {
  readonly releaseStateFile: string;
  readonly state: Awaited<ReturnType<typeof promoteOperatorReadyIssues>>["state"];
}): string {
  const promotion = args.state.promotion;
  return [
    `Ready promotion: ${promotion.state}`,
    `Release state file: ${args.releaseStateFile}`,
    `Release id: ${args.state.configuration.releaseId ?? "unconfigured"}`,
    `Eligible issues: ${
      promotion.eligibleIssues.length === 0
        ? "none"
        : promotion.eligibleIssues
            .map((issue) => `#${issue.issueNumber.toString()}`)
            .join(", ")
    }`,
    `Ready labels added: ${
      promotion.readyLabelsAdded.length === 0
        ? "none"
        : promotion.readyLabelsAdded
            .map((issue) => `#${issue.issueNumber.toString()}`)
            .join(", ")
    }`,
    `Ready labels removed: ${
      promotion.readyLabelsRemoved.length === 0
        ? "none"
        : promotion.readyLabelsRemoved
            .map((issue) => `#${issue.issueNumber.toString()}`)
            .join(", ")
    }`,
    `Promoted at: ${promotion.promotedAt}`,
    `Summary: ${promotion.summary}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const identity = deriveSymphonyInstanceIdentity(args.workflowPath);
  const paths = deriveOperatorInstanceStatePaths({
    operatorRepoRoot: args.operatorRepoRoot,
    instanceKey: identity.instanceKey,
  });
  const result = await promoteOperatorReadyIssues({
    workflowPath: args.workflowPath,
    releaseStateFile: paths.releaseStatePath,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write(
    `${renderText({
      releaseStateFile: paths.releaseStatePath,
      state: result.state,
    })}\n`,
  );
}

main().catch((error: Error) => {
  process.stderr.write(
    error.stack ? `${error.stack}\n` : `${error.name}: ${error.message}\n`,
  );
  process.exit(1);
});
