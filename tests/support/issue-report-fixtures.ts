import fs from "node:fs/promises";
import path from "node:path";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  LocalIssueArtifactStore,
  deriveIssueArtifactPaths,
} from "../../src/observability/issue-artifacts.js";

export async function writeReportWorkflow(rootDir: string): Promise<string> {
  const workflowPath = path.join(rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: https://example.test
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
  review_bot_logins: []
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 2
    backoff_ms: 0
workspace:
  root: ./.tmp/workspaces
  repo_url: /tmp/repo.git
  branch_prefix: symphony/
  cleanup_on_success: false
hooks:
  after_create: []
agent:
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}
---
Prompt body
`,
    "utf8",
  );
  return workflowPath;
}

export function deriveWorkspaceRoot(rootDir: string): string {
  return path.join(rootDir, ".tmp", "workspaces");
}

export async function seedSuccessfulIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
): Promise<void> {
  const store = new LocalIssueArtifactStore(workspaceRoot);
  const issueIdentifier = `sociotechnica-org/symphony-ts#${issueNumber.toString()}`;
  const issueUrl = `https://github.com/sociotechnica-org/symphony-ts/issues/${issueNumber.toString()}`;
  const branch = `symphony/${issueNumber.toString()}`;
  const sessionId = `${issueIdentifier}/attempt-1/session-1`;

  await store.recordObservation({
    issue: {
      issueNumber,
      issueIdentifier,
      repo: "sociotechnica-org/symphony-ts",
      title: "Generate per-issue reports from local artifacts",
      issueUrl,
      branch,
      currentOutcome: "claimed",
      currentSummary: `Claimed ${issueIdentifier}`,
      observedAt: "2026-03-09T10:00:00.000Z",
      latestAttemptNumber: 1,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "claimed",
        issueNumber,
        observedAt: "2026-03-09T10:00:00.000Z",
        attemptNumber: 1,
        sessionId: null,
        details: {
          branch,
        },
      },
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "plan-ready",
        issueNumber,
        observedAt: "2026-03-09T10:02:00.000Z",
        attemptNumber: 1,
        sessionId: null,
        details: {
          branch,
          summary: "Waiting for plan review",
        },
      },
    ],
  });

  await store.recordObservation({
    issue: {
      issueNumber,
      issueIdentifier,
      repo: "sociotechnica-org/symphony-ts",
      title: "Generate per-issue reports from local artifacts",
      issueUrl,
      branch,
      currentOutcome: "awaiting-review",
      currentSummary: "PR opened and awaiting checks",
      observedAt: "2026-03-09T10:10:00.000Z",
      latestAttemptNumber: 1,
      latestSessionId: sessionId,
    },
    attempt: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 1,
      branch,
      startedAt: "2026-03-09T10:05:00.000Z",
      finishedAt: "2026-03-09T10:10:00.000Z",
      outcome: "awaiting-review",
      summary: "PR opened and awaiting checks",
      sessionId,
      runnerPid: 4242,
      pullRequest: {
        number: 144,
        url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
        latestCommitAt: "2026-03-09T10:09:30.000Z",
      },
      review: {
        actionableCount: 0,
        unresolvedThreadCount: 0,
      },
      checks: {
        pendingNames: ["CI"],
        failingNames: [],
      },
    },
    session: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 1,
      sessionId,
      provider: "codex",
      model: "gpt-5.4",
      startedAt: "2026-03-09T10:05:00.000Z",
      finishedAt: "2026-03-09T10:10:00.000Z",
      workspacePath: path.join(
        workspaceRoot,
        `issue-${issueNumber.toString()}`,
      ),
      branch,
      logPointers: [
        {
          name: "runner.log",
          location: path.join(workspaceRoot, "logs", "runner.log"),
          archiveLocation: null,
        },
      ],
    },
    logPointers: {
      sessionId,
      pointers: [
        {
          name: "runner.log",
          location: path.join(workspaceRoot, "logs", "runner.log"),
          archiveLocation: null,
        },
      ],
      archiveLocation: null,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "runner-spawned",
        issueNumber,
        observedAt: "2026-03-09T10:05:00.000Z",
        attemptNumber: 1,
        sessionId,
        details: {
          pid: 4242,
        },
      },
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "pr-opened",
        issueNumber,
        observedAt: "2026-03-09T10:10:00.000Z",
        attemptNumber: 1,
        sessionId,
        details: {
          branch,
          summary: "PR opened and awaiting checks",
          pullRequest: {
            number: 144,
            url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
            latestCommitAt: "2026-03-09T10:09:30.000Z",
          },
          review: {
            actionableCount: 0,
            unresolvedThreadCount: 0,
          },
          checks: {
            pendingNames: ["CI"],
            failingNames: [],
          },
        },
      },
    ],
  });

  await store.recordObservation({
    issue: {
      issueNumber,
      issueIdentifier,
      repo: "sociotechnica-org/symphony-ts",
      title: "Generate per-issue reports from local artifacts",
      issueUrl,
      branch,
      currentOutcome: "succeeded",
      currentSummary: "Issue completed successfully",
      observedAt: "2026-03-09T10:20:00.000Z",
      latestAttemptNumber: 1,
      latestSessionId: sessionId,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "succeeded",
        issueNumber,
        observedAt: "2026-03-09T10:20:00.000Z",
        attemptNumber: 1,
        sessionId,
        details: {
          summary: "Issue completed successfully",
          pullRequest: {
            number: 144,
            url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
            latestCommitAt: "2026-03-09T10:19:00.000Z",
          },
          review: {
            actionableCount: 0,
            unresolvedThreadCount: 0,
          },
          checks: {
            pendingNames: [],
            failingNames: [],
          },
        },
      },
    ],
  });
}

