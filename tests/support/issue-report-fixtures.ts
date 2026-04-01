import fs from "node:fs/promises";
import path from "node:path";
import type {
  PullRequestRequiredReviewerState,
  PullRequestReviewerVerdict,
} from "../../src/domain/handoff.js";
import { deriveRuntimeInstancePaths } from "../../src/domain/workflow.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  LocalIssueArtifactStore,
  deriveIssueArtifactPaths,
  type IssueArtifactEvent,
  type IssueArtifactOutcome,
} from "../../src/observability/issue-artifacts.js";
import type { RunnerAccountingSnapshot } from "../../src/runner/accounting.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";

export async function writeReportWorkflow(
  rootDir: string,
  options?: {
    readonly archiveRoot?: string | undefined;
  },
): Promise<string> {
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
    backoff_ms: 0
workspace:
  root: ./.tmp/workspaces
  repo_url: /tmp/repo.git
  branch_prefix: symphony/
  cleanup_on_success: false
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}
observability:
${
  options?.archiveRoot === undefined
    ? "  dashboard_enabled: true"
    : `  dashboard_enabled: true
  issue_reports:
    archive_root: ${options.archiveRoot}`
}
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

export function deriveReportInstance(rootDir: string) {
  return deriveRuntimeInstancePaths({
    workflowPath: path.join(rootDir, "WORKFLOW.md"),
    workspaceRoot: deriveWorkspaceRoot(rootDir),
  });
}

function deriveInstanceFromWorkspaceRoot(workspaceRoot: string) {
  return deriveRuntimeInstancePaths({
    workflowPath: path.join(
      path.dirname(path.dirname(workspaceRoot)),
      "WORKFLOW.md",
    ),
    workspaceRoot,
  });
}

export function deriveCodexSessionsRoot(rootDir: string): string {
  return path.join(rootDir, ".codex", "sessions");
}

