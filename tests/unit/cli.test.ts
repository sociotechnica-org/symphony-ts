import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runCli } from "../../src/cli/index.js";
import type { FactoryStatusSnapshot } from "../../src/observability/status.js";
import { createTempDir } from "../support/git.js";

function createWorkflow(rootDir: string): string {
  return path.join(rootDir, "WORKFLOW.md");
}

async function writeWorkflow(rootDir: string): Promise<string> {
  const workflowPath = createWorkflow(rootDir);
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
---
Prompt body
`,
    "utf8",
  );
  return workflowPath;
}

async function writeLinearWorkflowWithoutToken(
  rootDir: string,
): Promise<string> {
  const workflowPath = createWorkflow(rootDir);
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: symphony-linear
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
---
Prompt body
`,
    "utf8",
  );
  return workflowPath;
}

function createSnapshot(): FactoryStatusSnapshot {
  return {
    version: 1,
    generatedAt: "2026-03-06T12:00:00.000Z",
    factoryState: "idle",
    worker: {
      instanceId: "worker-1",
      pid: process.pid,
      startedAt: "2026-03-06T11:59:00.000Z",
      pollIntervalMs: 1000,
      maxConcurrentRuns: 1,
    },
    counts: {
      ready: 0,
      running: 0,
      failed: 0,
      activeLocalRuns: 0,
      retries: 0,
    },
    lastAction: null,
    activeIssues: [],
    retries: [],
  };
}

