import type {
  IssueReportDocument,
  IssueReportPullRequestActivity,
  IssueReportTimelineEntry,
} from "./issue-report.js";

export function renderIssueReportMarkdown(report: IssueReportDocument): string {
  const lines: string[] = [];

  lines.push(`# Issue Report: #${report.summary.issueNumber.toString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(
    `- Issue: ${renderValue(report.summary.issueIdentifier, `#${report.summary.issueNumber.toString()}`)}`,
  );
  lines.push(`- Title: ${renderValue(report.summary.title)}`);
  lines.push(`- Repo: ${renderValue(report.summary.repo)}`);
  lines.push(`- URL: ${renderValue(report.summary.issueUrl)}`);
  lines.push(`- Branch: ${renderValue(report.summary.branch)}`);
  lines.push(`- Outcome: ${renderValue(report.summary.outcome)}`);
  lines.push(`- Started: ${renderValue(report.summary.startedAt)}`);
  lines.push(`- Ended: ${renderValue(report.summary.endedAt)}`);
  lines.push(`- Attempts: ${report.summary.attemptCount.toString()}`);
  lines.push(`- Pull requests: ${report.summary.pullRequestCount.toString()}`);
  lines.push(`- Conclusion: ${report.summary.overallConclusion}`);
  if (report.summary.notes.length > 0) {
    lines.push("- Notes:");
    for (const note of report.summary.notes) {
      lines.push(`  - ${note}`);
    }
  }
  lines.push("");

  lines.push("## Timeline");
  if (report.timeline.length === 0) {
    lines.push("- Unavailable: No major lifecycle events were available.");
  } else {
    for (const entry of report.timeline) {
      lines.push(renderTimelineEntry(entry));
      for (const detail of entry.details) {
        lines.push(`  - ${detail}`);
      }
    }
  }
  lines.push("");

  lines.push("## GitHub Activity");
  lines.push(
    `- Issue state transitions: ${report.githubActivity.issueStateTransitionsStatus}`,
  );
  lines.push(
    `- Issue transition note: ${report.githubActivity.issueStateTransitionsNote}`,
  );
  lines.push(
    `- Pull request count: ${report.githubActivity.pullRequests.length.toString()}`,
  );
  if (report.githubActivity.pullRequests.length === 0) {
    lines.push("- Pull requests: Unavailable");
  } else {
    for (const pullRequest of report.githubActivity.pullRequests) {
      lines.push(renderPullRequestActivity(pullRequest));
    }
  }
  lines.push(
    `- Review rounds: ${report.githubActivity.reviewFeedbackRounds.toString()}`,
  );
  lines.push(
    `- Review-loop summary: ${report.githubActivity.reviewLoopSummary}`,
  );
  lines.push(`- Merged at: ${renderValue(report.githubActivity.mergedAt)}`);
  lines.push(`- Merge note: ${report.githubActivity.mergeNote}`);
  lines.push(`- Closed at: ${renderValue(report.githubActivity.closedAt)}`);
  lines.push(`- Close note: ${report.githubActivity.closeNote}`);
  for (const note of report.githubActivity.notes) {
    lines.push(`- Note: ${note}`);
  }
  lines.push("");

  lines.push("## Token Usage");
  lines.push(`- Status: ${report.tokenUsage.status}`);
  lines.push(`- Explanation: ${report.tokenUsage.explanation}`);
  lines.push(`- Total tokens: ${renderNumber(report.tokenUsage.totalTokens)}`);
  lines.push(
    `- Estimated cost (USD): ${renderCurrency(report.tokenUsage.costUsd)}`,
  );
  for (const note of report.tokenUsage.notes) {
    lines.push(`- Note: ${note}`);
  }
  if (report.tokenUsage.sessions.length === 0) {
    lines.push("- Sessions: Unavailable");
  } else {
    for (const session of report.tokenUsage.sessions) {
      lines.push(
        `- Session ${session.sessionId}: attempt ${session.attemptNumber.toString()}, agent ${session.provider}${session.model === null ? "" : ` (${session.model})`}, status ${session.status}, tokens ${renderNumber(session.totalTokens)}, cost ${renderCurrency(session.costUsd)}`,
      );
      if (session.inputTokens !== null || session.outputTokens !== null) {
        lines.push(
          `  - Token detail: input ${renderNumber(session.inputTokens)}, cached input ${renderNumber(session.cachedInputTokens)}, output ${renderNumber(session.outputTokens)}, reasoning output ${renderNumber(session.reasoningOutputTokens)}`,
        );
      }
      if (
        session.originator !== null ||
        session.sessionSource !== null ||
        session.cliVersion !== null
      ) {
        lines.push(
          `  - Session detail: originator ${renderValue(session.originator)}, source ${renderValue(session.sessionSource)}, CLI ${renderValue(session.cliVersion)}`,
        );
      }
      if (session.modelProvider !== null) {
        lines.push(`  - Model provider: ${session.modelProvider}`);
      }
      if (session.gitBranch !== null || session.gitCommit !== null) {
        lines.push(
          `  - Git: branch ${renderValue(session.gitBranch)}, commit ${renderValue(session.gitCommit)}`,
        );
      }
      if (session.finalSummary !== null) {
        lines.push("  - Final summary:");
        for (const line of renderMultilineSummary(session.finalSummary)) {
          lines.push(`    - ${line}`);
        }
      }
      if (session.sourceArtifacts.length > 0) {
        lines.push(
          `  - Source artifacts: ${session.sourceArtifacts.join(", ")}`,
        );
      }
      for (const note of session.notes) {
        lines.push(`  - Note: ${note}`);
      }
    }
  }
  lines.push("");

  lines.push("## Learnings");
  if (report.learnings.observations.length === 0) {
    lines.push("- Unavailable: No evidence-backed learnings could be derived.");
  } else {
    for (const observation of report.learnings.observations) {
      lines.push(`- ${observation.title}: ${observation.summary}`);
      for (const evidence of observation.evidence) {
        lines.push(`  - ${evidence}`);
      }
    }
  }
  if (report.learnings.gaps.length === 0) {
    lines.push("- Gaps: None recorded.");
  } else {
    for (const gap of report.learnings.gaps) {
      lines.push(`- Gap: ${gap}`);
    }
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push(`- Raw issue root: ${report.artifacts.rawIssueRoot}`);
  lines.push(`- issue.json: ${renderValue(report.artifacts.issueFile)}`);
  lines.push(`- events.jsonl: ${renderValue(report.artifacts.eventsFile)}`);
  lines.push(
    `- attempts/: ${report.artifacts.attemptFiles.length === 0 ? "Unavailable" : report.artifacts.attemptFiles.join(", ")}`,
  );
  lines.push(
    `- sessions/: ${report.artifacts.sessionFiles.length === 0 ? "Unavailable" : report.artifacts.sessionFiles.join(", ")}`,
  );
  lines.push(
    `- log pointers: ${renderValue(report.artifacts.logPointersFile)}`,
  );
  lines.push(`- report.json: ${report.artifacts.generatedReportJson}`);
  lines.push(`- report.md: ${report.artifacts.generatedReportMarkdown}`);
  if (report.artifacts.missingArtifacts.length > 0) {
    lines.push(
      `- Missing artifacts: ${report.artifacts.missingArtifacts.join(", ")}`,
    );
  }
  lines.push("");

  lines.push("## Operator Interventions");
  lines.push(`- Status: ${report.operatorInterventions.status}`);
  lines.push(`- Summary: ${report.operatorInterventions.summary}`);
  lines.push(`- Note: ${report.operatorInterventions.note}`);
  if (report.operatorInterventions.entries.length === 0) {
    lines.push("- Entries: None recorded");
  } else {
    for (const entry of report.operatorInterventions.entries) {
      lines.push(
        `- ${entry.summary}: ${renderValue(entry.at)} (${entry.kind})`,
      );
      for (const detail of entry.details) {
        lines.push(`  - ${detail}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}

function renderTimelineEntry(entry: IssueReportTimelineEntry): string {
  return `- ${renderValue(entry.at)} | ${entry.title} | ${entry.summary}`;
}

function renderPullRequestActivity(
  pullRequest: IssueReportPullRequestActivity,
): string {
  return `- PR #${pullRequest.number.toString()}: ${pullRequest.url}; attempts ${renderNumberList(pullRequest.attemptNumbers)}; first observed ${renderValue(pullRequest.firstObservedAt)}; latest commit ${renderValue(pullRequest.latestCommitAt)}; review rounds ${pullRequest.reviewFeedbackRounds.toString()}; actionable ${renderNumber(pullRequest.actionableReviewCount)}; unresolved threads ${renderNumber(pullRequest.unresolvedThreadCount)}; reviewer verdict ${renderReviewerVerdict(pullRequest)}; required reviewer ${renderValue(pullRequest.requiredReviewerState)}; pending checks ${renderList(pullRequest.pendingChecks)}; failing checks ${renderList(pullRequest.failingChecks)}`;
}

function renderValue(value: string | null, fallback = "Unavailable"): string {
  return value === null ? fallback : value;
}

function renderNumber(value: number | null): string {
  return value === null ? "Unavailable" : value.toString();
}

function renderCurrency(value: number | null): string {
  return value === null ? "Unavailable" : value.toFixed(2);
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "None" : values.join(", ");
}

function renderNumberList(values: readonly number[]): string {
  return values.length === 0
    ? "Unavailable"
    : values.map((value) => value.toString()).join(", ");
}

function renderReviewerVerdict(
  pullRequest: IssueReportPullRequestActivity,
): string {
  if (pullRequest.reviewerVerdict === null) {
    return "Unavailable";
  }
  if (pullRequest.reviewerVerdict === "blocking-issues-found") {
    return pullRequest.blockingReviewerKeys.length === 0
      ? "blocking-issues-found"
      : `blocking-issues-found (${pullRequest.blockingReviewerKeys.join(", ")})`;
  }
  return pullRequest.reviewerVerdict;
}

function renderMultilineSummary(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return [];
      }
      return [line.replace(/^[-*]\s+/u, "")];
    });
}
