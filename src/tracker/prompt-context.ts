import type { HandoffLifecycle, ReviewFeedback } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type {
  PromptIssueContext,
  PromptLifecycleContext,
  PromptPullRequestContext,
  PromptReviewFeedbackContext,
} from "../domain/prompt-context.js";
import type { TrackerConfig } from "../domain/workflow.js";

const DEFAULT_SUMMARY_PLACEHOLDER =
  "No tracker-authored summary was available.";
const ISSUE_SUMMARY_LIMIT = 600;
const REVIEW_FEEDBACK_SUMMARY_LIMIT = 240;

export function buildPromptIssueContext(
  issue: RuntimeIssue,
  _tracker: TrackerConfig,
): PromptIssueContext {
  return {
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    state: issue.state,
    url: issue.url,
    summary: summarizeTrackerText(issue.description, ISSUE_SUMMARY_LIMIT),
  };
}

export function buildPromptPullRequestContext(
  lifecycle: HandoffLifecycle | null,
): PromptPullRequestContext | null {
  if (lifecycle === null || lifecycle.pullRequest === null) {
    return null;
  }

  return buildPromptLifecycleContext(lifecycle);
}

export function buildPromptLifecycleContext(
  lifecycle: HandoffLifecycle | null,
): PromptLifecycleContext | null {
  if (lifecycle === null) {
    return null;
  }

  return {
    kind: lifecycle.kind,
    branchName: lifecycle.branchName,
    summary: lifecycle.summary,
    pullRequest: lifecycle.pullRequest,
    pendingCheckNames: lifecycle.pendingCheckNames,
    failingCheckNames: lifecycle.failingCheckNames,
    actionableReviewFeedback: lifecycle.actionableReviewFeedback.map(
      buildPromptReviewFeedbackContext,
    ),
  };
}

function buildPromptReviewFeedbackContext(
  feedback: ReviewFeedback,
): PromptReviewFeedbackContext {
  return {
    id: feedback.id,
    kind: feedback.kind,
    authorLogin: feedback.authorLogin,
    url: feedback.url,
    path: feedback.path,
    line: feedback.line,
    summary: summarizeTrackerText(feedback.body, REVIEW_FEEDBACK_SUMMARY_LIMIT),
  };
}

export function summarizeTrackerText(value: string, maxLength: number): string {
  const normalized = normalizeTrackerText(value);
  if (normalized.length === 0) {
    return DEFAULT_SUMMARY_PLACEHOLDER;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeTrackerText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\w-]*\n?/g, " ")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/^[>#*-]+\s+/gm, "")
    .replace(/^(\d+)\.\s+/gm, "")
    .replace(/\b(system|assistant|user|developer)\s*:/gim, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}
