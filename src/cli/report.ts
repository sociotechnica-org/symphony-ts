import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkflow, loadWorkflowInstancePaths } from "../config/workflow.js";
import type { RuntimeInstanceInput } from "../domain/workflow.js";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../domain/instance-identity.js";
import { publishIssueToFactoryRuns } from "../integration/factory-runs.js";
import { createGitHubFollowUpIssue } from "../integration/github-follow-up-issues.js";
import { createDefaultIssueReportEnrichers } from "../runner/codex-report-enricher.js";
import {
  writeCampaignDigest,
  type CampaignSelection,
} from "../observability/campaign-report.js";
import { writeIssueReport } from "../observability/issue-report.js";
import type { IssueReportEnricher } from "../observability/issue-report-enrichment.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  appendIssueArtifactEvent,
  type IssueArtifactEvent,
} from "../observability/issue-artifacts.js";
import {
  blockOperatorReportFollowUpIssue,
  deriveOperatorReportReviewStateFile,
  recordOperatorReportFollowUpIssue,
  recordOperatorReportReviewDecision,
  syncOperatorReportReviews,
  type OperatorReportReviewBlockedStage,
} from "../observability/operator-report-review.js";

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
    }
  | {
      readonly command: "review-pending";
      readonly workflowPath: string;
      readonly operatorRepoRoot: string;
      readonly output: "text" | "json";
    }
  | {
      readonly command: "review-record";
      readonly workflowPath: string;
      readonly operatorRepoRoot: string;
      readonly issueNumber: number;
      readonly status: "reviewed-no-follow-up" | "review-blocked";
      readonly summary: string;
      readonly note: string | null;
      readonly blockedStage: OperatorReportReviewBlockedStage | null;
    }
  | {
      readonly command: "review-follow-up";
      readonly workflowPath: string;
      readonly operatorRepoRoot: string;
      readonly issueNumber: number;
      readonly title: string;
      readonly body: string;
      readonly summary: string;
      readonly note: string | null;
      readonly findingKey: string;
    };

const REPORT_USAGE =
  "Usage: symphony-report <issue|publish|campaign|review-pending|review-record|review-follow-up> [--issue <number>] [--issues <a,b,c> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--workflow <path>] [--archive-root <path>] [--operator-repo-root <path>] [--json]";

export async function parseReportArgs(
  argv: readonly string[],
): Promise<ReportCliArgs> {
  const args = argv.slice(2);
  const command = args[0];

  if (
    command !== "issue" &&
    command !== "publish" &&
    command !== "campaign" &&
    command !== "review-pending" &&
    command !== "review-record" &&
    command !== "review-follow-up"
  ) {
    throw new Error(REPORT_USAGE);
  }

  const workflowPath = path.resolve(
    process.cwd(),
    readOptionValue(args, "--workflow") ?? "WORKFLOW.md",
  );
  const operatorRepoRoot = path.resolve(
    process.cwd(),
    readOptionValue(args, "--operator-repo-root") ?? process.cwd(),
  );

  if (command === "review-pending") {
    return {
      command,
      workflowPath,
      operatorRepoRoot,
      output: hasFlag(args, "--json") ? "json" : "text",
    };
  }

  if (command === "review-record") {
    const status = readRequiredOptionValue(args, "--status");
    if (status !== "reviewed-no-follow-up" && status !== "review-blocked") {
      throw new Error(
        "review-record requires --status reviewed-no-follow-up|review-blocked",
      );
    }
    const blockedStage = readOptionValue(args, "--blocked-stage");
    if (
      blockedStage !== null &&
      blockedStage !== "report-generation" &&
      blockedStage !== "issue-filing" &&
      blockedStage !== "review-recording" &&
      blockedStage !== "publication" &&
      blockedStage !== "operator-review"
    ) {
      throw new Error(
        "review-record --blocked-stage must be report-generation, issue-filing, review-recording, publication, or operator-review",
      );
    }
    return {
      command,
      workflowPath,
      operatorRepoRoot,
      issueNumber: parseIssueNumber(args),
      status,
      summary: readRequiredOptionValue(args, "--summary"),
      note: readOptionValue(args, "--note"),
      blockedStage,
    };
  }

  if (command === "review-follow-up") {
    return {
      command,
      workflowPath,
      operatorRepoRoot,
      issueNumber: parseIssueNumber(args),
      title: readRequiredOptionValue(args, "--title"),
      body: await readBodyOptionValue(args),
      summary: readRequiredOptionValue(args, "--summary"),
      note: readOptionValue(args, "--note"),
      findingKey:
        readOptionValue(args, "--finding-key") ??
        readRequiredOptionValue(args, "--title"),
    };
  }

  if (command === "campaign") {
    return {
      command,
      workflowPath,
      selection: parseCampaignSelection(args),
    };
  }

  const issueNumber = parseIssueNumber(args);
  if (command === "issue") {
    return {
      command,
      workflowPath,
      issueNumber,
    };
  }

  return {
    command,
    workflowPath,
    issueNumber,
    archiveRoot: path.resolve(
      process.cwd(),
      readRequiredOptionValue(args, "--archive-root"),
    ),
  };
}

