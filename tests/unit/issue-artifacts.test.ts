import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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

    expect(deriveFactoryRuntimeRoot(workspaceRoot)).toBe(
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
          version: 1,
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
          version: 1,
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
        currentOutcome: "awaiting-review",
        currentSummary: "PR opened",
        observedAt,
        latestAttemptNumber: 1,
        latestSessionId: sessionId,
      },
      attempt: {
        version: 1,
        issueNumber: 43,
        attemptNumber: 1,
        branch: "symphony/43",
        startedAt: "2026-03-09T10:00:00.000Z",
        finishedAt: observedAt,
        outcome: "awaiting-review",
        summary: "PR opened",
        sessionId,
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
        version: 1,
        issueNumber: 43,
        attemptNumber: 1,
        sessionId,
        provider: "local-runner",
        model: null,
        startedAt: "2026-03-09T10:00:00.000Z",
        finishedAt: observedAt,
        workspacePath: "/tmp/workspaces/43",
        branch: "symphony/43",
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

    const logPointers = await readIssueArtifactLogPointers(workspaceRoot, 43);
    expect(logPointers.sessions[sessionId]?.sessionId).toBe(sessionId);

    const sessionPath = path.join(
      deriveIssueArtifactPaths(workspaceRoot, 43).sessionsDir,
      `${encodeURIComponent(sessionId)}.json`,
    );
    await expect(fs.stat(sessionPath)).resolves.toBeDefined();
  });
});
