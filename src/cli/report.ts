import path from "node:path";
import { loadWorkflow } from "../config/workflow.js";
import { writeIssueReport } from "../observability/issue-report.js";

export interface ReportCliArgs {
  readonly command: "issue";
  readonly issueNumber: number;
  readonly workflowPath: string;
}

export function parseReportArgs(argv: readonly string[]): ReportCliArgs {
  const args = argv.slice(2);
  const command = args[0];

  if (command !== "issue") {
    throw new Error(
      "Usage: symphony-report issue --issue <number> [--workflow <path>]",
    );
  }

  const issueValue = readOptionValue(args, "--issue");
  if (issueValue === null) {
    throw new Error("Missing value for --issue");
  }
  const issueNumber = Number.parseInt(issueValue, 10);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(`Invalid issue number: ${issueValue}`);
  }

  const workflowPath = readOptionValue(args, "--workflow") ?? "WORKFLOW.md";
  return {
    command: "issue",
    issueNumber,
    workflowPath: path.resolve(process.cwd(), workflowPath),
  };
}

export async function runReportCli(argv: readonly string[]): Promise<void> {
  const args = parseReportArgs(argv);
  const workflow = await loadWorkflow(args.workflowPath);
  const generated = await writeIssueReport(
    workflow.config.workspace.root,
    args.issueNumber,
  );
  process.stdout.write(
    `Generated issue report for #${args.issueNumber.toString()}\nreport.json: ${generated.outputPaths.reportJsonFile}\nreport.md: ${generated.outputPaths.reportMarkdownFile}\n`,
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
