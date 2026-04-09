import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectFactoryControl,
  startFactory,
  stopFactory,
  type FactoryControlStatusSnapshot,
} from "../../src/cli/factory-control.js";
import { createSeedRemote, createTempDir } from "../support/git.js";
import { removeTempRoot } from "../support/fs.js";
import { MockGitHubServer } from "../support/mock-github-server.js";
import {
  createTuiUseHarness,
  sanitizeTuiUseEnv,
  type TuiUseHarness,
} from "../support/tui-use.js";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const tsxBinPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const symphonyCliPath = path.join(repoRoot, "bin", "symphony.ts");
const fixturePath = path.join(repoRoot, "tests", "fixtures");
const liveSmokeTest = process.platform === "win32" ? it.skip : it;
const debugLiveSmoke = process.env["SYMPHONY_TUI_SMOKE_DEBUG"] === "1";

async function writeSmokeWorkflow(options: {
  readonly rootDir: string;
  readonly remotePath: string;
  readonly apiUrl: string;
  readonly agentCommand: string;
}): Promise<string> {
  const workflowPath = path.join(options.rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: ${options.apiUrl}
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: Symphony completed this issue successfully.
  review_bot_logins: []
polling:
  interval_ms: 5
  max_concurrent_runs: 1
  retry:
    max_attempts: 1
    backoff_ms: 0
workspace:
  root: ./.tmp/workspaces
  repo_url: ${options.remotePath}
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  runner:
    kind: generic-command
  command: ${options.agentCommand}
  prompt_transport: stdin
  timeout_ms: 30000
  max_turns: 3
  env: {}
observability:
  dashboard_enabled: true
  refresh_ms: 200
  render_interval_ms: 50
---
You are working on issue {{ issue.identifier }}: {{ issue.title }}.
Issue summary: {{ issue.summary }}
`,
    "utf8",
  );
  return workflowPath;
}

async function assertCommandAvailable(command: string): Promise<void> {
  await execFile("which", [command], { cwd: repoRoot }).catch(() => {
    throw new Error(
      `Live TUI smoke tests require '${command}' to be installed on the host.`,
    );
  });
}

function createFactoryCommand(args: readonly string[]): string {
  return renderShellCommand([tsxBinPath, symphonyCliPath, ...args]);
}

function renderShellCommand(args: readonly string[]): string {
  return args.map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(" ");
}

function hasLiveRunnerTelemetry(screen: string): boolean {
  return (
    screen.includes("turn 1/3") ||
    screen.includes("generic-command") ||
    screen.includes("Runner:")
  );
}

function hasAttachTuiSurface(screen: string): boolean {
  return (
    screen.includes("Factory tokens:") &&
    screen.includes("Dispatch:") &&
    screen.includes("Recovery posture") &&
    screen.includes("Tickets") &&
    screen.includes("Backoff queue") &&
    hasLiveRunnerTelemetry(screen)
  );
}

function traceLiveSmoke(label: string): void {
  if (!debugLiveSmoke) {
    return;
  }
  process.stderr.write(`[live-tui-smoke] ${label}\n`);
}

async function waitForFactorySnapshot(
  workflowPath: string,
  predicate: (snapshot: FactoryControlStatusSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<FactoryControlStatusSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: FactoryControlStatusSnapshot | null = null;

  for (;;) {
    const snapshot = await inspectFactoryControl({ workflowPath });
    lastSnapshot = snapshot;
    if (predicate(snapshot)) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for detached factory state.\n\nLast snapshot:\n${JSON.stringify(
      lastSnapshot,
      null,
      2,
    )}`,
  );
}

