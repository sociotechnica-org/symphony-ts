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

export function deriveCodexSessionsRoot(rootDir: string): string {
  return path.join(rootDir, ".codex", "sessions");
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

export async function writeCodexSessionLog(options: {
  readonly sessionsRoot: string;
  readonly startedAt: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly fileName: string;
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly finalSummary?: string | undefined;
  readonly malformed?: boolean | undefined;
}): Promise<string> {
  const date = new Date(options.startedAt);
  const dayRoot = path.join(
    options.sessionsRoot,
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  );
  const filePath = path.join(dayRoot, options.fileName);
  await fs.mkdir(dayRoot, { recursive: true });

  if (options.malformed === true) {
    await fs.writeFile(filePath, "{not-json}\n", "utf8");
    return filePath;
  }

  const lines = [
    {
      timestamp: options.startedAt,
      type: "session_meta",
      payload: {
        id: options.fileName.replace(/\.jsonl$/u, ""),
        timestamp: options.startedAt,
        cwd: options.workspacePath,
        originator: "codex_cli_rs",
        cli_version: "0.71.0",
        source: "cli",
        model_provider: "openai",
        git: {
          commit_hash: "abc123def456",
          branch: options.branch,
          repository_url: "git@github.com:sociotechnica-org/symphony-ts.git",
        },
      },
    },
    {
      timestamp: options.startedAt,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: options.inputTokens ?? 2000,
            cached_input_tokens: options.cachedInputTokens ?? 500,
            output_tokens: options.outputTokens ?? 250,
            reasoning_output_tokens: options.reasoningOutputTokens ?? 100,
            total_tokens: options.totalTokens ?? 2750,
          },
        },
      },
    },
    {
      timestamp: options.startedAt,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text:
              options.finalSummary ??
              "- Added optional runner-log enrichment and preserved provider-neutral report output.",
          },
        ],
      },
    },
  ];

  await fs.writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}
