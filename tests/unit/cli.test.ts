import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scaffoldWorkflow } from "../../src/cli/init.js";
import { parseArgs, runCli } from "../../src/cli/index.js";
import type { FactoryStatusSnapshot } from "../../src/observability/status.js";
import { loadWorkflow } from "../../src/config/workflow.js";
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

async function withEnvVarUnset<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousValue = process.env[name];
  delete process.env[name];
  try {
    return await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
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
      startupFilePath: "/repo/.tmp/factory-main/.tmp/startup.json",
    },
    sessionName: "symphony-factory",
    factoryHalt: {
      state: "clear" as const,
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    },
    sessions: [],
    workerAlive: false,
    startup: null,
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
      "Usage: symphony <init|run|status|factory> [--once] [--json] [--workflow <path>] [--status-file <path>]",
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
      "Usage: symphony <init|run|status|factory> [--once] [--json] [--workflow <path>] [--status-file <path>]",
    );
  });

  it("parses the init command", () => {
    const targetPath = path.resolve("/tmp/project");
    expect(
      parseArgs([
        "node",
        "symphony",
        "init",
        "/tmp/project",
        "--tracker-repo",
        "acme/widgets",
      ]),
    ).toEqual({
      command: "init",
      targetPath,
      trackerRepo: "acme/widgets",
      runnerKind: "codex",
      force: false,
    });
  });

  it("parses optional init runner and force flags", () => {
    const targetPath = path.resolve("/tmp/project/WORKFLOW.md");
    expect(
      parseArgs([
        "node",
        "symphony",
        "init",
        "/tmp/project/WORKFLOW.md",
        "--tracker-repo",
        "acme/widgets",
        "--runner",
        "claude-code",
        "--force",
      ]),
    ).toEqual({
      command: "init",
      targetPath,
      trackerRepo: "acme/widgets",
      runnerKind: "claude-code",
      force: true,
    });
  });

  it("requires a target path and tracker repo for init", () => {
    expect(() => parseArgs(["node", "symphony", "init"])).toThrowError(
      "Usage: symphony init <target-directory-or-workflow-path> --tracker-repo <owner/repo> [--runner <codex|claude-code|generic-command>] [--force]",
    );
    expect(() =>
      parseArgs(["node", "symphony", "init", "/tmp/project"]),
    ).toThrowError(
      "Usage: symphony init <target-directory-or-workflow-path> --tracker-repo <owner/repo> [--runner <codex|claude-code|generic-command>] [--force]\nMissing required --tracker-repo <owner/repo>.",
    );
  });

  it("rejects unsupported init runner values", () => {
    expect(() =>
      parseArgs([
        "node",
        "symphony",
        "init",
        "/tmp/project",
        "--tracker-repo",
        "acme/widgets",
        "--runner",
        "cursor",
      ]),
    ).toThrowError(
      'Usage: symphony init <target-directory-or-workflow-path> --tracker-repo <owner/repo> [--runner <codex|claude-code|generic-command>] [--force]\nUnsupported --runner "cursor". Supported values: codex, claude-code, generic-command.',
    );
  });

  it("parses the factory status command", () => {
    const args = parseArgs(["node", "symphony", "factory", "status", "--json"]);
    expect(args).toEqual({
      command: "factory",
      action: "status",
      format: "json",
      workflowPath: null,
    });
  });

  it("parses the factory restart command", () => {
    const args = parseArgs(["node", "symphony", "factory", "restart"]);
    expect(args).toEqual({
      command: "factory",
      action: "restart",
      format: "human",
      workflowPath: null,
    });
  });

  it("parses the factory watch command", () => {
    const args = parseArgs(["node", "symphony", "factory", "watch"]);
    expect(args).toEqual({
      command: "factory",
      action: "watch",
      format: "human",
      workflowPath: null,
    });
  });

  it("parses the factory attach command", () => {
    const args = parseArgs(["node", "symphony", "factory", "attach"]);
    expect(args).toEqual({
      command: "factory",
      action: "attach",
      format: "human",
      workflowPath: null,
    });
  });

  it("parses the factory start and stop commands", () => {
    expect(parseArgs(["node", "symphony", "factory", "start"])).toEqual({
      command: "factory",
      action: "start",
      format: "human",
      workflowPath: null,
    });
    expect(parseArgs(["node", "symphony", "factory", "stop"])).toEqual({
      command: "factory",
      action: "stop",
      format: "human",
      workflowPath: null,
    });
    expect(parseArgs(["node", "symphony", "factory", "resume"])).toEqual({
      command: "factory",
      action: "resume",
      format: "human",
      workflowPath: null,
    });
  });

  it("parses the factory pause command with a required reason", () => {
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "pause",
        "--reason",
        "Stop the line.",
      ]),
    ).toEqual({
      command: "factory",
      action: "pause",
      format: "human",
      workflowPath: null,
      reason: "Stop the line.",
    });
    expect(() =>
      parseArgs(["node", "symphony", "factory", "pause"]),
    ).toThrowError(
      "Usage: symphony factory pause --reason <text> [--json] [--workflow <path>]",
    );
  });

  it("parses --json for factory start, stop, restart, pause, and resume", () => {
    expect(
      parseArgs(["node", "symphony", "factory", "start", "--json"]),
    ).toEqual({
      command: "factory",
      action: "start",
      format: "json",
      workflowPath: null,
    });
    expect(
      parseArgs(["node", "symphony", "factory", "stop", "--json"]),
    ).toEqual({
      command: "factory",
      action: "stop",
      format: "json",
      workflowPath: null,
    });
    expect(
      parseArgs(["node", "symphony", "factory", "restart", "--json"]),
    ).toEqual({
      command: "factory",
      action: "restart",
      format: "json",
      workflowPath: null,
    });
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "pause",
        "--reason",
        "Stop the line.",
        "--json",
      ]),
    ).toEqual({
      command: "factory",
      action: "pause",
      format: "json",
      workflowPath: null,
      reason: "Stop the line.",
    });
    expect(
      parseArgs(["node", "symphony", "factory", "resume", "--json"]),
    ).toEqual({
      command: "factory",
      action: "resume",
      format: "json",
      workflowPath: null,
    });
  });

  it("parses --workflow for every factory action", () => {
    const workflowPath = path.resolve("/tmp/project/WORKFLOW.md");

    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "start",
        "--workflow",
        "/tmp/project/WORKFLOW.md",
      ]),
    ).toEqual({
      command: "factory",
      action: "start",
      format: "human",
      workflowPath,
    });
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "status",
        "--workflow",
        "/tmp/project/WORKFLOW.md",
      ]),
    ).toEqual({
      command: "factory",
      action: "status",
      format: "human",
      workflowPath,
    });
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "watch",
        "--workflow",
        "/tmp/project/WORKFLOW.md",
      ]),
    ).toEqual({
      command: "factory",
      action: "watch",
      format: "human",
      workflowPath,
    });
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "attach",
        "--workflow",
        "/tmp/project/WORKFLOW.md",
      ]),
    ).toEqual({
      command: "factory",
      action: "attach",
      format: "human",
      workflowPath,
    });
    expect(
      parseArgs([
        "node",
        "symphony",
        "factory",
        "pause",
        "--reason",
        "Stop the line.",
        "--workflow",
        "/tmp/project/WORKFLOW.md",
      ]),
    ).toEqual({
      command: "factory",
      action: "pause",
      format: "human",
      workflowPath,
      reason: "Stop the line.",
    });
  });

  it("shows factory-specific usage for missing or unknown factory actions", () => {
    expect(() => parseArgs(["node", "symphony", "factory"])).toThrowError(
      "Usage: symphony factory <start|stop|restart|resume|status> [--json] [--workflow <path>]\n       symphony factory pause --reason <text> [--json] [--workflow <path>]\n       symphony factory <watch|attach> [--workflow <path>]",
    );
    expect(() =>
      parseArgs(["node", "symphony", "factory", "deploy"]),
    ).toThrowError(
      "Usage: symphony factory <start|stop|restart|resume|status> [--json] [--workflow <path>]\n       symphony factory pause --reason <text> [--json] [--workflow <path>]\n       symphony factory <watch|attach> [--workflow <path>]",
    );
  });

  it("rejects --json for factory watch", () => {
    expect(() =>
      parseArgs(["node", "symphony", "factory", "watch", "--json"]),
    ).toThrowError("Usage: symphony factory watch [--workflow <path>]");
  });

  it("rejects --json for factory attach", () => {
    expect(() =>
      parseArgs(["node", "symphony", "factory", "attach", "--json"]),
    ).toThrowError("Usage: symphony factory attach [--workflow <path>]");
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

describe("runCli init", () => {
  it("scaffolds a starter workflow into a target repository and prints next steps", async () => {
    const tempDir = await createTempDir("symphony-cli-init-");
    const targetRepo = path.join(tempDir, "target-repo");
    await fs.mkdir(targetRepo, { recursive: true });

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
        "init",
        targetRepo,
        "--tracker-repo",
        "acme/widgets",
      ]);

      const workflowPath = path.join(targetRepo, "WORKFLOW.md");
      const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
      const workflowBody = await fs.readFile(workflowPath, "utf8");
      const operatorPlaybookBody = await fs.readFile(
        operatorPlaybookPath,
        "utf8",
      );
      const workflow = await withEnvVarUnset("SYMPHONY_REPO", () =>
        loadWorkflow(workflowPath),
      );

      expect(workflowBody).toContain("repo: acme/widgets");
      expect(workflowBody).toContain("kind: codex");
      expect(workflowBody).toContain(
        "Read `AGENTS.md`, `README.md`, and the relevant docs before making changes.",
      );
      expect(operatorPlaybookBody).toContain(
        "This file is the repository-owned operator policy companion to `WORKFLOW.md` and `AGENTS.md`.",
      );
      expect(operatorPlaybookBody).toContain(
        "when the operator should post `/land` by default and when landing stays manual",
      );
      expect(workflow.config.workflowPath).toBe(workflowPath);
      expect(workflow.config.instance.instanceRoot).toBe(targetRepo);
      expect(workflow.config.instance.runtimeRoot).toBe(
        path.join(targetRepo, ".tmp", "factory-main"),
      );

      const output = chunks.join("");
      expect(output).toContain(`Created ${workflowPath}`);
      expect(output).toContain(`Created ${operatorPlaybookPath}`);
      expect(output).toContain(
        `Review and customize ${operatorPlaybookPath} for this repository's operator policy.`,
      );
      expect(output).toContain(
        `pnpm tsx bin/symphony.ts factory start --workflow ${JSON.stringify(workflowPath)}`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing workflow without --force", async () => {
    const tempDir = await createTempDir("symphony-cli-init-existing-");
    const targetRepo = path.join(tempDir, "target-repo");
    await fs.mkdir(targetRepo, { recursive: true });
    const workflowPath = await writeWorkflow(targetRepo);

    try {
      await expect(
        runCli([
          "node",
          "symphony",
          "init",
          targetRepo,
          "--tracker-repo",
          "acme/widgets",
        ]),
      ).rejects.toThrowError(
        `Refusing to overwrite existing scaffold file at ${workflowPath}. Re-run with --force to replace both WORKFLOW.md and OPERATOR.md.`,
      );
      expect(await fs.readFile(workflowPath, "utf8")).toContain(
        "repo: sociotechnica-org/symphony-ts",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing operator playbook without --force", async () => {
    const tempDir = await createTempDir("symphony-cli-init-existing-operator-");
    const targetRepo = path.join(tempDir, "target-repo");
    const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
    await fs.mkdir(targetRepo, { recursive: true });
    await fs.writeFile(
      operatorPlaybookPath,
      "# Existing operator playbook\n",
      "utf8",
    );

    try {
      await expect(
        runCli([
          "node",
          "symphony",
          "init",
          targetRepo,
          "--tracker-repo",
          "acme/widgets",
        ]),
      ).rejects.toThrowError(
        `Refusing to overwrite existing scaffold file at ${operatorPlaybookPath}. Re-run with --force to replace both WORKFLOW.md and OPERATOR.md.`,
      );
      expect(await fs.readFile(operatorPlaybookPath, "utf8")).toContain(
        "# Existing operator playbook",
      );
      await expect(
        fs.access(path.join(targetRepo, "WORKFLOW.md")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing workflow when --force is set", async () => {
    const tempDir = await createTempDir("symphony-cli-init-force-");
    const targetRepo = path.join(tempDir, "target-repo");
    await fs.mkdir(targetRepo, { recursive: true });
    const workflowPath = await writeWorkflow(targetRepo);
    const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
    await fs.writeFile(
      operatorPlaybookPath,
      "# Old operator playbook\n",
      "utf8",
    );
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );

    try {
      await runCli([
        "node",
        "symphony",
        "init",
        workflowPath,
        "--tracker-repo",
        "acme/widgets",
        "--runner",
        "claude-code",
        "--force",
      ]);

      const workflowBody = await fs.readFile(workflowPath, "utf8");
      const operatorPlaybookBody = await fs.readFile(
        operatorPlaybookPath,
        "utf8",
      );
      expect(workflowBody).toContain("repo: acme/widgets");
      expect(workflowBody).toContain("kind: claude-code");
      expect(workflowBody).toContain(
        "command: claude -p --output-format json --permission-mode bypassPermissions --model sonnet",
      );
      expect(operatorPlaybookBody).toContain(
        "This file is the repository-owned operator policy companion to `WORKFLOW.md` and `AGENTS.md`.",
      );
      expect(operatorPlaybookBody).not.toContain("# Old operator playbook");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores the workflow and preserves the existing operator playbook when publishing fails", async () => {
    const tempDir = await createTempDir("symphony-cli-init-restore-");
    const targetRepo = path.join(tempDir, "target-repo");
    const workflowPath = path.join(targetRepo, "WORKFLOW.md");
    const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
    await fs.mkdir(targetRepo, { recursive: true });
    await fs.writeFile(workflowPath, "# Existing workflow\n", "utf8");
    await fs.writeFile(
      operatorPlaybookPath,
      "# Existing operator playbook\n",
      "utf8",
    );

    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === operatorPlaybookPath) {
        throw new Error("operator rename failed");
      }
      await originalRename(from, to);
    });

    try {
      await expect(
        scaffoldWorkflow({
          targetPath: targetRepo,
          trackerRepo: "acme/widgets",
          runnerKind: "codex",
          force: true,
        }),
      ).rejects.toThrow("operator rename failed");
      await expect(fs.readFile(workflowPath, "utf8")).resolves.toBe(
        "# Existing workflow\n",
      );
      await expect(fs.readFile(operatorPlaybookPath, "utf8")).resolves.toBe(
        "# Existing operator playbook\n",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the publish failure when rollback or cleanup also fail", async () => {
    const tempDir = await createTempDir("symphony-cli-init-cleanup-error-");
    const targetRepo = path.join(tempDir, "target-repo");
    const workflowPath = path.join(targetRepo, "WORKFLOW.md");
    const operatorPlaybookPath = path.join(targetRepo, "OPERATOR.md");
    const originalWriteFile: typeof fs.writeFile = fs.writeFile.bind(fs);
    const originalRename = fs.rename.bind(fs);
    const originalRm = fs.rm.bind(fs);
    await fs.mkdir(targetRepo, { recursive: true });
    await fs.writeFile(workflowPath, "# Existing workflow\n", "utf8");

    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (String(filePath) === workflowPath) {
        throw new Error("workflow restore failed");
      }
      return originalWriteFile(...args);
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === operatorPlaybookPath) {
        throw new Error("operator rename failed");
      }
      await originalRename(from, to);
    });
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (String(filePath).includes(".tmp-")) {
        throw new Error("temp cleanup failed");
      }
      return originalRm(...args);
    });

    try {
      await expect(
        scaffoldWorkflow({
          targetPath: targetRepo,
          trackerRepo: "acme/widgets",
          runnerKind: "codex",
          force: true,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AggregateError);
        const aggregateError = error as AggregateError;
        expect(aggregateError.message).toBe("operator rename failed");
        expect(
          aggregateError.errors.map((entry) =>
            entry instanceof Error ? entry.message : String(entry),
          ),
        ).toEqual(
          expect.arrayContaining([
            "operator rename failed",
            `Failed to restore ${workflowPath}: workflow restore failed`,
            "Failed to clean up scaffold temp files: temp cleanup failed",
          ]),
        );
        return true;
      });
      await expect(fs.readFile(operatorPlaybookPath, "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up temp files when the first scaffold temp write fails", async () => {
    const tempDir = await createTempDir("symphony-cli-init-temp-write-");
    const targetRepo = path.join(tempDir, "target-repo");
    const workflowPath = path.join(targetRepo, "WORKFLOW.md");
    const originalWriteFile: typeof fs.writeFile = fs.writeFile.bind(fs);
    await fs.mkdir(targetRepo, { recursive: true });

    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (
        typeof filePath === "string" &&
        filePath.startsWith(`${workflowPath}.tmp-`)
      ) {
        await originalWriteFile(...args);
        throw new Error("workflow temp write failed");
      }
      return originalWriteFile(...args);
    });

    try {
      await expect(
        scaffoldWorkflow({
          targetPath: targetRepo,
          trackerRepo: "acme/widgets",
          runnerKind: "codex",
          force: false,
        }),
      ).rejects.toThrow("workflow temp write failed");
      await expect(fs.access(workflowPath)).rejects.toThrow();
      expect(
        (await fs.readdir(targetRepo)).filter((entry) =>
          entry.includes(".tmp-"),
        ),
      ).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
    vi.doMock("../../src/startup/service.js", () => ({
      runStartupPreparation: vi.fn(async () => ({
        kind: "ready",
        provider: "github-bootstrap/noop",
        summary: null,
        workspaceSourceOverride: null,
        artifactPath: "/tmp/factory-root/.tmp/startup.json",
        runtimeIdentity: {
          checkoutPath: "/tmp/factory-root",
          headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
          committedAt: "2026-03-14T12:00:00.000Z",
          isDirty: false,
          source: "git",
          detail: null,
        },
      })),
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
    expect(orchestratorArgs?.[8]).toMatchObject({
      checkoutPath: "/tmp/factory-root",
      headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
    });
    expect(runOnce).toHaveBeenCalledOnce();
  });

  it("exits early with a clear message when startup preparation fails", async () => {
    vi.resetModules();

    const createTracker = vi.fn();
    const stderr: string[] = [];

    vi.doMock("../../src/config/workflow.js", () => ({
      loadWorkflow: vi.fn(async () => ({
        config: {
          tracker: { kind: "github-bootstrap" },
          polling: { watchdog: { enabled: false } },
          workspace: { root: "/tmp/factory-root" },
          hooks: { afterCreate: [] },
          agent: {},
        },
      })),
      loadWorkflowWorkspaceRoot: vi.fn(),
      createPromptBuilder: vi.fn(() => "prompt-builder"),
    }));
    vi.doMock("../../src/startup/service.js", () => ({
      runStartupPreparation: vi.fn(async () => ({
        kind: "failed",
        provider: "github-bootstrap/noop",
        summary: "Mirror refresh failed.",
        workspaceSourceOverride: null,
        artifactPath: "/tmp/factory-root/.tmp/startup.json",
        runtimeIdentity: {
          checkoutPath: "/tmp/factory-root",
          headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
          committedAt: "2026-03-14T12:00:00.000Z",
          isDirty: false,
          source: "git",
          detail: null,
        },
      })),
    }));
    vi.doMock("../../src/tracker/factory.js", () => ({
      createTracker,
    }));
    vi.doMock("../../src/runner/factory.js", () => ({
      createRunner: vi.fn(),
    }));
    vi.doMock("../../src/workspace/local.js", () => ({
      LocalWorkspaceManager: vi.fn(),
    }));
    vi.doMock("../../src/observability/logger.js", () => ({
      JsonLogger: vi.fn(function MockLogger() {}),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write);

    await mockedRunCli([
      "node",
      "symphony",
      "run",
      "--once",
      "--workflow",
      "/tmp/workflow.md",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ]);

    expect(stderr.join("")).toContain(
      "Startup failed before the runtime became healthy: Mirror refresh failed.",
    );
    expect(process.exitCode).toBe(1);
    expect(createTracker).not.toHaveBeenCalled();
  });

  it("forwards a startup abort signal and exits cleanly when startup preparation is interrupted", async () => {
    vi.resetModules();

    const createTracker = vi.fn();
    const stderr: string[] = [];
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    let startupSignal: AbortSignal | undefined;

    vi.doMock("../../src/config/workflow.js", () => ({
      loadWorkflow: vi.fn(async () => ({
        config: {
          tracker: { kind: "github-bootstrap" },
          polling: { watchdog: { enabled: false } },
          workspace: { root: "/tmp/factory-root" },
          hooks: { afterCreate: [] },
          agent: {},
        },
      })),
      loadWorkflowWorkspaceRoot: vi.fn(),
      createPromptBuilder: vi.fn(() => "prompt-builder"),
    }));
    vi.doMock("../../src/startup/service.js", () => ({
      runStartupPreparation: vi.fn(
        async (options: { readonly signal?: AbortSignal }) => {
          startupSignal = options.signal;
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("Startup preparation aborted.");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      ),
    }));
    vi.doMock("../../src/tracker/factory.js", () => ({
      createTracker,
    }));
    vi.doMock("../../src/runner/factory.js", () => ({
      createRunner: vi.fn(),
    }));
    vi.doMock("../../src/workspace/local.js", () => ({
      LocalWorkspaceManager: vi.fn(),
    }));
    vi.doMock("../../src/observability/logger.js", () => ({
      JsonLogger: vi.fn(function MockLogger() {}),
    }));

    const onSpy = vi.spyOn(process, "on").mockImplementation(((
      event: NodeJS.Signals,
      listener: () => void,
    ) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener);
      }
      return process;
    }) as typeof process.on);
    const offSpy = vi.spyOn(process, "off").mockImplementation(((
      event: NodeJS.Signals,
    ) => {
      signalHandlers.delete(event);
      return process;
    }) as typeof process.off);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write);

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");
    const runPromise = mockedRunCli([
      "node",
      "symphony",
      "run",
      "--once",
      "--workflow",
      "/tmp/workflow.md",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ]);

    await vi.waitFor(() => {
      expect(startupSignal).toBeDefined();
      expect(signalHandlers.has("SIGTERM")).toBe(true);
    });
    signalHandlers.get("SIGTERM")?.();
    await runPromise;

    expect(startupSignal?.aborted).toBe(true);
    expect(stderr.join("")).toContain("Startup preparation aborted.");
    expect(process.exitCode).toBe(130);
    expect(createTracker).not.toHaveBeenCalled();
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });
});

describe("runCli factory", () => {
  it("renders a precise restart message when the factory is already running again", async () => {
    vi.resetModules();
    const startFactory = vi.fn(async () => ({
      kind: "already-running",
      status: {
        controlState: "running",
        paths: {
          repoRoot: "/repo",
          runtimeRoot: "/repo/.tmp/factory-main",
          workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
          statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
          startupFilePath: "/repo/.tmp/factory-main/.tmp/startup.json",
        },
        sessionName: "symphony-factory",
        sessions: [],
        workerAlive: false,
        startup: null,
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
    }));
    const stopFactory = vi.fn(async () => ({
      kind: "already-stopped",
      status: {
        controlState: "stopped",
        paths: {
          repoRoot: "/repo",
          runtimeRoot: "/repo/.tmp/factory-main",
          workflowPath: "/repo/.tmp/factory-main/WORKFLOW.md",
          statusFilePath: "/repo/.tmp/factory-main/.tmp/status.json",
          startupFilePath: "/repo/.tmp/factory-main/.tmp/startup.json",
        },
        sessionName: "symphony-factory",
        sessions: [],
        workerAlive: false,
        startup: null,
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
    }));

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      resumeFactory: vi.fn(),
      startFactory,
      stopFactory,
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
    expect(stopFactory).toHaveBeenCalledWith({ workflowPath: null });
    expect(startFactory).toHaveBeenCalledWith({ workflowPath: null });
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
            startupFilePath: "/repo/.tmp/factory-main/.tmp/startup.json",
          },
          sessionName: "symphony-factory",
          factoryHalt: {
            state: "clear" as const,
            reason: null,
            haltedAt: null,
            source: null,
            actor: null,
            detail: null,
          },
          sessions: [],
          workerAlive: false,
          startup: null,
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
      pauseFactory: vi.fn(),
      stopFactory: vi.fn(),
      resumeFactory: vi.fn(),
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
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: stopped\n"),
      resumeFactory: vi.fn(),
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
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
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
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
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
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
      startFactory: vi.fn(),
      stopFactory: vi.fn(async () => ({
        kind: "stopped",
        status: createFactoryControlSnapshot("degraded"),
        terminatedPids: [1234],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "stop"]);

    expect(stdout.join("")).toContain(
      "Factory stop left the runtime degraded.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("sets a non-zero exit code and skips restart launch after a degraded stop", async () => {
    vi.resetModules();
    const startFactory = vi.fn();

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
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

  it("sets a non-zero exit code when restart start is blocked after a clean stop", async () => {
    vi.resetModules();
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
      startFactory: vi.fn(async () => ({
        kind: "blocked-degraded",
        status: createFactoryControlSnapshot("degraded"),
      })),
      stopFactory: vi.fn(async () => ({
        kind: "stopped",
        status: createFactoryControlSnapshot("stopped"),
        terminatedPids: [],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "restart"]);

    expect(stdout.join("")).toContain(
      "Factory restart blocked by degraded cleanup.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports blocked restart when stop was already stopped but start becomes degraded", async () => {
    vi.resetModules();
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: degraded\n"),
      resumeFactory: vi.fn(),
      startFactory: vi.fn(async () => ({
        kind: "blocked-degraded",
        status: createFactoryControlSnapshot("degraded"),
      })),
      stopFactory: vi.fn(async () => ({
        kind: "already-stopped",
        status: createFactoryControlSnapshot("stopped"),
        terminatedPids: [],
      })),
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "restart"]);

    expect(stdout.join("")).toContain(
      "Factory restart blocked by degraded cleanup.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("dispatches the factory watch command", async () => {
    vi.resetModules();
    const watchFactory = vi.fn(async () => {});

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(),
      resumeFactory: vi.fn(),
      startFactory: vi.fn(),
      stopFactory: vi.fn(),
    }));
    vi.doMock("../../src/cli/factory-watch.js", () => ({
      watchFactory,
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "watch"]);

    expect(watchFactory).toHaveBeenCalledWith({ workflowPath: null });
  });

  it("dispatches the factory attach command", async () => {
    vi.resetModules();
    const attachFactory = vi.fn(async () => {});

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl: vi.fn(),
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(),
      resumeFactory: vi.fn(),
      startFactory: vi.fn(),
      stopFactory: vi.fn(),
    }));
    vi.doMock("../../src/cli/factory-watch.js", () => ({
      watchFactory: vi.fn(),
    }));
    vi.doMock("../../src/cli/factory-attach.js", () => ({
      attachFactory,
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli(["node", "symphony", "factory", "attach"]);

    expect(attachFactory).toHaveBeenCalledWith({ workflowPath: null });
  });

  it("forwards explicit workflow selection to factory control and watch commands", async () => {
    vi.resetModules();
    const workflowPath = "/tmp/project/WORKFLOW.md";
    const startFactory = vi.fn(async () => ({
      kind: "started",
      status: createFactoryControlSnapshot("running"),
    }));
    const stopFactory = vi.fn(async () => ({
      kind: "stopped",
      status: createFactoryControlSnapshot("stopped"),
      terminatedPids: [],
    }));
    const inspectFactoryControl = vi.fn(async () =>
      createFactoryControlSnapshot("stopped"),
    );
    const watchFactory = vi.fn(async () => {});
    const attachFactory = vi.fn(async () => {});

    vi.doMock("../../src/cli/factory-control.js", () => ({
      inspectFactoryControl,
      pauseFactory: vi.fn(),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      resumeFactory: vi.fn(),
      startFactory,
      stopFactory,
    }));
    vi.doMock("../../src/cli/factory-watch.js", () => ({
      watchFactory,
    }));
    vi.doMock("../../src/cli/factory-attach.js", () => ({
      attachFactory,
    }));

    const { runCli: mockedRunCli } = await import("../../src/cli/index.js");

    await mockedRunCli([
      "node",
      "symphony",
      "factory",
      "start",
      "--workflow",
      workflowPath,
    ]);
    await mockedRunCli([
      "node",
      "symphony",
      "factory",
      "stop",
      "--workflow",
      workflowPath,
    ]);
    await mockedRunCli([
      "node",
      "symphony",
      "factory",
      "status",
      "--workflow",
      workflowPath,
    ]);
    await mockedRunCli([
      "node",
      "symphony",
      "factory",
      "watch",
      "--workflow",
      workflowPath,
    ]);
    await mockedRunCli([
      "node",
      "symphony",
      "factory",
      "attach",
      "--workflow",
      workflowPath,
    ]);

    expect(startFactory).toHaveBeenCalledWith({ workflowPath });
    expect(stopFactory).toHaveBeenCalledWith({ workflowPath });
    expect(inspectFactoryControl).toHaveBeenCalledWith({ workflowPath });
    expect(watchFactory).toHaveBeenCalledWith({ workflowPath });
    expect(attachFactory).toHaveBeenCalledWith({ workflowPath });
  });
});
