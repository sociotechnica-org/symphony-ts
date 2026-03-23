import path from "node:path";
import { loadWorkflow } from "../config/workflow.js";
import { publishIssueToFactoryRuns } from "../integration/factory-runs.js";
import { createDefaultIssueReportEnrichers } from "../runner/codex-report-enricher.js";
import {
  writeCampaignDigest,
  type CampaignSelection,
} from "../observability/campaign-report.js";
import { writeIssueReport } from "../observability/issue-report.js";
import type { IssueReportEnricher } from "../observability/issue-report-enrichment.js";

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
    }
  | {
      readonly command: "campaign";
      readonly workflowPath: string;
      readonly selection: CampaignSelection;
    };

export function parseReportArgs(argv: readonly string[]): ReportCliArgs {
  const args = argv.slice(2);
  const command = args[0];

  if (command !== "issue" && command !== "publish" && command !== "campaign") {
    throw new Error(
      "Usage: symphony-report <issue|publish|campaign> [--issue <number>] [--issues <a,b,c> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--workflow <path>] [--archive-root <path>]",
    );
  }

  const workflowPath = readOptionValue(args, "--workflow") ?? "WORKFLOW.md";
  if (command === "campaign") {
    return {
      command: "campaign",
      workflowPath: path.resolve(process.cwd(), workflowPath),
      selection: parseCampaignSelection(args),
    };
  }

  const issueValue = readOptionValue(args, "--issue");
  if (issueValue === null) {
    throw new Error("Missing required --issue <number> option");
  }
  if (!/^[1-9]\d*$/u.test(issueValue)) {
    throw new Error(`Invalid issue number: ${issueValue}`);
  }
  const issueNumber = Number.parseInt(issueValue, 10);

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

export async function runReportCli(
  argv: readonly string[],
  options?: {
    readonly issueEnrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<void> {
  const args = parseReportArgs(argv);
  const workflow = await loadWorkflow(args.workflowPath);
  const { instance } = workflow.config;
  if (args.command === "issue") {
    const generated = await writeIssueReport(instance, args.issueNumber, {
      enrichers: options?.issueEnrichers ?? createDefaultIssueReportEnrichers(),
    });
    process.stdout.write(
      `Generated issue report for #${args.issueNumber.toString()}\nreport.json: ${generated.outputPaths.reportJsonFile}\nreport.md: ${generated.outputPaths.reportMarkdownFile}\n`,
    );
    return;
  }
  if (args.command === "campaign") {
    const generated = await writeCampaignDigest(instance, args.selection);
    process.stdout.write(
      `Generated campaign digest ${generated.digest.campaignId}\nsummary.md: ${generated.outputPaths.summaryFile}\ntimeline.md: ${generated.outputPaths.timelineFile}\ngithub-activity.md: ${generated.outputPaths.githubActivityFile}\ntoken-usage.md: ${generated.outputPaths.tokenUsageFile}\nlearnings.md: ${generated.outputPaths.learningsFile}\n`,
    );
    return;
  }

  const published = await publishIssueToFactoryRuns({
    instance,
    sourceRoot: instance.workflowRoot,
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

function parseCampaignSelection(args: readonly string[]): CampaignSelection {
  const issuesValue = readOptionValue(args, "--issues");
  const from = readOptionValue(args, "--from");
  const to = readOptionValue(args, "--to");

  if (issuesValue !== null && (from !== null || to !== null)) {
    throw new Error(
      "Campaign selection must use either --issues or --from/--to, not both",
    );
  }

  if (issuesValue !== null) {
    const issueNumbers = issuesValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (issueNumbers.length === 0) {
      throw new Error("Missing required --issues <a,b,c> option");
    }
    for (const issueValue of issueNumbers) {
      if (!/^[1-9]\d*$/u.test(issueValue)) {
        throw new Error(`Invalid issue number in --issues: ${issueValue}`);
      }
    }
    return {
      kind: "issues",
      issueNumbers: issueNumbers
        .map((issueValue) => Number.parseInt(issueValue, 10))
        .sort((left, right) => left - right),
    };
  }

  if (from === null && to === null) {
    throw new Error(
      "Campaign generation requires either --issues <a,b,c> or --from <YYYY-MM-DD> --to <YYYY-MM-DD>",
    );
  }
  if (from === null || to === null) {
    throw new Error(
      "Campaign date-window selection requires both --from and --to",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from)) {
    throw new Error(`Invalid campaign from date: ${from}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(to)) {
    throw new Error(`Invalid campaign to date: ${to}`);
  }
  if (from > to) {
    throw new Error(
      `Campaign date window must satisfy --from <= --to; received ${from} > ${to}`,
    );
  }

  return {
    kind: "date-window",
    from,
    to,
  };
}
