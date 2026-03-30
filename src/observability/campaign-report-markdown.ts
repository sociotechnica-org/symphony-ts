import type {
  CampaignCheckPattern,
  CampaignDigest,
  CampaignLearningCluster,
  CampaignSelection,
} from "./campaign-report.js";
import {
  renderCampaignIssueLabel,
  renderCampaignNameList,
} from "./campaign-report-format.js";

export function renderCampaignSummaryMarkdown(digest: CampaignDigest): string {
  const lines: string[] = [];

  lines.push(`# Campaign Summary: ${digest.campaignId}`);
  lines.push("");
  lines.push(`- Generated at: ${digest.generatedAt}`);
  lines.push(`- Selection: ${renderSelection(digest.selection)}`);
  lines.push(`- Issue count: ${digest.summary.issueCount.toString()}`);
  lines.push(
    `- Outcome counts: succeeded ${digest.summary.outcomeCounts.succeeded.toString()}, failed ${digest.summary.outcomeCounts.failed.toString()}, partial ${digest.summary.outcomeCounts.partial.toString()}, unknown ${digest.summary.outcomeCounts.unknown.toString()}`,
  );
  lines.push(`- Attempts: ${digest.summary.attemptCount.toString()}`);
  lines.push(`- Pull requests: ${digest.summary.pullRequestCount.toString()}`);
  lines.push("");

  lines.push("## Overall Outcome");
  lines.push(digest.summary.overallOutcome);
  lines.push("");

  lines.push("## Notable Conclusions");
  if (digest.summary.notableConclusions.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const conclusion of digest.summary.notableConclusions) {
      lines.push(`- ${conclusion}`);
    }
  }
  lines.push("");

  lines.push("## Issue Breakdown");
  for (const issue of digest.summary.issues) {
    lines.push(
      `- ${renderIssueLabel(issue.issueNumber, issue.title)} | outcome ${issue.classifiedOutcome} | report ${issue.reportStatus} | attempts ${issue.attemptCount.toString()} | PRs ${issue.pullRequestCount.toString()} | started ${renderValue(issue.startedAt)} | ended ${renderValue(issue.endedAt)}`,
    );
    lines.push(`  - Conclusion: ${issue.overallConclusion}`);
    lines.push(`  - report.json: ${issue.reportJsonFile}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function renderCampaignTimelineMarkdown(digest: CampaignDigest): string {
  const lines: string[] = [];
  const partialIssues = digest.reports
    .filter((report) => report.report.summary.status !== "complete")
    .map((report) =>
      renderIssueLabel(
        report.report.summary.issueNumber,
        report.report.summary.title,
      ),
    );

  lines.push(`# Campaign Timeline: ${digest.campaignId}`);
  lines.push("");
  lines.push(`- Generated at: ${digest.generatedAt}`);
  lines.push(`- Selection: ${renderSelection(digest.selection)}`);
  lines.push(`- Timeline entries: ${digest.timeline.length.toString()}`);
  lines.push(
    `- Partial issue timelines: ${partialIssues.length === 0 ? "None" : partialIssues.join(", ")}`,
  );
  lines.push("");

  lines.push("## Events");
  if (digest.timeline.length === 0) {
    lines.push("- Unavailable: No campaign timeline entries were available.");
  } else {
    for (const entry of digest.timeline) {
      lines.push(
        `- ${renderValue(entry.at)} | ${renderIssueLabel(entry.issueNumber, entry.issueTitle)} | ${entry.title} | ${entry.summary}`,
      );
      if (entry.attemptNumber !== null) {
        lines.push(`  - Attempt: ${entry.attemptNumber.toString()}`);
      }
      if (entry.sessionId !== null) {
        lines.push(`  - Session: ${entry.sessionId}`);
      }
      for (const detail of entry.details) {
        lines.push(`  - ${detail}`);
      }
      lines.push(`  - Source report: ${entry.sourceReport}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function renderCampaignGitHubActivityMarkdown(
  digest: CampaignDigest,
): string {
  const lines: string[] = [];

  lines.push(`# Campaign GitHub Activity: ${digest.campaignId}`);
  lines.push("");
  lines.push(`- Generated at: ${digest.generatedAt}`);
  lines.push(`- Selection: ${renderSelection(digest.selection)}`);
  lines.push(`- Status: ${digest.githubActivity.status}`);
  lines.push(`- Summary: ${digest.githubActivity.summary}`);
  lines.push(
    `- Pull requests observed: ${digest.githubActivity.pullRequests.length.toString()}`,
  );
  lines.push(
    `- Review feedback rounds: ${digest.githubActivity.reviewFeedbackRounds.toString()}`,
  );
  lines.push(
    `- Actionable review count: ${renderNumber(digest.githubActivity.actionableReviewCount)}`,
  );
  lines.push(
    `- Unresolved thread count: ${renderNumber(digest.githubActivity.unresolvedThreadCount)}`,
  );
  lines.push(
    `- Pending checks: ${renderPatternList(digest.githubActivity.pendingChecks)}`,
  );
  lines.push(
    `- Failing checks: ${renderPatternList(digest.githubActivity.failingChecks)}`,
  );
  lines.push(`- Merge timing: ${digest.githubActivity.mergeAvailabilityNote}`);
  lines.push(`- Close timing: ${digest.githubActivity.closeAvailabilityNote}`);
  for (const note of digest.githubActivity.notes) {
    lines.push(`- Note: ${note}`);
  }
  lines.push("");

  lines.push("## Pull Requests");
  if (digest.githubActivity.pullRequests.length === 0) {
    lines.push("- None observed.");
  } else {
    for (const pullRequest of digest.githubActivity.pullRequests) {
      lines.push(
        `- ${renderIssueLabel(pullRequest.issueNumber, pullRequest.issueTitle)} | PR #${pullRequest.number.toString()} | ${pullRequest.url}`,
      );
      lines.push(
        `  - Attempts: ${pullRequest.attemptNumbers.length === 0 ? "Unavailable" : pullRequest.attemptNumbers.join(", ")}`,
      );
      lines.push(
        `  - First observed: ${renderValue(pullRequest.firstObservedAt)}`,
      );
      lines.push(
        `  - Latest commit: ${renderValue(pullRequest.latestCommitAt)}`,
      );
      lines.push(
        `  - Review rounds: ${pullRequest.reviewFeedbackRounds.toString()}`,
      );
      lines.push(
        `  - Actionable reviews: ${renderNumber(pullRequest.actionableReviewCount)}`,
      );
      lines.push(
        `  - Unresolved threads: ${renderNumber(pullRequest.unresolvedThreadCount)}`,
      );
      lines.push(
        `  - Pending checks: ${renderNameList(pullRequest.pendingChecks)}`,
      );
      lines.push(
        `  - Failing checks: ${renderNameList(pullRequest.failingChecks)}`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function renderCampaignTokenUsageMarkdown(
  digest: CampaignDigest,
): string {
  const lines: string[] = [];

  lines.push(`# Campaign Token Usage: ${digest.campaignId}`);
  lines.push("");
  lines.push(`- Generated at: ${digest.generatedAt}`);
  lines.push(`- Selection: ${renderSelection(digest.selection)}`);
  lines.push(`- Aggregate status: ${digest.tokenUsage.status}`);
  lines.push(`- Explanation: ${digest.tokenUsage.explanation}`);
  lines.push(`- Total tokens: ${renderNumber(digest.tokenUsage.totalTokens)}`);
  lines.push(
    `- Estimated cost (USD): ${renderCurrency(digest.tokenUsage.costUsd)}`,
  );
  lines.push(
    `- Status counts: complete ${digest.tokenUsage.issueCounts.complete.toString()}, estimated ${digest.tokenUsage.issueCounts.estimated.toString()}, partial ${digest.tokenUsage.issueCounts.partial.toString()}, unavailable ${digest.tokenUsage.issueCounts.unavailable.toString()}`,
  );
  lines.push(
    `- Observed token subtotal: ${renderNumber(digest.tokenUsage.observedTokenSubtotal)}`,
  );
  lines.push(
    `- Observed cost subtotal (USD): ${renderCurrency(digest.tokenUsage.observedCostSubtotal)}`,
  );
  for (const note of digest.tokenUsage.notes) {
    lines.push(`- Note: ${note}`);
  }
  lines.push("");

  lines.push("## Issue Coverage");
  for (const issue of digest.tokenUsage.issues) {
    lines.push(
      `- ${renderIssueLabel(issue.issueNumber, issue.title)} | status ${issue.status} | sessions ${issue.sessionCount.toString()} | total tokens ${renderNumber(issue.totalTokens)} | cost ${renderCurrency(issue.costUsd)}`,
    );
    lines.push(
      `  - Observed subtotal: tokens ${renderNumber(issue.observedTokenSubtotal)}, cost ${renderCurrency(issue.observedCostSubtotal)}`,
    );
    for (const note of issue.notes) {
      lines.push(`  - Note: ${note}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function renderCampaignLearningsMarkdown(
  digest: CampaignDigest,
): string {
  const lines: string[] = [];

  lines.push(`# Campaign Learnings: ${digest.campaignId}`);
  lines.push("");
  lines.push(`- Generated at: ${digest.generatedAt}`);
  lines.push(`- Selection: ${renderSelection(digest.selection)}`);
  lines.push("");

  lines.push("## Cross-Issue Conclusions");
  renderLearningClusters(lines, digest.learnings.crossIssueConclusions);
  lines.push("");

  lines.push("## Recurring Failure Modes");
  renderLearningClusters(lines, digest.learnings.recurringFailureModes);
  lines.push("");

  lines.push("## Changes To Make");
  if (digest.learnings.changesToMake.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const change of digest.learnings.changesToMake) {
      lines.push(`- ${change}`);
    }
  }
  lines.push("");

  lines.push("## Gaps");
  if (digest.learnings.gaps.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const gap of digest.learnings.gaps) {
      lines.push(`- ${gap}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function renderLearningClusters(
  lines: string[],
  clusters: readonly CampaignLearningCluster[],
): void {
  if (clusters.length === 0) {
    lines.push("- None recorded.");
    return;
  }

  for (const cluster of clusters) {
    lines.push(`- ${cluster.title}: ${cluster.summary}`);
    lines.push(
      `  - Issues: ${cluster.issueNumbers.length === 0 ? "Unavailable" : cluster.issueNumbers.map((issueNumber) => `#${issueNumber.toString()}`).join(", ")}`,
    );
    for (const evidence of cluster.evidence) {
      lines.push(`  - ${evidence}`);
    }
  }
}

function renderSelection(selection: CampaignSelection): string {
  if (selection.kind === "issues") {
    return selection.issueNumbers
      .map((issueNumber) => `#${issueNumber.toString()}`)
      .join(", ");
  }
  return `${selection.from} to ${selection.to}`;
}

function renderIssueLabel(issueNumber: number, title: string | null): string {
  return renderCampaignIssueLabel(issueNumber, title);
}

function renderPatternList(patterns: readonly CampaignCheckPattern[]): string {
  if (patterns.length === 0) {
    return "None";
  }
  return patterns
    .map((pattern) => `${pattern.name} (${pattern.count.toString()})`)
    .join(", ");
}

function renderNameList(values: readonly string[]): string {
  return renderCampaignNameList(values);
}

function renderValue(value: string | null): string {
  return value === null ? "Unavailable" : value;
}

function renderNumber(value: number | null): string {
  return value === null ? "Unavailable" : value.toString();
}

function renderCurrency(value: number | null): string {
  return value === null ? "Unavailable" : value.toFixed(2);
}