export async function seedSuccessfulIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
  options?: {
    readonly claimedAt?: string | undefined;
    readonly planReadyAt?: string | undefined;
    readonly attemptStartedAt?: string | undefined;
    readonly prOpenedAt?: string | undefined;
    readonly latestCommitAt?: string | undefined;
    readonly mergedAt?: string | null | undefined;
    readonly closedAt?: string | null | undefined;
    readonly succeededAt?: string | undefined;
    readonly finalCommitAt?: string | undefined;
    readonly accounting?: RunnerAccountingSnapshot | undefined;
    readonly review?:
      | {
          readonly actionableCount?: number | undefined;
          readonly unresolvedThreadCount?: number | undefined;
          readonly reviewerVerdict?: PullRequestReviewerVerdict | undefined;
          readonly blockingReviewerKeys?: readonly string[] | undefined;
          readonly requiredReviewerState?:
            | PullRequestRequiredReviewerState
            | undefined;
        }
      | undefined;
    readonly backendSessionId?: string | undefined;
    readonly backendThreadId?: string | undefined;
  },
): Promise<void> {
  const store = new LocalIssueArtifactStore(
    deriveInstanceFromWorkspaceRoot(workspaceRoot),
  );
  const issueIdentifier = `sociotechnica-org/symphony-ts#${issueNumber.toString()}`;
  const issueUrl = `https://github.com/sociotechnica-org/symphony-ts/issues/${issueNumber.toString()}`;
  const branch = `symphony/${issueNumber.toString()}`;
  const sessionId = `${issueIdentifier}/attempt-1/session-1`;
  const claimedAt = options?.claimedAt ?? "2026-03-09T10:00:00.000Z";
  const planReadyAt = options?.planReadyAt ?? "2026-03-09T10:02:00.000Z";
  const attemptStartedAt =
    options?.attemptStartedAt ?? "2026-03-09T10:05:00.000Z";
  const prOpenedAt = options?.prOpenedAt ?? "2026-03-09T10:10:00.000Z";
  const latestCommitAt = options?.latestCommitAt ?? "2026-03-09T10:09:30.000Z";
  const succeededAt = options?.succeededAt ?? "2026-03-09T10:20:00.000Z";
  const mergedAt =
    options?.mergedAt === undefined
      ? "2026-03-09T10:18:00.000Z"
      : options.mergedAt;
  const closedAt =
    options?.closedAt === undefined ? succeededAt : options.closedAt;
  const finalCommitAt = options?.finalCommitAt ?? "2026-03-09T10:19:00.000Z";
  const review = {
    actionableCount: options?.review?.actionableCount ?? 0,
    unresolvedThreadCount: options?.review?.unresolvedThreadCount ?? 0,
    reviewerVerdict: options?.review?.reviewerVerdict ?? "no-blocking-verdict",
    blockingReviewerKeys: options?.review?.blockingReviewerKeys ?? [],
    requiredReviewerState:
      options?.review?.requiredReviewerState ?? "satisfied",
  };

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
      observedAt: claimedAt,
      trackerState: "open",
      trackerLabels: ["symphony:running"],
      latestAttemptNumber: 1,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "claimed",
        issueNumber,
        observedAt: claimedAt,
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
        observedAt: planReadyAt,
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
      currentOutcome: "awaiting-system-checks",
      currentSummary: "PR opened and awaiting checks",
      observedAt: prOpenedAt,
      trackerState: "open",
      trackerLabels: ["symphony:running"],
      latestAttemptNumber: 1,
      latestSessionId: sessionId,
    },
    attempt: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 1,
      branch,
      startedAt: attemptStartedAt,
      finishedAt: prOpenedAt,
      outcome: "awaiting-system-checks",
      summary: "PR opened and awaiting checks",
      sessionId,
      latestTurnNumber: 1,
      runnerPid: 4242,
      pullRequest: {
        number: 144,
        url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
        latestCommitAt,
      },
      review: {
        actionableCount: review.actionableCount,
        unresolvedThreadCount: review.unresolvedThreadCount,
        reviewerVerdict: review.reviewerVerdict,
        blockingReviewerKeys: review.blockingReviewerKeys,
        requiredReviewerState: review.requiredReviewerState,
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
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: options?.backendSessionId ?? "codex-session-1",
      backendThreadId: options?.backendThreadId ?? null,
      latestTurnId: null,
      latestTurnNumber: 1,
      startedAt: attemptStartedAt,
      finishedAt: prOpenedAt,
      workspacePath: path.join(
        workspaceRoot,
        `issue-${issueNumber.toString()}`,
      ),
      branch,
      accounting: options?.accounting,
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
        observedAt: attemptStartedAt,
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
        observedAt: prOpenedAt,
        attemptNumber: 1,
        sessionId,
        details: {
          branch,
          summary: "PR opened and awaiting checks",
          pullRequest: {
            number: 144,
            url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
            latestCommitAt,
          },
          review: {
            actionableCount: review.actionableCount,
            unresolvedThreadCount: review.unresolvedThreadCount,
            reviewerVerdict: review.reviewerVerdict,
            blockingReviewerKeys: review.blockingReviewerKeys,
            requiredReviewerState: review.requiredReviewerState,
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
      observedAt: succeededAt,
      mergedAt,
      closedAt,
      trackerState: "closed",
      trackerLabels: [],
      latestAttemptNumber: 1,
      latestSessionId: sessionId,
    },
    events: [
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        kind: "succeeded",
        issueNumber,
        observedAt: succeededAt,
        attemptNumber: 1,
        sessionId,
        details: {
          summary: "Issue completed successfully",
          mergedAt,
          closedAt,
          pullRequest: {
            number: 144,
            url: "https://github.com/sociotechnica-org/symphony-ts/pull/144",
            latestCommitAt: finalCommitAt,
          },
          review: {
            actionableCount: review.actionableCount,
            unresolvedThreadCount: review.unresolvedThreadCount,
            reviewerVerdict: review.reviewerVerdict,
            blockingReviewerKeys: review.blockingReviewerKeys,
            requiredReviewerState: review.requiredReviewerState,
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

export async function seedEventOnlyIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
  options: {
    readonly currentOutcome: IssueArtifactOutcome;
    readonly currentSummary: string;
    readonly observedAt: string;
    readonly events: readonly IssueArtifactEvent[];
    readonly title?: string | undefined;
    readonly branch?: string | null | undefined;
    readonly trackerState?: "open" | "closed" | null | undefined;
    readonly trackerLabels?: readonly string[] | undefined;
  },
): Promise<void> {
  const artifactPaths = deriveIssueArtifactPaths(
    deriveInstanceFromWorkspaceRoot(workspaceRoot),
    issueNumber,
  );
  const issueIdentifier = `sociotechnica-org/symphony-ts#${issueNumber.toString()}`;
  const issueUrl = `https://github.com/sociotechnica-org/symphony-ts/issues/${issueNumber.toString()}`;

  await fs.mkdir(artifactPaths.issueRoot, { recursive: true });
  await fs.writeFile(
    artifactPaths.issueFile,
    `${JSON.stringify(
      {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber,
        issueIdentifier,
        repo: "sociotechnica-org/symphony-ts",
        title:
          options.title ?? "Generate per-issue reports from local artifacts",
        issueUrl,
        branch: options.branch ?? `symphony/${issueNumber.toString()}`,
        currentOutcome: options.currentOutcome,
        currentSummary: options.currentSummary,
        firstObservedAt: options.events[0]?.observedAt ?? options.observedAt,
        lastUpdatedAt: options.observedAt,
        trackerState: options.trackerState ?? null,
        trackerLabels: [...(options.trackerLabels ?? [])],
        latestAttemptNumber: options.events.at(-1)?.attemptNumber ?? null,
        latestSessionId: options.events.at(-1)?.sessionId ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    artifactPaths.eventsFile,
    options.events.map((event) => JSON.stringify(event)).join("\n"),
    "utf8",
  );
}

export async function seedFailedIssueArtifacts(
  workspaceRoot: string,
  issueNumber: number,
  options?: {
    readonly retryScheduledAt?: string | undefined;
    readonly attemptStartedAt?: string | undefined;
    readonly failedAt?: string | undefined;
  },
): Promise<void> {
  const store = new LocalIssueArtifactStore(workspaceRoot);
  const issueIdentifier = `sociotechnica-org/symphony-ts#${issueNumber.toString()}`;
  const issueUrl = `https://github.com/sociotechnica-org/symphony-ts/issues/${issueNumber.toString()}`;
  const branch = `symphony/${issueNumber.toString()}`;
  const sessionId = `${issueIdentifier}/attempt-2/session-1`;
  const retryScheduledAt =
    options?.retryScheduledAt ?? "2026-03-09T11:00:00.000Z";
  const attemptStartedAt =
    options?.attemptStartedAt ?? "2026-03-09T10:55:00.000Z";
  const failedAt = options?.failedAt ?? "2026-03-09T11:10:00.000Z";

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
      observedAt: retryScheduledAt,
      latestAttemptNumber: 2,
      latestSessionId: sessionId,
    },
    attempt: {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      issueNumber,
      attemptNumber: 2,
      branch,
      startedAt: attemptStartedAt,
      finishedAt: retryScheduledAt,
      outcome: "attempt-failed",
      summary: "No open pull request found",
      sessionId,
      latestTurnNumber: 1,
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
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: "codex-session-2",
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: 1,
      startedAt: attemptStartedAt,
      finishedAt: retryScheduledAt,
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
        observedAt: retryScheduledAt,
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
        observedAt: failedAt,
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
  const paths = deriveIssueArtifactPaths(
    deriveInstanceFromWorkspaceRoot(workspaceRoot),
    issueNumber,
  );
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
    latestTurnNumber: 1,
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
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: "codex-session-partial",
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: 1,
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

export async function seedLateUnfinishedSessionArtifacts(
  workspaceRoot: string,
  issueNumber: number,
  options?: {
    readonly startedAt?: string | undefined;
  },
): Promise<void> {
  const paths = deriveIssueArtifactPaths(
    deriveInstanceFromWorkspaceRoot(workspaceRoot),
    issueNumber,
  );
  const sessionId = `issue-${issueNumber.toString()}-session-1`;
  const startedAt = options?.startedAt ?? "2026-03-09T22:00:00.000Z";

  await fs.mkdir(paths.attemptsDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });

  await writeJsonFile(path.join(paths.attemptsDir, "1.json"), {
    version: ISSUE_ARTIFACT_SCHEMA_VERSION,
    issueNumber,
    attemptNumber: 1,
    branch: `symphony/${issueNumber.toString()}`,
    startedAt,
    finishedAt: null,
    outcome: "attempt-failed",
    summary: "Observed from an unfinished late-start session snapshot",
    sessionId,
    latestTurnNumber: 1,
    runnerPid: 7474,
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
      transport: createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
      backendSessionId: "codex-session-late",
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: 1,
      startedAt,
      finishedAt: null,
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
  readonly sessionMetaId?: string | undefined;
  readonly metaTimestamp?: string | null | undefined;
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly tokenEvents?:
    | readonly {
        readonly inputTokens?: number | undefined;
        readonly cachedInputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly reasoningOutputTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
      }[]
    | undefined;
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

  const metaTimestamp =
    options.metaTimestamp === undefined
      ? options.startedAt
      : options.metaTimestamp;
  const tokenEvents = options.tokenEvents ?? [
    {
      inputTokens: options.inputTokens ?? 2000,
      cachedInputTokens: options.cachedInputTokens ?? 500,
      outputTokens: options.outputTokens ?? 250,
      reasoningOutputTokens: options.reasoningOutputTokens ?? 100,
      totalTokens: options.totalTokens ?? 2750,
    },
  ];
  const lines = [
    {
      ...(metaTimestamp === null ? {} : { timestamp: metaTimestamp }),
      type: "session_meta",
      payload: {
        id: options.sessionMetaId ?? options.fileName.replace(/\.jsonl$/u, ""),
        ...(metaTimestamp === null ? {} : { timestamp: metaTimestamp }),
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
    ...tokenEvents.map((event) => ({
      timestamp: options.startedAt,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: event.inputTokens ?? 2000,
            cached_input_tokens: event.cachedInputTokens ?? 500,
            output_tokens: event.outputTokens ?? 250,
            reasoning_output_tokens: event.reasoningOutputTokens ?? 100,
            total_tokens: event.totalTokens ?? 2750,
          },
        },
      },
    })),
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

export async function downgradeIssueReportSchemaVersion(
  reportJsonFile: string,
  version = 1,
): Promise<void> {
  const parsedReport = JSON.parse(
    await fs.readFile(reportJsonFile, "utf8"),
  ) as {
    readonly tokenUsage?: {
      readonly sessions?: readonly Record<string, unknown>[];
    };
  } & Record<string, unknown>;
  const sessions = parsedReport.tokenUsage?.sessions ?? [];
  const staleSessions = sessions.map(
    ({ status: _status, notes: _notes, ...session }: Record<string, unknown>) =>
      session,
  );

  await fs.writeFile(
    reportJsonFile,
    `${JSON.stringify(
      {
        ...parsedReport,
        version,
        tokenUsage:
          parsedReport.tokenUsage === undefined
            ? undefined
            : {
                ...parsedReport.tokenUsage,
                observedTokenSubtotal: undefined,
                observedCostSubtotal: undefined,
                sessions: staleSessions,
              },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