function createFactoryControlSnapshot(
  controlState: "running" | "stopped" | "degraded",
) {
  return {
    controlState,
    paths: {
      repoRoot: "/repo",
      runtimeRoot: "/repo/.tmp/factory-main",
      workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
      statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
    },
    sessionName: "symphony-factory",
    sessions: [],
    workerAlive: false,
    snapshotFreshness: {
      freshness: "unavailable" as const,
      reason: "missing-snapshot" as const,
      summary: "No runtime snapshot is available.",
      workerAlive: null,
      publicationState: null,
    },
    statusSnapshot: null,
    processIds: controlState === "degraded" ? [1234] : [],
    problems: controlState === "degraded" ? ["broken runtime"] : [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("parseArgs", () => {
  it("parses the run command", () => {
    const args = parseArgs(["node", "symphony", "run", "--once"]);
    expect(args.command).toBe("run");
    if (args.command !== "run") {
      throw new Error("expected run command");
    }
    expect(args.once).toBe(true);
  });

  it("fails when the run command is missing", () => {
    expect(() => parseArgs(["node", "symphony"])).toThrowError(
      "Usage: symphony <run|status|factory> [--once] [--json] [--workflow <path>] [--status-file <path>]",
    );
  });

  it("parses the status command", () => {
    const args = parseArgs(["node", "symphony", "status", "--json"]);
    expect(args).toMatchObject({
      command: "status",
      format: "json",
    });
  });

  it("fails when a value flag is missing its argument", () => {
    expect(() =>
      parseArgs(["node", "symphony", "status", "--status-file", "--json"]),
    ).toThrowError("Missing value for --status-file");
    expect(() =>
      parseArgs(["node", "symphony", "run", "--workflow"]),
    ).toThrowError("Missing value for --workflow");
  });

  it("shows usage for unknown commands before parsing workflow options", () => {
    expect(() =>
      parseArgs(["node", "symphony", "deploy", "--workflow"]),
    ).toThrowError(
      "Usage: symphony <run|status|factory> [--once] [--json] [--workflow <path>] [--status-file <path>]",
    );
  });

  it("parses the factory status command", () => {
    const args = parseArgs(["node", "symphony", "factory", "status", "--json"]);
    expect(args).toEqual({
      command: "factory",
      action: "status",
      format: "json",
    });
  });

  it("parses the factory restart command", () => {
    const args = parseArgs(["node", "symphony", "factory", "restart"]);
    expect(args).toEqual({
      command: "factory",
      action: "restart",
      format: "human",
    });
  });

  it("parses the factory watch command", () => {
    const args = parseArgs(["node", "symphony", "factory", "watch"]);
    expect(args).toEqual({
      command: "factory",
      action: "watch",
      format: "human",
    });
  });

  it("parses the factory start and stop commands", () => {
    expect(parseArgs(["node", "symphony", "factory", "start"])).toEqual({
      command: "factory",
      action: "start",
      format: "human",
    });
    expect(parseArgs(["node", "symphony", "factory", "stop"])).toEqual({
      command: "factory",
      action: "stop",
      format: "human",
    });
  });

  it("parses --json for factory start, stop, and restart", () => {
    expect(
      parseArgs(["node", "symphony", "factory", "start", "--json"]),
    ).toEqual({
      command: "factory",
      action: "start",
      format: "json",
    });
    expect(
      parseArgs(["node", "symphony", "factory", "stop", "--json"]),
    ).toEqual({
      command: "factory",
      action: "stop",
      format: "json",
    });
    expect(
      parseArgs(["node", "symphony", "factory", "restart", "--json"]),
    ).toEqual({
      command: "factory",
      action: "restart",
      format: "json",
    });
  });

  it("shows factory-specific usage for missing or unknown factory actions", () => {
    expect(() => parseArgs(["node", "symphony", "factory"])).toThrowError(
      "Usage: symphony factory <start|stop|restart|status> [--json]\n       symphony factory watch",
    );
    expect(() =>
      parseArgs(["node", "symphony", "factory", "deploy"]),
    ).toThrowError(
      "Usage: symphony factory <start|stop|restart|status> [--json]\n       symphony factory watch",
    );
  });

  it("rejects --json for factory watch", () => {
    expect(() =>
      parseArgs(["node", "symphony", "factory", "watch", "--json"]),
    ).toThrowError("Usage: symphony factory watch");
  });
});

describe("runCli status", () => {
  it("renders the human-readable status view from the workflow-derived snapshot path", async () => {
    const tempDir = await createTempDir("symphony-cli-status-");
    const workflowPath = await writeWorkflow(tempDir);
    const statusPath = path.join(tempDir, ".tmp", "status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(
      statusPath,
      `${JSON.stringify(createSnapshot(), null, 2)}\n`,
      "utf8",
    );

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    try {
      await runCli(["node", "symphony", "status", "--workflow", workflowPath]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(chunks.join("")).toContain("Factory: idle");
    expect(chunks.join("")).toContain(`Snapshot file: ${statusPath}`);
  });

  it("renders JSON when requested", async () => {
    const tempDir = await createTempDir("symphony-cli-status-json-");
    const workflowPath = await writeWorkflow(tempDir);
    const statusPath = path.join(tempDir, ".tmp", "status.json");
    const rawSnapshot = `{
  "version": 1,
  "generatedAt": "2026-03-06T12:00:00.000Z",
  "factoryState": "idle",
  "worker": {
    "instanceId": "worker-1",
    "pid": ${process.pid},
    "startedAt": "2026-03-06T11:59:00.000Z",
    "pollIntervalMs": 1000,
    "maxConcurrentRuns": 1
  },
  "counts": {
    "ready": 0,
    "running": 0,
    "failed": 0,
    "activeLocalRuns": 0,
    "retries": 0
  },
  "lastAction": null,
  "activeIssues": [],
  "retries": []
}
`;
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, rawSnapshot, "utf8");

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    try {
      await runCli([
        "node",
        "symphony",
        "status",
        "--json",
        "--workflow",
        workflowPath,
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(chunks.join("")).toBe(rawSnapshot);
  });

  it("derives the status snapshot path without requiring a linear API key", async () => {
    const tempDir = await createTempDir("symphony-cli-status-linear-");
    const previousApiKey = process.env.LINEAR_API_KEY;
    const statusPath = path.join(tempDir, ".tmp", "status.json");

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    try {
      delete process.env.LINEAR_API_KEY;
      const workflowPath = await writeLinearWorkflowWithoutToken(tempDir);
      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(
        statusPath,
        `${JSON.stringify(createSnapshot(), null, 2)}\n`,
        "utf8",
      );

      await runCli(["node", "symphony", "status", "--workflow", workflowPath]);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = previousApiKey;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(chunks.join("")).toContain("Factory: idle");
  });

  it("fails with a clear message when the snapshot is missing", async () => {
    const tempDir = await createTempDir("symphony-cli-status-missing-");
    const workflowPath = await writeWorkflow(tempDir);

    try {
      await expect(
        runCli(["node", "symphony", "status", "--workflow", workflowPath]),
      ).rejects.toThrowError(
        `No factory status snapshot found at ${path.join(tempDir, ".tmp", "status.json")}. Start Symphony with 'symphony run' first.`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with guidance when the snapshot file is invalid", async () => {
    const tempDir = await createTempDir("symphony-cli-status-invalid-");
    const workflowPath = await writeWorkflow(tempDir);
    const statusPath = path.join(tempDir, ".tmp", "status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, "{ invalid json\n", "utf8");

    try {
      await expect(
        runCli(["node", "symphony", "status", "--workflow", workflowPath]),
      ).rejects.toThrowError(
        `Failed to read factory status snapshot at ${statusPath}. The file may be corrupt; re-running 'symphony run' will regenerate it.`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with guidance when the workflow cannot determine the status path", async () => {
    const tempDir = await createTempDir(
      "symphony-cli-status-workflow-missing-",
    );
    const workflowPath = path.join(tempDir, "WORKFLOW.md");

    try {
      await expect(
        runCli(["node", "symphony", "status", "--workflow", workflowPath]),
      ).rejects.toThrowError(
        `Could not determine status file path from workflow at ${workflowPath}. Use --status-file <path> to specify the snapshot location directly.`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores malformed --workflow when --status-file is provided", async () => {
    const tempDir = await createTempDir("symphony-cli-status-explicit-file-");
    const statusPath = path.join(tempDir, "status.json");
    await fs.writeFile(
      statusPath,
      `${JSON.stringify(createSnapshot(), null, 2)}\n`,
      "utf8",
    );

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    try {
      await runCli([
        "node",
        "symphony",
        "status",
        "--status-file",
        statusPath,
        "--workflow",
        "--json",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(chunks.join("")).toContain('"factoryState": "idle"');
  });
});

describe("runCli run", () => {
  it("wires FsLivenessProbe into the production orchestrator bootstrap", async () => {
    vi.resetModules();

    const runOnce = vi.fn(async () => {});
    const probeRoots: string[] = [];
    let orchestratorArgs: unknown[] | null = null;

    vi.doMock("../../src/config/workflow.js", () => ({
      loadWorkflow: vi.fn(async () => ({
        config: {
          tracker: { kind: "github-bootstrap" },
          polling: { watchdog: { enabled: true } },
          workspace: { root: "/tmp/factory-root" },
          hooks: { afterCreate: [] },
          agent: {},
        },
      })),
      loadWorkflowWorkspaceRoot: vi.fn(),
      createPromptBuilder: vi.fn(() => "prompt-builder"),
    }));
    vi.doMock("../../src/tracker/factory.js", () => ({
      createTracker: vi.fn(() => "tracker"),
    }));
    vi.doMock("../../src/runner/factory.js", () => ({
      createRunner: vi.fn(() => "runner"),
    }));
    vi.doMock("../../src/workspace/local.js", () => ({
      LocalWorkspaceManager: vi.fn(function MockWorkspaceManager() {}),
    }));
    vi.doMock("../../src/observability/logger.js", () => ({
      JsonLogger: vi.fn(function MockLogger() {}),
    }));
    vi.doMock("../../src/orchestrator/liveness-probe.js", () => ({
      FsLivenessProbe: vi.fn(function MockFsLivenessProbe(root: string) {
        probeRoots.push(root);
      }),
    }));
    vi.doMock("../../src/orchestrator/service.js", () => ({
      BootstrapOrchestrator: vi.fn(function MockBootstrapOrchestrator(
        ...args: unknown[]
      ) {
        orchestratorArgs = args;
        return {
          runOnce,
          runLoop: vi.fn(),
          setDashboardNotify: vi.fn(),
          snapshot: vi.fn(() => null),
        };
      }),
    }));
    vi.doMock("../../src/observability/tui.js", () => ({
      StatusDashboard: vi.fn(function MockStatusDashboard() {
        return { start: vi.fn(), stop: vi.fn(), refresh: vi.fn() };
      }),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli([
      "node",
      "symphony",
      "run",
      "--once",
      "--workflow",
      "/tmp/workflow.md",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ]);

    expect(probeRoots).toEqual(["/tmp/factory-root"]);
    expect(orchestratorArgs).not.toBeNull();
    expect(orchestratorArgs?.[7]).toBeDefined();
    expect(runOnce).toHaveBeenCalledOnce();
  });
});

describe("runCli factory", () => {
  it("renders a precise restart message when the factory is already running again", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      startFactory: vi.fn(async () => ({
        kind: "already-running",
        status: {
          controlState: "running",
          paths: {
            repoRoot: "/repo",
            runtimeRoot: "/repo/.tmp/factory-main",
            workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
            statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
          },
          sessionName: "symphony-factory",
          sessions: [],
          workerAlive: false,
          snapshotFreshness: {
            freshness: "unavailable",
            reason: "missing-snapshot",
            summary: "No runtime snapshot is available.",
            workerAlive: null,
            publicationState: null,
          },
          statusSnapshot: null,
          processIds: [],
          problems: [],
        },
      })),
      stopFactory: vi.fn(async () => ({
        kind: "already-stopped",
        status: {
          controlState: "stopped",
          paths: {
            repoRoot: "/repo",
            runtimeRoot: "/repo/.tmp/factory-main",
            workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
            statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
          },
          sessionName: "symphony-factory",
          sessions: [],
          workerAlive: false,
          snapshotFreshness: {
            freshness: "unavailable",
            reason: "missing-snapshot",
            summary: "No runtime snapshot is available.",
            workerAlive: null,
            publicationState: null,
          },
          statusSnapshot: null,
          processIds: [],
          problems: [],
        },
        terminatedPids: [],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await mockedRunCli(["node", "symphony", "factory", "restart"]);

    expect(stdout.join("")).toContain("Factory was already running.");
  });

  it("renders factory start status as JSON when requested", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn((_snapshot, options) =>
        options?.format === "json"
          ? '{\n  "controlState": "running"\n}\n'
          : "Factory control: running\n",
      ),
      startFactory: vi.fn(async () => ({
        kind: "started",
        status: {
          controlState: "running",
          paths: {
            repoRoot: "/repo",
            runtimeRoot: "/repo/.tmp/factory-main",
            workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
            statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
          },
          sessionName: "symphony-factory",
          sessions: [],
          workerAlive: false,
          snapshotFreshness: {
            freshness: "unavailable",
            reason: "missing-snapshot",
            summary: "No runtime snapshot is available.",
            workerAlive: null,
            publicationState: null,
          },
          statusSnapshot: null,
          processIds: [],
          problems: [],
        },
      })),
      stopFactory: vi.fn(),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await mockedRunCli(["node", "symphony", "factory", "start", "--json"]);

    expect(stdout.join("")).toContain('{\n  "controlState": "running"\n}\n');
  });

  it("renders factory status and exits zero for stopped control state", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(async () =>
        createFactoryControlSnapshot("stopped"),
      ),
      renderFactoryControlStatus: vi.fn(() => "Factory control: stopped\n"),
      startFactory: vi.fn(),
      stopFactory: vi.fn(),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    await mockedRunCli(["node", "symphony", "factory", "status"]);

    expect(stdout.join("")).toBe("Factory control: stopped\n");
    expect(process.exitCode).toBe(0);
  });

  it("sets a non-zero exit code for degraded factory status", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(async () =>
        createFactoryControlSnapshot("degraded"),
      ),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      startFactory: vi.fn(),
      stopFactory: vi.fn(),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "status", "--json"]);

    expect(process.exitCode).toBe(1);
  });

  it("sets a non-zero exit code for degraded factory start results", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      startFactory: vi.fn(async () => ({
        kind: "blocked-degraded",
        status: createFactoryControlSnapshot("degraded"),
      })),
      stopFactory: vi.fn(),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "start"]);

    expect(process.exitCode).toBe(1);
  });

  it("sets a non-zero exit code for degraded factory stop results", async () => {
    vi.resetModules();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      startFactory: vi.fn(),
      stopFactory: vi.fn(async () => ({
        kind: "stopped",
        status: createFactoryControlSnapshot("degraded"),
        terminatedPids: [1234],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "stop"]);

    expect(process.exitCode).toBe(1);
  });

  it("sets a non-zero exit code and skips restart launch after a degraded stop", async () => {
    vi.resetModules();
    const startFactory = vi.fn();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      startFactory,
      stopFactory: vi.fn(async () => ({
        kind: "stopped",
        status: createFactoryControlSnapshot("degraded"),
        terminatedPids: [1234],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "restart"]);

    expect(startFactory).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("dispatches the factory watch command", async () => {
    vi.resetModules();
    const watchFactory = vi.fn(async () => {});

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      renderFactoryControlStatus: vi.fn(),
      startFactory: vi.fn(),
      stopFactory: vi.fn(),
    }));
    vi.doMock("../../src/cli/factory-watch.js", () => ({
      watchFactory,
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "watch"]);

    expect(watchFactory).toHaveBeenCalledTimes(1);
  });
});
