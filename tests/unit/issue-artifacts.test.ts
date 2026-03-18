import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObservabilityError } from "../../src/domain/errors.js";
import {
  ISSUE_ARTIFACT_SCHEMA_VERSION,
  LocalIssueArtifactStore,
  deriveFactoryRuntimeRoot,
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

    expect(deriveFactoryRuntimeRoot(workspaceRoot)).toBe(
      path.join("/repo", ".var", "factory"),
    );
    expect(deriveFactoryRuntimeRoot(nestedWorkspaceRoot)).toBe(
      path.join("/repo", ".var", "factory"),
    );
    expect(deriveFactoryRuntimeRoot(nonTmpWorkspaceRoot)).toBe(
      path.join("/repo", ".var", "factory"),
    );
    expect(deriveIssueArtifactsRoot(workspaceRoot)).toBe(
      path.join("/repo", ".var", "factory", "issues"),
    );
    expect(deriveIssueArtifactPaths(workspaceRoot, 43).issueRoot).toBe(
      path.join("/repo", ".var", "factory", "issues", "43"),
    );
  });

  it("writes the base layout and suppresses duplicate consecutive lifecycle events", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const store = new LocalIssueArtifactStore(workspaceRoot);
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

    const summary = await readIssueArtifactSummary(workspaceRoot, 43);
    expect(summary.firstObservedAt).toBe(firstObservedAt);
    expect(summary.lastUpdatedAt).toBe(secondObservedAt);
    expect(summary.latestAttemptNumber).toBe(1);
    expect(summary.branch).toBe("symphony/43");

    const events = await readIssueArtifactEvents(workspaceRoot, 43);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("plan-ready");

    const logPointers = await readIssueArtifactLogPointers(workspaceRoot, 43);
    expect(logPointers.sessions).toEqual({});

    const paths = deriveIssueArtifactPaths(workspaceRoot, 43);
    await expect(fs.stat(paths.attemptsDir)).resolves.toBeDefined();
    await expect(fs.stat(paths.sessionsDir)).resolves.toBeDefined();
    await expect(fs.stat(paths.logsDir)).resolves.toBeDefined();
  });

  it("writes attempt, session, and pointer snapshots with session-id-safe filenames", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const store = new LocalIssueArtifactStore(workspaceRoot);
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

    const attempt = await readIssueArtifactAttempt(workspaceRoot, 43, 1);
    expect(attempt.runnerPid).toBe(1234);
    expect(attempt.pullRequest?.number).toBe(99);

    const session = await readIssueArtifactSession(
      workspaceRoot,
      43,
      sessionId,
    );
    expect(session.provider).toBe("local-runner");
    expect(session.finishedAt).toBe(observedAt);
    expect(session.accounting).toEqual({
      status: "partial",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      costUsd: null,
    });

    const logPointers = await readIssueArtifactLogPointers(workspaceRoot, 43);
    expect(logPointers.sessions[sessionId]?.sessionId).toBe(sessionId);

    const sessionPath = path.join(
      deriveIssueArtifactPaths(workspaceRoot, 43).sessionsDir,
      `${encodeURIComponent(sessionId)}.json`,
    );
    await expect(fs.stat(sessionPath)).resolves.toBeDefined();
  });

  it("wraps malformed event JSONL reads in an observability error", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const paths = deriveIssueArtifactPaths(workspaceRoot, 43);

    await fs.mkdir(paths.issueRoot, { recursive: true });
    await fs.writeFile(paths.eventsFile, "{not-json}\n", "utf8");

    await expect(readIssueArtifactEvents(workspaceRoot, 43)).rejects.toThrow(
      ObservabilityError,
    );
    await expect(readIssueArtifactEvents(workspaceRoot, 43)).rejects.toThrow(
      paths.eventsFile,
    );
  });

  it("backfills latestTurnNumber from the latest session snapshot when finalizing an attempt", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const store = new LocalIssueArtifactStore(workspaceRoot);
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

    const attempt = await readIssueArtifactAttempt(workspaceRoot, 43, 1);
    expect(attempt.latestTurnNumber).toBe(3);
  });
});
