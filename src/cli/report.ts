import path from "node:path";
import { loadWorkflowWorkspaceRoot } from "../config/workflow.js";
import { publishIssueToFactoryRuns } from "../integration/factory-runs.js";
import { writeIssueReport } from "../observability/issue-report.js";

export type ReportCliArgs =
  | {
      readonly command: "issue";
      readonly issueNumber: number;
      readonly workflowPath: string;
    }
  | {
      readonly command: "publish";
      readonly issueNumber: number;
      readonly workflowPath: string;
      readonly archiveRoot: string;
    };

export function parseReportArgs(argv: readonly string[]): ReportCliArgs {
  const args = argv.slice(2);
  const command = args[0];

  if (command !== "issue" && command !== "publish") {
    throw new Error(
      "Usage: symphony-report <issue|publish> --issue <number> [--workflow <path>] [--archive-root <path>]",
    );
  }

  const issueValue = readOptionValue(args, "--issue");
  if (issueValue === null) {
    throw new Error("Missing required --issue <number> option");
  }
  if (!/^[1-9]\d*$/u.test(issueValue)) {
    throw new Error(`Invalid issue number: ${issueValue}`);
  }
  const issueNumber = Number.parseInt(issueValue, 10);

  const workflowPath = readOptionValue(args, "--workflow") ?? "WORKFLOW.md";
  if (command === "issue") {
    return {
      command: "issue",
      issueNumber,
      workflowPath: path.resolve(process.cwd(), workflowPath),
    };
  }

  const archiveRoot = readOptionValue(args, "--archive-root");
  if (archiveRoot === null) {
    throw new Error("Missing required --archive-root <path> option");
  }

  return {
    command: "publish",
    issueNumber,
    workflowPath: path.resolve(process.cwd(), workflowPath),
    archiveRoot: path.resolve(process.cwd(), archiveRoot),
  };
}

export async function runReportCli(argv: readonly string[]): Promise<void> {
  const args = parseReportArgs(argv);
  const workspaceRoot = await loadWorkflowWorkspaceRoot(args.workflowPath);
  if (args.command === "issue") {
    const generated = await writeIssueReport(workspaceRoot, args.issueNumber);
    process.stdout.write(
      `Generated issue report for #${args.issueNumber.toString()}\nreport.json: ${generated.outputPaths.reportJsonFile}\nreport.md: ${generated.outputPaths.reportMarkdownFile}\n`,
    );
    return;
  }

  const published = await publishIssueToFactoryRuns({
    workspaceRoot,
    sourceRoot: path.dirname(args.workflowPath),
    archiveRoot: args.archiveRoot,
    issueNumber: args.issueNumber,
  });
  process.stdout.write(
    `Published issue #${args.issueNumber.toString()} to factory-runs\npublication id: ${published.publicationId}\nstatus: ${published.status}\narchive root: ${args.archiveRoot}\npublication dir: ${published.paths.publicationRoot}\nmetadata.json: ${published.paths.metadataFile}\nlogs copied: ${published.metadata.logs.copiedCount.toString()}\nlogs referenced: ${published.metadata.logs.referencedCount.toString()}\nlogs unavailable: ${published.metadata.logs.unavailableCount.toString()}\n`,
  );
}

function readOptionValue(args: readonly string[], flag: string): string | null {
  const index = args.findIndex((arg) => arg === flag);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
