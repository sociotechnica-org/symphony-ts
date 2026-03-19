import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { createConfiguredWorkspaceSource } from "../../src/domain/workspace.js";
import type { AgentConfig } from "../../src/domain/workflow.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { createRunnerTransportMetadata } from "../../src/runner/service.js";
import { createFakeCodexExecutable } from "../support/fake-codex.js";
import { createFakeSshExecutable } from "../support/fake-ssh.js";
import { createTempDir } from "../support/git.js";

function createSession(remotePath: string): RunSession {
  return {
    id: "sociotechnica-org/symphony-ts#187/attempt-1",
    issue: {
      id: "187",
      identifier: "sociotechnica-org/symphony-ts#187",
      number: 187,
      title: "Remote Codex over SSH",
      description: "",
      labels: [],
      state: "open",
      url: "https://example.test/issues/187",
      createdAt: "2026-03-19T12:00:00.000Z",
      updatedAt: "2026-03-19T12:00:00.000Z",
      queuePriority: null,
    },
    workspace: {
      key: "sociotechnica-org_symphony-ts_187",
      branchName: "symphony/187",
      createdNow: false,
      source: createConfiguredWorkspaceSource("git@example.test:repo.git"),
      target: {
        kind: "remote",
        host: "builder",
        workspaceId: "builder:sociotechnica-org_symphony-ts_187",
        pathHint: remotePath,
      },
    },
    prompt: "Implement the remote transport",
    startedAt: "2026-03-19T12:00:00.000Z",
    attempt: {
      sequence: 1,
    },
  };
}

function createConfig(
  command: string,
  env: Readonly<Record<string, string>> = {},
): AgentConfig {
  return {
    runner: {
      kind: "codex",
      remoteExecution: {
        kind: "ssh",
        workerHostNames: ["builder"],
        workerHosts: [
          {
            name: "builder",
            sshDestination: "builder@example.test",
            sshExecutable: "/tmp/fake-ssh",
            sshOptions: [],
            workspaceRoot: "/tmp/remote-workspaces",
          },
        ],
      },
    },
    command,
    promptTransport: "stdin",
    timeoutMs: 5_000,
    maxTurns: 2,
    env,
  };
}

describe("CodexRunner remote SSH transport", () => {
  it("starts Codex app-server over SSH stdio and reports remote transport metadata", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const fakeSsh = await createFakeSshExecutable();
    const remoteDir = await createTempDir("codex-remote-workspace-");
    const session = createSession(remoteDir);
    const runner = new CodexRunner(
      createConfig(
        `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -`,
      ),
      new JsonLogger(),
      null,
      {
        builder: {
          name: "builder",
          sshDestination: "builder@example.test",
          sshExecutable: fakeSsh,
          sshOptions: [],
          workspaceRoot: "/tmp/remote-workspaces",
        },
      },
    );

    const liveSession = await runner.startSession(session);
    let spawnedPid = -1;

    try {
      const turn = await liveSession.runTurn(
        {
          turnNumber: 1,
          prompt: "first",
        },
        {
          onEvent(event) {
            if (event.kind === "spawned") {
              spawnedPid = event.transport.localProcess?.pid ?? -1;
            }
          },
          onUpdate() {},
        },
      );

      expect(spawnedPid).toBeGreaterThan(0);
      expect(turn.session.transport).toEqual(
        createRunnerTransportMetadata("remote-stdio-session", {
          localProcessPid: spawnedPid,
          canTerminateLocalProcess: true,
          remoteSessionId:
            "builder:sociotechnica-org/symphony-ts#187/attempt-1",
        }),
      );
      expect(turn.session.backendThreadId).toBe("thread-1");
      expect(turn.session.latestTurnId).toBe("turn-1");
      expect(turn.session.backendSessionId).toBe("thread-1-turn-1");
    } finally {
      await liveSession.close();
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("quotes full remote env entries so keys with spaces survive the SSH shell", async () => {
    const fakeCodex = await createFakeCodexExecutable();
    const fakeSsh = await createFakeSshExecutable();
    const remoteDir = await createTempDir("codex-remote-env-workspace-");
    const session = createSession(remoteDir);
    const runner = new CodexRunner(
      createConfig(
        `${fakeCodex} exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -`,
        {
          "MY VAR": "hello remote env",
          FAKE_CODEX_AGENT_COMMAND:
            'node -e \'if (process.env["MY VAR"] !== "hello remote env") { console.error("missing spaced env key"); process.exit(1); }\'',
        },
      ),
      new JsonLogger(),
      null,
      {
        builder: {
          name: "builder",
          sshDestination: "builder@example.test",
          sshExecutable: fakeSsh,
          sshOptions: [],
          workspaceRoot: "/tmp/remote-workspaces",
        },
      },
    );

    const liveSession = await runner.startSession(session);

    try {
      const turn = await liveSession.runTurn(
        {
          turnNumber: 1,
          prompt: "first",
        },
        {
          onUpdate() {},
        },
      );

      expect(turn.exitCode).toBe(0);
      expect(turn.stderr).toBe("");
    } finally {
      await liveSession.close();
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });
});
