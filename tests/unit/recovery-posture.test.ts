import { describe, expect, it } from "vitest";
import { projectRecoveryPosture } from "../../src/orchestrator/recovery-posture.js";
import type {
  FactoryActiveIssueSnapshot,
  FactoryRestartRecoverySnapshot,
  FactoryRetrySnapshot,
} from "../../src/observability/status.js";

const restartRecovery: FactoryRestartRecoverySnapshot = {
  state: "idle",
  startedAt: null,
  completedAt: null,
  summary: null,
  issues: [],
};

const activeIssue: FactoryActiveIssueSnapshot = {
  issueNumber: 166,
  issueIdentifier: "sociotechnica-org/symphony-ts#166",
  title: "Recovery posture observability",
  source: "running",
  runSequence: 2,
  status: "awaiting-system-checks",
  summary: "Waiting for CI",
  workspacePath: "/tmp/workspaces/166",
  branchName: "symphony/166",
  runSessionId: "session-166",
  executionOwner: null,
  ownerPid: 100,
  runnerPid: 200,
  startedAt: "2026-03-17T10:00:00.000Z",
  updatedAt: "2026-03-17T10:05:00.000Z",
  pullRequest: null,
  checks: { pendingNames: ["CI"], failingNames: [] },
  review: { actionableCount: 0, unresolvedThreadCount: 0 },
  blockedReason: "Waiting for CI",
  runnerVisibility: null,
};

