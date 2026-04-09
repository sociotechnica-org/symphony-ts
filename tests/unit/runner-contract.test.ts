import { describe, expect, it } from "vitest";
import type { RunSession, RunTurn } from "../../src/domain/run.js";
import { createConfiguredWorkspaceSource } from "../../src/domain/workspace.js";
import type {
  LiveRunnerSession,
  Runner,
  RunnerEvent,
  RunnerExecutionResult,
  RunnerRunOptions,
  RunnerTurnResult,
  RunnerVisibilitySnapshot,
} from "../../src/runner/service.js";
import {
  createRunnerTransportMetadata,
  summarizeRunnerText,
} from "../../src/runner/service.js";

function createSession(): RunSession {
  return {
    id: "sociotechnica-org/symphony-ts#89/attempt-1",
    issue: {
      id: "89",
      identifier: "sociotechnica-org/symphony-ts#89",
      number: 89,
      title: "Provider-neutral runner contract",
      description: "",
      labels: [],
      state: "open",
      url: "https://example.test/issues/89",
      createdAt: "2026-03-12T10:00:00.000Z",
      updatedAt: "2026-03-12T10:00:00.000Z",
      queuePriority: null,
      blockedBy: [],
    },
    workspace: {
      key: "sociotechnica-org_symphony-ts_89",
      branchName: "symphony/89",
      createdNow: false,
      source: createConfiguredWorkspaceSource("/tmp/repo.git"),
      target: {
        kind: "local",
        path: "/tmp/symphony-89",
      },
    },
    prompt: "Initial prompt",
    startedAt: "2026-03-12T10:00:00.000Z",
    attempt: {
      sequence: 1,
    },
  };
}

function createLocalProcessTransport(pid: number | null) {
  return createRunnerTransportMetadata("local-process", {
    localProcessPid: pid,
    canTerminateLocalProcess: true,
  });
}

function createRemoteTaskTransport(taskId: string) {
  return createRunnerTransportMetadata("remote-task", {
    remoteTaskId: taskId,
  });
}

class FakeProviderLiveSession implements LiveRunnerSession {
  #latestTurnNumber: number | null = null;

  describe() {
    return {
      provider: "fake-provider",
      model: "fake-model",
      transport: createRemoteTaskTransport("remote-task-77"),
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: this.#latestTurnNumber,
      logPointers: [
        {
          name: "stdout",
          location: "/tmp/fake-provider.stdout.log",
          archiveLocation: null,
        },
      ],
    } as const;
  }

  async runTurn(
    turn: RunTurn,
    options?: RunnerRunOptions,
  ): Promise<RunnerTurnResult> {
    this.#latestTurnNumber = turn.turnNumber;
    await options?.onEvent?.({
      kind: "spawned",
      transport: createRemoteTaskTransport("remote-task-77"),
      spawnedAt: "2026-03-12T10:00:00.000Z",
    });
    return {
      exitCode: 0,
      stdout: `completed turn ${turn.turnNumber.toString()}`,
      stderr: "",
      startedAt: "2026-03-12T10:00:00.000Z",
      finishedAt: "2026-03-12T10:00:01.000Z",
      session: this.describe(),
    };
  }

  async close(): Promise<void> {}
}

class FakeProviderRunner implements Runner {
  describeSession(_session: RunSession) {
    return {
      provider: "fake-provider",
      model: "fake-model",
      transport: createLocalProcessTransport(null),
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: null,
      logPointers: [],
    } as const;
  }

  async run(
    session: RunSession,
    options?: RunnerRunOptions,
  ): Promise<RunnerExecutionResult> {
    await options?.onEvent?.({
      kind: "spawned",
      transport: createLocalProcessTransport(4242),
      spawnedAt: session.startedAt,
    });
    return {
      exitCode: 0,
      stdout: "completed",
      stderr: "",
      startedAt: session.startedAt,
      finishedAt: "2026-03-12T10:00:01.000Z",
    };
  }

  async startSession(_session: RunSession): Promise<LiveRunnerSession> {
    return new FakeProviderLiveSession();
  }
}

