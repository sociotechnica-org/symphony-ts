import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coerceRuntimeInstancePaths,
  deriveRuntimeInstancePaths,
} from "../../src/domain/workflow.js";
import { ObservabilityError } from "../../src/domain/errors.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  LocalIssueArtifactStore,
  appendIssueArtifactEvent,
  deriveFactoryArtifactsRoot,
  deriveIssueArtifactPaths,
  deriveIssueArtifactsRoot,
  readIssueArtifactAttempt,
  readIssueArtifactEvents,
  readIssueArtifactLogPointers,
  readIssueArtifactSession,
  readIssueArtifactSummary,
} from "../../src/observability/issue-artifacts.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import { createTempDir } from "../support/git.js";

const tempRoots: string[] = [];

async function createWorkspaceRoot(): Promise<string> {
  const tempDir = await createTempDir("symphony-issue-artifacts-");
  tempRoots.push(tempDir);
  return path.join(tempDir, ".tmp", "workspaces");
}

function deriveInstanceFromWorkspaceRoot(workspaceRoot: string) {
  return coerceRuntimeInstancePaths(workspaceRoot);
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("issue artifacts", () => {
  it("derives a repo-level factory root outside the cleanup-managed workspace tree", () => {
    const workspaceRoot = path.join("/repo", ".tmp", "workspaces");
    const nestedWorkspaceRoot = path.join(
      "/repo",
      ".tmp",
      "factory",
      "workspaces",
    );
    const nonTmpWorkspaceRoot = path.join("/repo", "local-workspaces");

    expect(
      deriveFactoryArtifactsRoot(
        deriveInstanceFromWorkspaceRoot(workspaceRoot),
      ),
    ).toBe(path.join("/repo", ".var", "factory"));
    expect(
      deriveFactoryArtifactsRoot(
        deriveInstanceFromWorkspaceRoot(nestedWorkspaceRoot),
      ),
    ).toBe(path.join("/repo", ".var", "factory"));
    expect(
      deriveFactoryArtifactsRoot(
        deriveRuntimeInstancePaths({
          workflowPath: path.join("/repo", "WORKFLOW.md"),
          workspaceRoot: nonTmpWorkspaceRoot,
        }),
      ),
    ).toBe(path.join("/repo", ".var", "factory"));
    expect(
      deriveIssueArtifactsRoot(deriveInstanceFromWorkspaceRoot(workspaceRoot)),
    ).toBe(path.join("/repo", ".var", "factory", "issues"));
    expect(
      deriveIssueArtifactPaths(
        deriveInstanceFromWorkspaceRoot(workspaceRoot),
        43,
      ).issueRoot,
    ).toBe(path.join("/repo", ".var", "factory", "issues", "43"));
  });

  it("rejects string coercion when workspace roots are outside the instance .tmp tree", () => {
    expect(() =>
      coerceRuntimeInstancePaths(path.join("/repo", "local-workspaces")),
    ).toThrowError(
      /pass resolved config\.instance when workspace\.root is outside the instance \.tmp directory/,
    );
  });

  it("writes the base layout and suppresses duplicate consecutive lifecycle events", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);
    const firstObservedAt = "2026-03-09T10:00:00.000Z";
    const secondObservedAt = "2026-03-09T10:05:00.000Z";

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "awaiting-plan-review",
        currentSummary: "Waiting for human review",
        observedAt: firstObservedAt,
        trackerState: "open",
        trackerLabels: ["symphony:running"],
        latestAttemptNumber: 1,
      },
      events: [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "plan-ready",
          issueNumber: 43,
          observedAt: firstObservedAt,
          attemptNumber: 1,
          sessionId: null,
          details: {
            branch: "symphony/43",
          },
        },
      ],
    });

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        currentOutcome: "awaiting-plan-review",
        currentSummary: "Waiting for human review",
        observedAt: secondObservedAt,
        trackerState: "open",
        trackerLabels: ["symphony:running"],
      },
      events: [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "plan-ready",
          issueNumber: 43,
          observedAt: secondObservedAt,
          attemptNumber: 1,
          sessionId: null,
          details: {
            branch: "symphony/43",
          },
        },
      ],
    });

    const summary = await readIssueArtifactSummary(instance, 43);
    expect(summary.firstObservedAt).toBe(firstObservedAt);
    expect(summary.lastUpdatedAt).toBe(secondObservedAt);
    expect(summary.latestAttemptNumber).toBe(1);
    expect(summary.branch).toBe("symphony/43");
    expect(summary.mergedAt).toBeNull();
    expect(summary.closedAt).toBeNull();
    expect(summary.trackerState).toBe("open");
    expect(summary.trackerLabels).toEqual(["symphony:running"]);
    expect(summary.issueTransitions).toEqual([]);

    const events = await readIssueArtifactEvents(instance, 43);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("plan-ready");

    const logPointers = await readIssueArtifactLogPointers(instance, 43);
    expect(logPointers.sessions).toEqual({});

    const paths = deriveIssueArtifactPaths(instance, 43);
    await expect(fs.stat(paths.attemptsDir)).resolves.toBeDefined();
    await expect(fs.stat(paths.sessionsDir)).resolves.toBeDefined();
    await expect(fs.stat(paths.logsDir)).resolves.toBeDefined();
  });

  it("persists additive merge and close lifecycle facts in the canonical issue summary", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "succeeded",
        currentSummary: "Issue completed successfully",
        observedAt: "2026-03-09T10:20:00.000Z",
        mergedAt: "2026-03-09T10:18:00.000Z",
        closedAt: "2026-03-09T10:20:00.000Z",
        trackerState: "closed",
        trackerLabels: [],
      },
      events: [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "succeeded",
          issueNumber: 43,
          observedAt: "2026-03-09T10:20:00.000Z",
          attemptNumber: 1,
          sessionId: null,
          details: {
            mergedAt: "2026-03-09T10:18:00.000Z",
            closedAt: "2026-03-09T10:20:00.000Z",
          },
        },
      ],
    });

    const summary = await readIssueArtifactSummary(instance, 43);
    expect(summary.mergedAt).toBe("2026-03-09T10:18:00.000Z");
    expect(summary.closedAt).toBe("2026-03-09T10:20:00.000Z");
    expect(summary.trackerState).toBe("closed");
    expect(summary.trackerLabels).toEqual([]);
  });

  it("records tracker state and label transitions in the canonical issue summary", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "claimed",
        currentSummary: "Claimed issue",
        observedAt: "2026-03-09T10:00:00.000Z",
        trackerState: "open",
        trackerLabels: ["symphony:running"],
      },
    });

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "failed",
        currentSummary: "Issue failed",
        observedAt: "2026-03-09T10:05:00.000Z",
        trackerState: "open",
        trackerLabels: ["symphony:failed"],
      },
    });

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "succeeded",
        currentSummary: "Issue completed successfully",
        observedAt: "2026-03-09T10:10:00.000Z",
        trackerState: "closed",
        trackerLabels: [],
      },
    });

    const summary = await readIssueArtifactSummary(instance, 43);
    expect(summary.issueTransitions).toEqual([
      {
        observedAt: "2026-03-09T10:05:00.000Z",
        kind: "labels-changed",
        fromLabels: ["symphony:running"],
        toLabels: ["symphony:failed"],
        addedLabels: ["symphony:failed"],
        removedLabels: ["symphony:running"],
      },
      {
        observedAt: "2026-03-09T10:10:00.000Z",
        kind: "state-changed",
        fromState: "open",
        toState: "closed",
      },
      {
        observedAt: "2026-03-09T10:10:00.000Z",
        kind: "labels-changed",
        fromLabels: ["symphony:failed"],
        toLabels: [],
        addedLabels: [],
        removedLabels: ["symphony:failed"],
      },
    ]);
  });

  it("treats the first tracker snapshot on a legacy summary as baseline instead of a transition", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const paths = deriveIssueArtifactPaths(instance, 43);
    await fs.mkdir(paths.issueRoot, { recursive: true });
    await fs.writeFile(
      paths.issueFile,
      JSON.stringify({
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "claimed",
        currentSummary: "Claimed issue",
        firstObservedAt: "2026-03-09T10:00:00.000Z",
        lastUpdatedAt: "2026-03-09T10:00:00.000Z",
        mergedAt: null,
        closedAt: null,
        latestAttemptNumber: null,
        latestSessionId: null,
      }),
      "utf8",
    );

    const store = new LocalIssueArtifactStore(instance);
    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "running",
        currentSummary: "Runner active",
        observedAt: "2026-03-09T10:05:00.000Z",
        trackerState: "open",
        trackerLabels: ["symphony:running"],
      },
    });

    const summary = await readIssueArtifactSummary(instance, 43);
    expect(summary.trackerState).toBe("open");
    expect(summary.trackerLabels).toEqual(["symphony:running"]);
    expect(summary.issueTransitions).toEqual([]);
  });

  it("deduplicates keyed operator intervention events across non-consecutive writes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "awaiting-landing-command",
        currentSummary: "Waiting for /land",
        observedAt: "2026-03-09T10:00:00.000Z",
        latestAttemptNumber: 1,
      },
      events: [
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          kind: "pr-opened",
          issueNumber: 43,
          observedAt: "2026-03-09T10:00:00.000Z",
          attemptNumber: 1,
          sessionId: null,
          details: {
            summary: "PR opened",
          },
        },
      ],
    });

    await appendIssueArtifactEvent(instance, 43, {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      kind: "landing-command-observed",
      issueNumber: 43,
      observedAt: "2026-03-09T10:05:00.000Z",
      attemptNumber: 1,
      sessionId: null,
      details: {
        eventKey: "landing-command:comment-1",
        summary: "Observed /land",
      },
    });
    await appendIssueArtifactEvent(instance, 43, {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      kind: "landing-requested",
      issueNumber: 43,
      observedAt: "2026-03-09T10:06:00.000Z",
      attemptNumber: 1,
      sessionId: null,
      details: {
        summary: "Landing requested",
      },
    });
    await appendIssueArtifactEvent(instance, 43, {
      version: ISSUE_ARTIFACT_SCHEMA_VERSION,
      kind: "landing-command-observed",
      issueNumber: 43,
      observedAt: "2026-03-09T10:07:00.000Z",
      attemptNumber: 1,
      sessionId: null,
      details: {
        eventKey: "landing-command:comment-1",
        summary: "Observed /land again",
      },
    });

    const events = await readIssueArtifactEvents(instance, 43);
    expect(
      events.filter((event) => event.kind === "landing-command-observed"),
    ).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual([
      "pr-opened",
      "landing-command-observed",
      "landing-requested",
    ]);
  });

  it("writes attempt, session, and pointer snapshots with session-id-safe filenames", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);
    const observedAt = "2026-03-09T10:10:00.000Z";
    const sessionId = "sociotechnica-org/symphony-ts#43/attempt-1/abc";

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Local Issue Reporting Artifact Contract",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "awaiting-system-checks",
        currentSummary: "PR opened",
        observedAt,
        latestAttemptNumber: 1,
        latestSessionId: sessionId,
      },
      attempt: {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber: 43,
        attemptNumber: 1,
        branch: "symphony/43",
        startedAt: "2026-03-09T10:00:00.000Z",
        finishedAt: observedAt,
        outcome: "awaiting-system-checks",
        summary: "PR opened",
        sessionId,
        latestTurnNumber: 2,
        runnerPid: 1234,
        pullRequest: {
          number: 99,
          url: "https://example.test/pulls/99",
          latestCommitAt: observedAt,
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
      session: {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber: 43,
        attemptNumber: 1,
        sessionId,
        provider: "local-runner",
        model: null,
        transport: createRunnerTransportMetadata("local-process", {
          canTerminateLocalProcess: true,
        }),
        backendSessionId: null,
        backendThreadId: null,
        latestTurnId: null,
        latestTurnNumber: 2,
        startedAt: "2026-03-09T10:00:00.000Z",
        finishedAt: observedAt,
        workspacePath: "/tmp/workspaces/43",
        branch: "symphony/43",
        accounting: {
          status: "partial",
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          costUsd: null,
        },
        logPointers: [],
      },
      logPointers: {
        sessionId,
        pointers: [],
        archiveLocation: null,
      },
    });

    const attempt = await readIssueArtifactAttempt(instance, 43, 1);
    expect(attempt.runnerPid).toBe(1234);
    expect(attempt.pullRequest?.number).toBe(99);

    const session = await readIssueArtifactSession(instance, 43, sessionId);
    expect(session.provider).toBe("local-runner");
    expect(session.finishedAt).toBe(observedAt);
    expect(session.accounting).toEqual({
      status: "partial",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      costUsd: null,
    });

    const logPointers = await readIssueArtifactLogPointers(instance, 43);
    expect(logPointers.sessions[sessionId]?.sessionId).toBe(sessionId);

    const sessionPath = path.join(
      deriveIssueArtifactPaths(instance, 43).sessionsDir,
      `${encodeURIComponent(sessionId)}.json`,
    );
    await expect(fs.stat(sessionPath)).resolves.toBeDefined();
  });

  it("wraps malformed event JSONL reads in an observability error", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const paths = deriveIssueArtifactPaths(instance, 43);

    await fs.mkdir(paths.issueRoot, { recursive: true });
    await fs.writeFile(paths.eventsFile, "{not-json}\n", "utf8");

    await expect(readIssueArtifactEvents(instance, 43)).rejects.toThrow(
      ObservabilityError,
    );
    await expect(readIssueArtifactEvents(instance, 43)).rejects.toThrow(
      paths.eventsFile,
    );
  });

  it("backfills latestTurnNumber from the latest session snapshot when finalizing an attempt", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const store = new LocalIssueArtifactStore(instance);
    const sessionId = "sociotechnica-org/symphony-ts#43/attempt-1";

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Runner continuation",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "running",
        currentSummary: "Running",
        observedAt: "2026-03-09T10:00:00.000Z",
        latestAttemptNumber: 1,
        latestSessionId: sessionId,
      },
      session: {
        version: ISSUE_ARTIFACT_SCHEMA_VERSION,
        issueNumber: 43,
        attemptNumber: 1,
        sessionId,
        provider: "codex",
        model: "gpt-5",
        transport: createRunnerTransportMetadata("local-process", {
          canTerminateLocalProcess: true,
        }),
        backendSessionId: "backend-1",
        backendThreadId: null,
        latestTurnId: null,
        latestTurnNumber: 3,
        startedAt: "2026-03-09T10:00:00.000Z",
        finishedAt: null,
        workspacePath: "/tmp/workspaces/43",
        branch: "symphony/43",
        logPointers: [],
      },
    });

    await store.recordObservation({
      issue: {
        issueNumber: 43,
        issueIdentifier: "sociotechnica-org/symphony-ts#43",
        repo: "sociotechnica-org/symphony-ts",
        title: "Runner continuation",
        issueUrl: "https://example.test/issues/43",
        branch: "symphony/43",
        currentOutcome: "failed",
        currentSummary: "failed",
        observedAt: "2026-03-09T10:00:30.000Z",
        latestAttemptNumber: 1,
        latestSessionId: sessionId,
      },
    });

    const attempt = await readIssueArtifactAttempt(instance, 43, 1);
    expect(attempt.latestTurnNumber).toBe(3);
  });

  it("backfills transport metadata for legacy session snapshots", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const paths = deriveIssueArtifactPaths(instance, 43);
    const sessionId = "legacy-session";

    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(paths.sessionsDir, `${encodeURIComponent(sessionId)}.json`),
      `${JSON.stringify(
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          issueNumber: 43,
          attemptNumber: 1,
          sessionId,
          provider: "codex",
          model: "gpt-5.4",
          backendSessionId: "backend-1",
          backendThreadId: null,
          latestTurnId: null,
          appServerPid: 4242,
          latestTurnNumber: 1,
          startedAt: "2026-03-09T10:00:00.000Z",
          finishedAt: null,
          workspacePath: "/tmp/workspaces/43",
          branch: "symphony/43",
          logPointers: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await readIssueArtifactSession(instance, 43, sessionId);

    expect(session.transport).toEqual(
      createRunnerTransportMetadata("local-stdio-session", {
        localProcessPid: 4242,
        canTerminateLocalProcess: true,
      }),
    );
  });

  it("does not invent a controllable local process for legacy sessions without appServerPid", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const paths = deriveIssueArtifactPaths(instance, 43);
    const sessionId = "legacy-session-no-pid";

    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(paths.sessionsDir, `${encodeURIComponent(sessionId)}.json`),
      `${JSON.stringify(
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          issueNumber: 43,
          attemptNumber: 1,
          sessionId,
          provider: "generic-command",
          model: null,
          backendSessionId: null,
          backendThreadId: null,
          latestTurnId: null,
          appServerPid: null,
          latestTurnNumber: 1,
          startedAt: "2026-03-09T10:00:00.000Z",
          finishedAt: "2026-03-09T10:01:00.000Z",
          workspacePath: "/tmp/workspaces/43",
          branch: "symphony/43",
          logPointers: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await readIssueArtifactSession(instance, 43, sessionId);

    expect(session.transport).toEqual(
      createRunnerTransportMetadata("local-process", {
        canTerminateLocalProcess: true,
      }),
    );
  });

  it("normalizes missing legacy backend thread fields to null", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const instance = deriveInstanceFromWorkspaceRoot(workspaceRoot);
    const paths = deriveIssueArtifactPaths(instance, 43);
    const sessionId = "legacy-session-missing-thread-fields";

    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(paths.sessionsDir, `${encodeURIComponent(sessionId)}.json`),
      `${JSON.stringify(
        {
          version: ISSUE_ARTIFACT_SCHEMA_VERSION,
          issueNumber: 43,
          attemptNumber: 1,
          sessionId,
          provider: "codex",
          model: "gpt-5.4",
          backendSessionId: "backend-1",
          appServerPid: 4242,
          latestTurnNumber: 1,
          startedAt: "2026-03-09T10:00:00.000Z",
          finishedAt: null,
          workspacePath: "/tmp/workspaces/43",
          branch: "symphony/43",
          logPointers: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await readIssueArtifactSession(instance, 43, sessionId);

    expect(session.backendThreadId).toBeNull();
    expect(session.latestTurnId).toBeNull();
    expect(session.transport).toEqual(
      createRunnerTransportMetadata("local-stdio-session", {
        localProcessPid: 4242,
        canTerminateLocalProcess: true,
      }),
    );
  });
});