describe("live TUI smoke tests", () => {
  let server: MockGitHubServer | null = null;
  let instanceRoot: string | null = null;
  let remoteRoot: string | null = null;
  let workflowPath: string | null = null;
  let tui: TuiUseHarness | null = null;

  afterEach(async () => {
    await tui?.cleanup().catch(() => undefined);
    tui = null;

    if (workflowPath !== null) {
      await stopFactory({ workflowPath }).catch(() => undefined);
    }
    workflowPath = null;

    if (server !== null) {
      await server.stop().catch(() => undefined);
    }
    server = null;

    if (instanceRoot !== null) {
      await removeTempRoot(instanceRoot);
    }
    instanceRoot = null;

    if (remoteRoot !== null) {
      await removeTempRoot(remoteRoot);
    }
    remoteRoot = null;
  });

  liveSmokeTest(
    "drives detached factory watch and attach through tui-use",
    async () => {
      await assertCommandAvailable("screen");
      await assertCommandAvailable("script");
      if (process.platform === "darwin") {
        await assertCommandAvailable("cc");
      }

      instanceRoot = await createTempDir("symphony-live-tui-");
      traceLiveSmoke(`instance root ${instanceRoot}`);
      const remote = await createSeedRemote();
      remoteRoot = remote.rootDir;
      server = new MockGitHubServer();
      await server.start();
      server.seedIssue({
        number: 1,
        title: "Live TUI smoke issue",
        body: "Exercise detached watch and attach through a real PTY harness.",
        labels: ["symphony:ready"],
      });

      const factoryEnv = sanitizeTuiUseEnv({
        ...process.env,
        GH_TOKEN: "test-token",
        MOCK_GITHUB_API_URL: server.baseUrl,
        PATH: `${fixturePath}:${process.env.PATH ?? ""}`,
      });
      delete factoryEnv["SYMPHONY_REPO"];
      expect(factoryEnv["NODE_OPTIONS"]).toBeUndefined();
      expect(
        Object.keys(factoryEnv).some(
          (key) => key.startsWith("VITEST") || key.startsWith("__VITEST"),
        ),
      ).toBe(false);

      workflowPath = await writeSmokeWorkflow({
        rootDir: instanceRoot,
        remotePath: remote.remotePath,
        apiUrl: server.baseUrl,
        agentCommand: path.join(fixturePath, "fake-agent-codex-events.sh"),
      });
      traceLiveSmoke(`workflow path ${workflowPath}`);

      const startResult = await startFactory({
        workflowPath,
        environment: () => factoryEnv,
      });
      expect(startResult.status.controlState).toBe("running");
      traceLiveSmoke("factory started");

      const activeIssueSnapshot = await waitForFactorySnapshot(
        workflowPath,
        (snapshot) =>
          snapshot.controlState === "running" &&
          snapshot.statusSnapshot?.activeIssues.some(
            (issue) => issue.issueNumber === 1,
          ) === true,
      );
      traceLiveSmoke("active issue visible");
      expect(activeIssueSnapshot.sessions).toHaveLength(1);
      const detachedSessionId = activeIssueSnapshot.sessions[0]?.id;
      expect(detachedSessionId).toBeDefined();

      tui = await createTuiUseHarness({
        cwd: repoRoot,
        homeDir: path.join(instanceRoot, ".tmp", "tui-use-home"),
        env: factoryEnv,
      });

      await tui.start(
        createFactoryCommand(["factory", "watch", "--workflow", workflowPath]),
        {
          label: "factory-watch",
          rows: 80,
        },
      );
      traceLiveSmoke("watch started");
      const watchSnapshot = await tui.waitForSnapshot(
        (snapshot) =>
          snapshot.screen.includes("Factory: running") &&
          snapshot.screen.includes("Active issues:") &&
          snapshot.screen.includes("Live TUI smoke issue"),
        {
          timeoutMs: 10_000,
          description: "watch surface with live issue status",
        },
      );
      expect(watchSnapshot.is_fullscreen).toBe(false);
      expect(watchSnapshot.screen).toContain("Factory: running");
      expect(watchSnapshot.screen).toContain("Live TUI smoke issue");
      traceLiveSmoke("watch snapshot ready");
      await tui.kill();
      traceLiveSmoke("watch killed");

      await tui.start(
        createFactoryCommand(["factory", "attach", "--workflow", workflowPath]),
        {
          label: "factory-attach",
          rows: 80,
        },
      );
      traceLiveSmoke("attach started");
      const attachSnapshot = await tui.waitForSnapshot(
        (snapshot) =>
          snapshot.screen.includes("#1") &&
          hasAttachTuiSurface(snapshot.screen),
        {
          timeoutMs: 10_000,
          description: "attach surface with live runner telemetry",
        },
      );
      expect(hasAttachTuiSurface(attachSnapshot.screen)).toBe(true);
      expect(attachSnapshot.screen).toContain("#1");
      expect(hasLiveRunnerTelemetry(attachSnapshot.screen)).toBe(true);
      traceLiveSmoke("attach snapshot ready");

      await tui.press("ctrl+c");
      traceLiveSmoke("attach detach sent");
      const detachedSnapshot = await tui.waitForSnapshot(
        (snapshot) => snapshot.status === "exited",
        {
          timeoutMs: 10_000,
          description: "attach client exit after local detach",
        },
      );
      expect(detachedSnapshot.status).toBe("exited");
      traceLiveSmoke("attach exited");

      const postDetach = await waitForFactorySnapshot(
        workflowPath,
        (snapshot) =>
          snapshot.controlState === "running" &&
          snapshot.workerAlive &&
          snapshot.sessions.length === 1 &&
          snapshot.sessions[0]?.id === detachedSessionId,
      );
      expect(postDetach.controlState).toBe("running");
      expect(postDetach.workerAlive).toBe(true);
      expect(postDetach.sessions).toHaveLength(1);
      expect(postDetach.sessions[0]?.id).toBe(detachedSessionId);
      traceLiveSmoke("post-detach runtime verified");
    },
    90_000,
  );
});
