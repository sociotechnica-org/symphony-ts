#!/usr/bin/env node
import path from "node:path";
import {
  updateOperatorStatusProgress,
  type OperatorProgressMilestone,
  type OperatorStatusProgressUpdate,
} from "../src/observability/operator-status.js";

interface Args {
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
  readonly update: OperatorStatusProgressUpdate;
}

const validMilestones = new Set<OperatorProgressMilestone>([
  "cycle-start",
  "checkpoint-runtime",
  "checkpoint-report-review",
  "checkpoint-release",
  "checkpoint-actions",
  "landing-issued",
  "post-landing-follow-through",
  "post-merge-refresh",
  "wake-up-log",
  "cycle-finished",
  "cycle-failed",
]);

function parseArgs(argv: readonly string[]): Args {
  const milestoneValue = readRequiredOptionValue(argv, "--milestone");
  if (!validMilestones.has(milestoneValue as OperatorProgressMilestone)) {
    throw new Error(`Unknown operator progress milestone: ${milestoneValue}`);
  }
  const statusJsonValue =
    readOptionalOptionValue(argv, "--status-json") ??
    process.env.SYMPHONY_OPERATOR_STATUS_JSON;
  const statusMdValue =
    readOptionalOptionValue(argv, "--status-md") ??
    process.env.SYMPHONY_OPERATOR_STATUS_MD;
  if (!statusJsonValue || !statusMdValue) {
    throw new Error(
      "Operator status paths are required via --status-json/--status-md or SYMPHONY_OPERATOR_STATUS_JSON/SYMPHONY_OPERATOR_STATUS_MD.",
    );
  }

  return {
    statusJsonPath: path.resolve(statusJsonValue),
    statusMdPath: path.resolve(statusMdValue),
    update: {
      milestone: milestoneValue as OperatorProgressMilestone,
      summary: readRequiredOptionValue(argv, "--summary"),
      relatedIssueNumber: readOptionalNumberOptionValue(argv, "--issue-number"),
      relatedIssueIdentifier: readOptionalOptionValue(
        argv,
        "--issue-identifier",
      ),
      relatedPullRequestNumber: readOptionalNumberOptionValue(
        argv,
        "--pull-request-number",
      ),
    },
  };
}

function readRequiredOptionValue(
  argv: readonly string[],
  option: string,
): string {
  const value = readOptionalOptionValue(argv, option);
  if (value === null || value.length === 0) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
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

function readOptionalNumberOptionValue(
  argv: readonly string[],
  option: string,
): number | null {
  const value = readOptionalOptionValue(argv, option);
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for ${option}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await updateOperatorStatusProgress(
    {
      statusJsonPath: args.statusJsonPath,
      statusMdPath: args.statusMdPath,
    },
    args.update,
  );
  process.stdout.write(`${JSON.stringify(snapshot.progress)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