describe("runner contract", () => {
  it("accepts a provider without reusable backend session ids", async () => {
    const runner = new FakeProviderRunner();
    const session = createSession();
    const events: RunnerEvent[] = [];

    const result = await runner.run(session, {
      onEvent(event) {
        events.push(event);
      },
    });

    expect(runner.describeSession(session)).toEqual({
      provider: "fake-provider",
      model: "fake-model",
      transport: createLocalProcessTransport(null),
      backendSessionId: null,
      backendThreadId: null,
      latestTurnId: null,
      latestTurnNumber: null,
      logPointers: [],
    });
    expect(events).toEqual([
      {
        kind: "spawned",
        transport: createLocalProcessTransport(4242),
        spawnedAt: "2026-03-12T10:00:00.000Z",
      },
    ]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "completed",
      stderr: "",
      startedAt: "2026-03-12T10:00:00.000Z",
      finishedAt: "2026-03-12T10:00:01.000Z",
    });
  });

  it("supports live sessions without Codex-specific resume state", async () => {
    const runner = new FakeProviderRunner();
    const startSession = runner.startSession;
    const events: RunnerEvent[] = [];
    expect(startSession).toBeDefined();
    const liveSession = await startSession!(createSession());
    const result = await liveSession.runTurn(
      {
        prompt: "Continuation prompt",
        turnNumber: 2,
      },
      {
        onEvent(event) {
          events.push(event);
        },
      },
    );

    expect(events).toEqual([
      {
        kind: "spawned",
        transport: createRemoteTaskTransport("remote-task-77"),
        spawnedAt: "2026-03-12T10:00:00.000Z",
      },
    ]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "completed turn 2",
      stderr: "",
      startedAt: "2026-03-12T10:00:00.000Z",
      finishedAt: "2026-03-12T10:00:01.000Z",
      session: {
        provider: "fake-provider",
        model: "fake-model",
        transport: createRemoteTaskTransport("remote-task-77"),
        backendSessionId: null,
        backendThreadId: null,
        latestTurnId: null,
        latestTurnNumber: 2,
        logPointers: [
          {
            name: "stdout",
            location: "/tmp/fake-provider.stdout.log",
            archiveLocation: null,
          },
        ],
      },
    });
  });

  it("keeps the visibility shape provider-neutral", () => {
    const visibility: RunnerVisibilitySnapshot = {
      state: "waiting",
      phase: "awaiting-external",
      session: {
        provider: "fake-provider",
        model: null,
        transport: createRemoteTaskTransport("remote-task-19"),
        backendSessionId: null,
        backendThreadId: null,
        latestTurnId: null,
        latestTurnNumber: 2,
        logPointers: [],
      },
      lastHeartbeatAt: "2026-03-12T10:00:02.000Z",
      lastActionAt: "2026-03-12T10:00:02.000Z",
      lastActionSummary: "Waiting for external review",
      waitingReason: "Waiting for external review",
      stdoutSummary: "completed turn 2",
      stderrSummary: null,
      errorSummary: null,
      cancelledAt: null,
      timedOutAt: null,
    };

    expect(visibility).toEqual({
      state: "waiting",
      phase: "awaiting-external",
      session: {
        provider: "fake-provider",
        model: null,
        transport: createRemoteTaskTransport("remote-task-19"),
        backendSessionId: null,
        backendThreadId: null,
        latestTurnId: null,
        latestTurnNumber: 2,
        logPointers: [],
      },
      lastHeartbeatAt: "2026-03-12T10:00:02.000Z",
      lastActionAt: "2026-03-12T10:00:02.000Z",
      lastActionSummary: "Waiting for external review",
      waitingReason: "Waiting for external review",
      stdoutSummary: "completed turn 2",
      stderrSummary: null,
      errorSummary: null,
      cancelledAt: null,
      timedOutAt: null,
    });
  });

  it("keeps summarized runner text within the shared limit", () => {
    const summary = summarizeRunnerText("x".repeat(200));

    expect(summary).toBe(`${"x".repeat(157)}...`);
    expect(summary).toHaveLength(160);
  });
});