describe("projectRecoveryPosture", () => {
  it("prefers degraded observability over other posture families", () => {
    const posture = projectRecoveryPosture({
      publication: {
        state: "initializing",
        detail:
          "Factory startup is still publishing a current runtime snapshot.",
      },
      restartRecovery: {
        ...restartRecovery,
        state: "reconciling",
        startedAt: "2026-03-17T10:00:00.000Z",
      },
      activeIssues: [activeIssue],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("degraded-observability");
    expect(posture.entries[0]?.family).toBe("degraded-observability");
  });

  it("projects watchdog retry posture ahead of waiting posture", () => {
    const retries: readonly FactoryRetrySnapshot[] = [
      {
        issueNumber: 166,
        issueIdentifier: activeIssue.issueIdentifier,
        title: activeIssue.title,
        nextAttempt: 3,
        preferredHost: null,
        retryClass: "watchdog-abort",
        scheduledAt: "2026-03-17T10:06:00.000Z",
        backoffMs: 300000,
        dueAt: "2026-03-17T10:11:00.000Z",
        lastError: "watchdog abort",
      },
    ];

    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery,
      activeIssues: [activeIssue],
      retries,
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("watchdog-recovery");
    expect(posture.entries).toContainEqual(
      expect.objectContaining({
        family: "watchdog-recovery",
        issueNumber: 166,
      }),
    );
  });

  it("uses the factory-level restart summary when reconciliation has no issue decisions yet", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery: {
        ...restartRecovery,
        state: "reconciling",
        startedAt: "2026-03-17T10:00:00.000Z",
      },
      activeIssues: [],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("restart-recovery");
    expect(posture.summary.issueCount).toBe(0);
    expect(posture.summary.summary).toBe(
      "Restart reconciliation is still running.",
    );
    expect(posture.entries).toContainEqual(
      expect.objectContaining({
        family: "restart-recovery",
        issueNumber: null,
        summary: "Restart reconciliation is still running.",
      }),
    );
  });

  it("projects cleanup failure as degraded terminal posture", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery,
      activeIssues: [],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [
        {
          issueNumber: 166,
          issueIdentifier: activeIssue.issueIdentifier,
          title: activeIssue.title,
          branchName: "symphony/166",
          terminalOutcome: "failure",
          summary: "Issue failed; workspace cleanup failed: rm failed",
          observedAt: "2026-03-17T10:08:00.000Z",
          workspaceRetention: {
            reason: "failure",
            state: "cleanup-failed",
            action: "cleanup",
            cleanupError: "rm failed",
          },
        },
      ],
    });

    expect(posture.summary.family).toBe("degraded");
    expect(posture.entries).toContainEqual(
      expect.objectContaining({
        family: "degraded",
        source: "terminal-cleanup",
      }),
    );
  });

  it("keeps non-degraded restart decisions in restart-recovery posture", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery: {
        state: "degraded",
        startedAt: "2026-03-17T10:00:00.000Z",
        completedAt: "2026-03-17T10:02:00.000Z",
        summary:
          "Restart reconciliation completed with degraded inherited-state decisions.",
        issues: [
          {
            issueNumber: 166,
            issueIdentifier: activeIssue.issueIdentifier,
            branchName: "symphony/166",
            decision: "requeued",
            leaseState: "missing",
            lifecycleKind: "awaiting-system-checks",
            executionOwner: null,
            ownerPid: null,
            ownerAlive: null,
            runnerPid: null,
            runnerAlive: null,
            summary: "Requeued after restart reconciliation.",
            observedAt: "2026-03-17T10:02:00.000Z",
          },
          {
            issueNumber: 167,
            issueIdentifier: "sociotechnica-org/symphony-ts#167",
            branchName: "symphony/167",
            decision: "degraded",
            leaseState: "invalid",
            lifecycleKind: null,
            executionOwner: null,
            ownerPid: null,
            ownerAlive: null,
            runnerPid: null,
            runnerAlive: null,
            summary: "Inherited run metadata was invalid.",
            observedAt: "2026-03-17T10:02:30.000Z",
          },
        ],
      },
      activeIssues: [],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("degraded");
    expect(posture.entries).toContainEqual(
      expect.objectContaining({
        family: "restart-recovery",
        issueNumber: 166,
        source: "restart-recovery",
      }),
    );
    expect(posture.entries).toContainEqual(
      expect.objectContaining({
        family: "degraded",
        issueNumber: 167,
        source: "restart-recovery",
      }),
    );
  });

  it("uses singular recovery posture summaries for one issue", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery: {
        ...restartRecovery,
        issues: [
          {
            issueNumber: 166,
            issueIdentifier: activeIssue.issueIdentifier,
            branchName: "symphony/166",
            decision: "requeued",
            leaseState: "missing",
            lifecycleKind: "awaiting-system-checks",
            executionOwner: null,
            ownerPid: null,
            ownerAlive: null,
            runnerPid: null,
            runnerAlive: null,
            summary: "Requeued after restart reconciliation.",
            observedAt: "2026-03-17T10:02:00.000Z",
          },
        ],
      },
      activeIssues: [],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.summary).toBe(
      "1 issue still reflects restart reconciliation posture.",
    );

    const waitingPosture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery,
      activeIssues: [activeIssue],
      retries: [],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(waitingPosture.summary.summary).toBe(
      "1 issue is waiting on expected human or system gates.",
    );
  });

  it("counts only issues in the winning posture family", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery,
      activeIssues: [
        activeIssue,
        {
          ...activeIssue,
          issueNumber: 167,
          issueIdentifier: "sociotechnica-org/symphony-ts#167",
          title: "Another waiting issue",
          branchName: "symphony/167",
          runSessionId: "session-167",
        },
      ],
      retries: [
        {
          issueNumber: 166,
          issueIdentifier: activeIssue.issueIdentifier,
          title: activeIssue.title,
          nextAttempt: 3,
          preferredHost: null,
          retryClass: "watchdog-abort",
          scheduledAt: "2026-03-17T10:06:00.000Z",
          backoffMs: 300000,
          dueAt: "2026-03-17T10:11:00.000Z",
          lastError: "watchdog abort",
        },
      ],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("watchdog-recovery");
    expect(posture.summary.issueCount).toBe(1);
    expect(posture.summary.summary).toBe(
      "1 issue currently reflects watchdog recovery or watchdog-driven retry posture.",
    );
  });

  it("keeps waiting issues visible when retry backoff wins the factory summary", () => {
    const posture = projectRecoveryPosture({
      publication: { state: "current", detail: null },
      restartRecovery,
      activeIssues: [activeIssue],
      retries: [
        {
          issueNumber: 167,
          issueIdentifier: "sociotechnica-org/symphony-ts#167",
          title: "Retry under provider pressure",
          nextAttempt: 2,
          preferredHost: null,
          retryClass: "provider-rate-limit",
          scheduledAt: "2026-03-17T10:06:00.000Z",
          backoffMs: 1000,
          dueAt: "2026-03-17T10:06:01.000Z",
          lastError: "HTTP 429 rate limit exceeded",
        },
      ],
      watchdogIssues: new Map(),
      terminalIssues: [],
    });

    expect(posture.summary.family).toBe("retry-backoff");
    expect(posture.summary.issueCount).toBe(1);
    expect(posture.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "retry-backoff",
          issueNumber: 167,
          source: "retry-queue",
        }),
        expect.objectContaining({
          family: "waiting-expected",
          issueNumber: 166,
          source: "active-issue",
        }),
      ]),
    );
  });
});