export async function seedFailedIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
): Promise<void> {
  const store = new LocalIssueArtifactStore(workspaceRoot);
  const issueIdentifier = `sociotechnica-org/symphony-ts#${issueNumber.toString()}`;
  const issueUrl = `https://github.com/sociotechnica-org/symphony-ts/issues/${issueNumber.toString()}`;
  const branch = `symphony/${issueNumber.toString()}`;
  const sessionId = `${issueIdentifier}/attempt-2/session-1`;

  await store.recordObservation({
    issue: {
      issueNumber,
      issueIdentifier,
      repo: "sociotechnica-org/symphony-ts",
      title: "Generate per-issue reports from local artifacts",
      issueUrl,
      branch,
      currentOutcome: "retry-scheduled",
      currentSummary: "Retry scheduled after missing PR",
      observedAt: "2026-03-09T11:00:00.000Z",
      latestAttemptNumber: 2,
      latestSessionId: sessionId,
    },
    attempt: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 2,
      branch,
      startedAt: "2026-03-09T10:55:00.000Z",
      finishedAt: "2026-03-09T11:00:00.000Z",
      outcome: "attempt-failed",
      summary: "No open pull request found",
      sessionId,
      runnerPid: 5252,
      pullRequest: null,
      review: null,
      checks: null,
    },
    session: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 2,
      sessionId,
      provider: "codex",
      model: "gpt-5.4",
      startedAt: "2026-03-09T10:55:00.000Z",
      finishedAt: "2026-03-09T11:00:00.000Z",
      workspacePath: path.join(
        workspaceRoot,
        `issue-${issueNumber.toString()}`,
      ),
      branch,
      logPointers: [],
    },
    logPointers: {
      sessionId,
      pointers: [],
      archiveLocation: null,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "retry-scheduled",
        issueNumber,
        observedAt: "2026-03-09T11:00:00.000Z",
        attemptNumber: 2,
        sessionId,
        details: {
          summary: "Retry scheduled after missing PR",
          branch,
        },
      },
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "failed",
        issueNumber,
        observedAt: "2026-03-09T11:10:00.000Z",
        attemptNumber: 2,
        sessionId,
        details: {
          summary: "Issue failed after retries were exhausted",
          branch,
        },
      },
    ],
  });
}

export async function seedSessionAnchoredPartialArtifacts(
  workspaceRoot: string,
  issueNumber: number,
): Promise<void> {
  const paths = deriveIssueArtifactPaths(workspaceRoot, issueNumber);
  const sessionId = `issue-${issueNumber.toString()}-session-1`;

  await fs.mkdir(paths.attemptsDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });

  await writeJsonFile(path.join(paths.attemptsDir, "1.json"), {
    version: ISSUE_ARTIFACT_SCHEMA_VERSION,
    issueNumber,
    attemptNumber: 1,
    branch: `symphony/${issueNumber.toString()}`,
    startedAt: "2026-03-09T12:00:00.000Z",
    finishedAt: "2026-03-09T12:05:00.000Z",
    outcome: "attempt-failed",
    summary: "Observed from attempt snapshot only",
    sessionId,
    runnerPid: 6363,
    pullRequest: null,
    review: null,
    checks: null,
  });

  await writeJsonFile(
    path.join(paths.sessionsDir, `${encodeURIComponent(sessionId)}.json`),
    {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 1,
      sessionId,
      provider: "codex",
      model: "gpt-5.4",
      startedAt: "2026-03-09T12:00:00.000Z",
      finishedAt: "2026-03-09T12:05:00.000Z",
      workspacePath: path.join(
        workspaceRoot,
        `issue-${issueNumber.toString()}`,
      ),
      branch: `symphony/${issueNumber.toString()}`,
      logPointers: [
        {
          name: "runner.log",
          location: path.join(paths.logsDir, "runner.log"),
          archiveLocation: null,
        },
      ],
    },
  );

  await writeJsonFile(paths.logPointersFile, {
    version: ISSUE_ARTIFACT_SCHEMA_VERSION,
    issueNumber,
    sessions: {
      [sessionId]: {
        sessionId,
        pointers: [
          {
            name: "runner.log",
            location: path.join(paths.logsDir, "runner.log"),
            archiveLocation: null,
          },
        ],
        archiveLocation: null,
      },
    },
  });
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