export async function runReportCli(
  argv: readonly string[],
  options?: {
    readonly issueEnrichers?: readonly IssueReportEnricher[] | undefined;
  },
): Promise<void> {
  const args = await parseReportArgs(argv);
  const instance = await loadWorkflowInstancePaths(args.workflowPath);

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

  if (args.command === "publish") {
    const published = await publishIssueToFactoryRuns({
      instance,
      sourceRoot: instance.workflowRoot,
      archiveRoot: args.archiveRoot,
      issueNumber: args.issueNumber,
    });
    process.stdout.write(
      `Published issue #${args.issueNumber.toString()} to factory-runs\npublication id: ${published.publicationId}\nstatus: ${published.status}\narchive root: ${args.archiveRoot}\npublication dir: ${published.paths.publicationRoot}\nmetadata.json: ${published.paths.metadataFile}\nlogs copied: ${published.metadata.logs.copiedCount.toString()}\nlogs referenced: ${published.metadata.logs.referencedCount.toString()}\nlogs unavailable: ${published.metadata.logs.unavailableCount.toString()}\n`,
    );
    await appendIssueArtifactEventWithWarning(
      instance,
      args.issueNumber,
      createOperatorCliEvent(args.issueNumber, "report-published", {
        observedAt: published.metadata.publishedAt,
        summary: `Published report artifacts for issue #${args.issueNumber.toString()} to factory-runs.`,
        command: "publish",
        publicationId: published.publicationId,
        publicationStatus: published.status,
        archiveRoot: args.archiveRoot,
        publicationRoot: published.paths.publicationRoot,
      }),
    );
    return;
  }

  const reviewStateFile = deriveReviewStateFile(
    args.workflowPath,
    args.operatorRepoRoot,
  );

  if (args.command === "review-pending") {
    const synced = await syncOperatorReportReviews({
      instance,
      reviewStateFile,
    });
    if (args.output === "json") {
      process.stdout.write(
        `${JSON.stringify({
          reviewStateFile,
          pending: synced.pending,
        })}\n`,
      );
      return;
    }

    if (synced.pending.length === 0) {
      process.stdout.write(
        `No completed issue reports are awaiting operator review.\nreview state: ${reviewStateFile}\n`,
      );
      return;
    }

    const lines = [
      `Completed issue reports awaiting operator review: ${synced.pending.length.toString()}`,
      `review state: ${reviewStateFile}`,
      ...synced.pending.map(
        (entry) =>
          `- #${entry.issueNumber.toString()} [${entry.status}] ${entry.issueTitle} | report: ${entry.reportJsonFile}${
            entry.note ? ` | note: ${entry.note}` : ""
          }`,
      ),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (args.command === "review-record") {
    const recorded = await recordOperatorReportReviewDecision({
      instance,
      reviewStateFile,
      issueNumber: args.issueNumber,
      status: args.status,
      summary: args.summary,
      note: args.note,
      blockedStage: args.blockedStage,
    });
    process.stdout.write(
      `Recorded ${recorded.status} for issue #${recorded.issueNumber.toString()}\nreview state: ${reviewStateFile}\nreport: ${recorded.reportJsonFile}\n`,
    );
    await appendIssueArtifactEventWithWarning(
      instance,
      args.issueNumber,
      createOperatorCliEvent(args.issueNumber, "report-review-recorded", {
        observedAt: recorded.recordedAt,
        summary: recorded.summary,
        command: "review-record",
        reviewStatus: recorded.status,
        blockedStage: recorded.blockedStage,
        note: recorded.note,
      }),
    );
    return;
  }

  const workflow = await loadWorkflow(args.workflowPath);
  if (
    workflow.config.tracker.kind !== "github" &&
    workflow.config.tracker.kind !== "github-bootstrap"
  ) {
    throw new Error(
      "review-follow-up requires a GitHub-compatible tracker repo in WORKFLOW.md",
    );
  }

  let createdIssue: Awaited<ReturnType<typeof createGitHubFollowUpIssue>>;
  try {
    createdIssue = await createGitHubFollowUpIssue({
      repo: workflow.config.tracker.repo,
      title: args.title,
      body: args.body,
    });
  } catch (error) {
    await blockOperatorReportFollowUpIssue({
      instance,
      reviewStateFile,
      issueNumber: args.issueNumber,
      findingKey: args.findingKey,
      draft: {
        title: args.title,
        body: args.body,
      },
      summary: args.summary,
      note: error instanceof Error ? error.message : String(error),
      blockedStage: "issue-filing",
    });
    throw error;
  }

  let recorded: Awaited<ReturnType<typeof recordOperatorReportFollowUpIssue>>;
  try {
    recorded = await recordOperatorReportFollowUpIssue({
      instance,
      reviewStateFile,
      issueNumber: args.issueNumber,
      findingKey: args.findingKey,
      createdIssue,
      summary: args.summary,
      note: args.note,
    });
    process.stdout.write(
      `Created follow-up issue #${createdIssue.number.toString()} for report review on #${args.issueNumber.toString()}\nissue: ${createdIssue.url}\nreview state: ${reviewStateFile}\nrecord status: ${recorded.status}\n`,
    );
  } catch (error) {
    await blockOperatorReportFollowUpIssue({
      instance,
      reviewStateFile,
      issueNumber: args.issueNumber,
      findingKey: args.findingKey,
      draft: {
        title: args.title,
        body: args.body,
      },
      summary: args.summary,
      note: error instanceof Error ? error.message : String(error),
      blockedStage: "review-recording",
      createdIssue,
    });
    throw error;
  }

  const createdFollowUpIssue =
    recorded.followUpIssues.find(
      (issue) =>
        issue.number === createdIssue.number && issue.url === createdIssue.url,
    ) ?? null;
  await appendIssueArtifactEventWithWarning(
    instance,
    args.issueNumber,
    createOperatorCliEvent(args.issueNumber, "report-follow-up-filed", {
      observedAt: recorded.recordedAt,
      summary: args.summary,
      command: "review-follow-up",
      findingKey: args.findingKey,
      followUpIssueNumber: createdIssue.number,
      followUpIssueUrl: createdIssue.url,
      followUpIssueTitle: createdIssue.title,
      followUpIssueCreatedAt: createdFollowUpIssue?.createdAt ?? null,
      note: args.note,
    }),
  );
}

function createOperatorCliEvent(
  issueNumber: number,
  kind:
    | "report-published"
    | "report-review-recorded"
    | "report-follow-up-filed",
  details: Readonly<Record<string, unknown>> & {
    readonly observedAt: string;
    readonly summary: string;
    readonly command: "publish" | "review-record" | "review-follow-up";
  },
): IssueArtifactEvent {
  const { observedAt, ...eventDetails } = details;
  return {
    version: ISSUE_ARTIFACT_SCHEMA_VERSION,
    kind,
    issueNumber,
    observedAt,
    attemptNumber: null,
    sessionId: null,
    details: {
      source: "operator-cli",
      ...eventDetails,
    },
  };
}

async function appendIssueArtifactEventWithWarning(
  instance: RuntimeInstanceInput,
  issueNumber: number,
  event: IssueArtifactEvent,
): Promise<void> {
  try {
    await appendIssueArtifactEvent(instance, issueNumber, event);
  } catch (error) {
    process.stderr.write(
      `Warning: primary report action for issue #${issueNumber.toString()} succeeded, but canonical issue artifact persistence failed: ${formatErrorMessage(error)}\n`,
    );
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function readRequiredOptionValue(
  args: readonly string[],
  flag: string,
): string {
  const value = readOptionValue(args, flag);
  if (value === null) {
    throw new Error(`Missing required ${flag} option`);
  }
  return value;
}

function parseIssueNumber(args: readonly string[]): number {
  const issueValue = readOptionValue(args, "--issue");
  if (issueValue === null) {
    throw new Error("Missing required --issue <number> option");
  }
  if (!/^[1-9]\d*$/u.test(issueValue)) {
    throw new Error(`Invalid issue number: ${issueValue}`);
  }
  return Number.parseInt(issueValue, 10);
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

async function readBodyOptionValue(args: readonly string[]): Promise<string> {
  const body = readOptionValue(args, "--body");
  const bodyFile = readOptionValue(args, "--body-file");
  if (body !== null && bodyFile !== null) {
    throw new Error("Use either --body or --body-file, not both");
  }
  if (body !== null) {
    return body;
  }
  if (bodyFile !== null) {
    return await fs.readFile(path.resolve(process.cwd(), bodyFile), "utf8");
  }
  throw new Error("Missing required --body or --body-file option");
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

function deriveReviewStateFile(
  workflowPath: string,
  operatorRepoRoot: string,
): string {
  const identity = deriveSymphonyInstanceIdentity(workflowPath);
  return deriveOperatorReportReviewStateFile(
    deriveOperatorInstanceStatePaths({
      operatorRepoRoot,
      instanceKey: identity.instanceKey,
    }),
  );
}
