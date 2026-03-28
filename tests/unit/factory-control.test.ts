import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveSymphonyInstanceIdentity } from "../../src/domain/instance-identity.js";
import type { FactoryStatusSnapshot } from "../../src/observability/status.js";
import type { StartupSnapshot } from "../../src/startup/service.js";
import { deriveRuntimeInstancePaths } from "../../src/domain/workflow.js";
import {
  collectDescendantProcessIds,
  createFactoryLaunchEnvironment,
  createFactoryRunCommand,
  createFactoryScreenLaunchCommand,
  inspectFactoryControl,
  parsePsOutput,
  parseLocaleListOutput,
  parseScreenLsFailureOutput,
  parseScreenLsOutput,
  renderFactoryControlStatus,
  resolveFactoryPaths,
  selectFactoryUtf8Locale,
  startFactory,
  stopFactory,
  type FactoryControlDeps,
  type HostProcessSnapshot,
  type ScreenSessionSnapshot,
} from "../../src/cli/factory-control.js";
import { createTempDir } from "../support/git.js";

const LEGACY_TEST_SESSION_NAME = "symphony-factory";

function expectLaunchCwdForCommand(command: readonly string[]): string {
  return path.dirname(path.dirname(command[2] ?? ""));
}

function createStatusSnapshot(
  workerPid: number,
  overrides: Partial<FactoryStatusSnapshot> = {},
): FactoryStatusSnapshot {
  return {
    version: 1,
    generatedAt: "2026-03-13T12:00:00.000Z",
    runtimeIdentity: {
      checkoutPath: "/repo/.tmp/factory-main",
      headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
      committedAt: "2026-03-13T11:57:00.000Z",
      isDirty: false,
      source: "git",
      detail: null,
    },
    factoryState: "idle",
    worker: {
      instanceId: "worker-1",
      pid: workerPid,
      startedAt: "2026-03-13T11:59:00.000Z",
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
    ...overrides,
  };
}

function createStartupSnapshot(
  workerPid: number,
  overrides: Partial<StartupSnapshot> = {},
): StartupSnapshot {
  return {
    version: 1,
    state: "preparing",
    updatedAt: "2026-03-13T11:58:30.000Z",
    workerPid,
    provider: "github-bootstrap/noop",
    summary: "Startup preparation is in progress.",
    runtimeIdentity: {
      checkoutPath: "/repo/.tmp/factory-main",
      headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
      committedAt: "2026-03-13T11:57:00.000Z",
      isDirty: false,
      source: "git",
      detail: null,
    },
    ...overrides,
  };
}

function createControlDeps(
  options: {
    readonly processes?: readonly HostProcessSnapshot[];
    readonly sessions?: readonly ScreenSessionSnapshot[];
    readonly snapshot?: FactoryStatusSnapshot | null;
    readonly startupSnapshot?: StartupSnapshot | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly availableLocales?: readonly string[];
    readonly nowValues?: readonly number[];
    readonly removeFile?: FactoryControlDeps["removeFile"];
    readonly launchScreenSession?: FactoryControlDeps["launchScreenSession"];
    readonly quitScreenSession?: FactoryControlDeps["quitScreenSession"];
    readonly signalProcess?: FactoryControlDeps["signalProcess"];
    readonly sleep?: FactoryControlDeps["sleep"];
    readonly ensureDirectory?: FactoryControlDeps["ensureDirectory"];
  } = {},
): FactoryControlDeps {
  const repoRoot = "/repo";
  const runtimeRoot = path.join(repoRoot, ".tmp", "factory-main");
  const instancePaths = deriveRuntimeInstancePaths({
    workflowPath: path.join(runtimeRoot, "WORKFLOW.md"),
    workspaceRoot: path.join(runtimeRoot, ".tmp", "workspaces"),
  });
  const workflowPath = instancePaths.runtimeWorkflowPath;
  const statusFilePath = instancePaths.statusFilePath;
  const startupFilePath = instancePaths.startupFilePath;
  const nowValues = [...(options.nowValues ?? [0])];
  let lastNowValue = nowValues[0] ?? 0;

  return {
    cwd: () => runtimeRoot,
    environment: () => ({ ...(options.environment ?? {}) }),
    pathExists: async (targetPath) =>
      [
        repoRoot,
        instancePaths.tempRoot,
        runtimeRoot,
        workflowPath,
        path.dirname(statusFilePath),
        statusFilePath,
        startupFilePath,
      ].includes(targetPath),
    loadWorkflowWorkspaceRoot: async () => instancePaths.workspaceRoot,
    loadWorkflowInstancePaths: async () => instancePaths,
    deriveSessionName: () => LEGACY_TEST_SESSION_NAME,
    readFile: async (filePath) => {
      if (filePath === statusFilePath) {
        if (options.snapshot === null) {
          const error = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (options.snapshot === undefined) {
          const error = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(options.snapshot, null, 2)}\n`;
      }
      if (filePath === startupFilePath) {
        if (options.startupSnapshot === null) {
          const error = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (options.startupSnapshot === undefined) {
          const error = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(options.startupSnapshot, null, 2)}\n`;
      }
      {
        const error = new Error(
          `ENOENT: no such file or directory, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    },
    listProcesses: async () => options.processes ?? [],
    listScreenSessions: async () => options.sessions ?? [],
    listAvailableLocales: async () =>
      options.availableLocales ?? ["en_US.UTF-8", "C", "POSIX"],
    removeFile: options.removeFile ?? (async () => {}),
    ensureDirectory: options.ensureDirectory ?? (async () => {}),
    sleep: options.sleep ?? (async () => {}),
    isProcessAlive: (pid) =>
      (options.processes ?? []).some(
        (processSnapshot) => processSnapshot.pid === pid,
      ),
    now: () => {
      if (nowValues.length === 0) {
        return lastNowValue;
      }
      lastNowValue = nowValues.shift() ?? lastNowValue;
      return lastNowValue;
    },
    ...(options.launchScreenSession === undefined
      ? {}
      : { launchScreenSession: options.launchScreenSession }),
    ...(options.quitScreenSession === undefined
      ? {}
      : { quitScreenSession: options.quitScreenSession }),
    ...(options.signalProcess === undefined
      ? {}
      : { signalProcess: options.signalProcess }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveFactoryPaths", () => {
  it("resolves an explicit workflow path without relying on cwd discovery", async () => {
    const tempDir = await createTempDir("symphony-factory-paths-");
    const otherDir = await createTempDir("symphony-factory-paths-other-");
    const workflowContent = `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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
`;

    await fs.mkdir(path.join(tempDir, ".tmp", "factory-main"), {
      recursive: true,
    });
    await fs.mkdir(path.join(otherDir, ".tmp", "factory-main"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(otherDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );

    try {
      const paths = await resolveFactoryPaths({
        cwd: () => otherDir,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
      });
      expect(paths.repoRoot).toBe(tempDir);
      expect(paths.runtimeRoot).toBe(
        path.join(tempDir, ".tmp", "factory-main"),
      );
      expect(paths.workflowPath).toBe(path.join(tempDir, "WORKFLOW.md"));
      expect(paths.statusFilePath).toBe(
        path.join(tempDir, ".tmp", "status.json"),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("finds the outer repo root from a nested working directory", async () => {
    const tempDir = await createTempDir("symphony-factory-paths-");
    const runtimeRoot = path.join(tempDir, ".tmp", "factory-main");
    const nestedCwd = path.join(runtimeRoot, "src");

    await fs.mkdir(path.join(runtimeRoot, ".tmp"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });
    await fs.writeFile(
      path.join(runtimeRoot, "WORKFLOW.md"),
      `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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

    try {
      const paths = await resolveFactoryPaths({
        cwd: () => nestedCwd,
      });
      expect(paths.repoRoot).toBe(tempDir);
      expect(paths.runtimeRoot).toBe(runtimeRoot);
      expect(paths.workflowPath).toBe(path.join(runtimeRoot, "WORKFLOW.md"));
      expect(paths.statusFilePath).toBe(
        path.join(tempDir, ".tmp", "status.json"),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips workspace checkout WORKFLOW files and resolves the owning instance", async () => {
    const tempDir = await createTempDir("symphony-factory-paths-");
    const runtimeRoot = path.join(tempDir, ".tmp", "factory-main");
    const workspaceRepoRoot = path.join(
      tempDir,
      ".tmp",
      "workspaces",
      "sociotechnica-org_symphony-ts_214",
    );
    const nestedCwd = path.join(workspaceRepoRoot, "src");
    const workflowContent = `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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
`;

    await fs.mkdir(path.join(runtimeRoot, ".tmp"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(runtimeRoot, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRepoRoot, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );

    try {
      const paths = await resolveFactoryPaths({
        cwd: () => nestedCwd,
      });
      expect(paths.repoRoot).toBe(tempDir);
      expect(paths.runtimeRoot).toBe(runtimeRoot);
      expect(paths.workflowPath).toBe(path.join(tempDir, "WORKFLOW.md"));
      expect(paths.statusFilePath).toBe(
        path.join(tempDir, ".tmp", "status.json"),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores WORKFLOW files placed directly under .tmp when resolving the instance", async () => {
    const tempDir = await createTempDir("symphony-factory-paths-");
    const tempRoot = path.join(tempDir, ".tmp");
    const runtimeRoot = path.join(tempRoot, "factory-main");
    const workspaceRepoRoot = path.join(
      tempRoot,
      "workspaces",
      "sociotechnica-org_symphony-ts_214",
    );
    const nestedCwd = path.join(workspaceRepoRoot, "src");
    const workflowContent = `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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
`;

    await fs.mkdir(path.join(runtimeRoot, ".tmp"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(runtimeRoot, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRepoRoot, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );

    try {
      const paths = await resolveFactoryPaths({
        cwd: () => nestedCwd,
      });
      expect(paths.repoRoot).toBe(tempDir);
      expect(paths.runtimeRoot).toBe(runtimeRoot);
      expect(paths.workflowPath).toBe(path.join(tempDir, "WORKFLOW.md"));
      expect(paths.statusFilePath).toBe(
        path.join(tempDir, ".tmp", "status.json"),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives a distinct detached session name per selected instance", async () => {
    const firstDir = await createTempDir("symphony-factory-instance-a-");
    const secondDir = await createTempDir("symphony-factory-instance-b-");
    const workflowContent = `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
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
`;

    await fs.writeFile(
      path.join(firstDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(secondDir, "WORKFLOW.md"),
      workflowContent,
      "utf8",
    );

    try {
      const first = await resolveFactoryPaths({
        workflowPath: path.join(firstDir, "WORKFLOW.md"),
      });
      const second = await resolveFactoryPaths({
        workflowPath: path.join(secondDir, "WORKFLOW.md"),
      });

      expect(first.sessionName).toBe(
        deriveSymphonyInstanceIdentity(firstDir).detachedSessionName,
      );
      expect(second.sessionName).toBe(
        deriveSymphonyInstanceIdentity(secondDir).detachedSessionName,
      );
      expect(first.sessionName).not.toBe(second.sessionName);
    } finally {
      await fs.rm(firstDir, { recursive: true, force: true });
      await fs.rm(secondDir, { recursive: true, force: true });
    }
  });
});

describe("process parsing helpers", () => {
  it("parses ps output into pid, ppid, and command fields", () => {
    expect(
      parsePsOutput(" 123  1 node bin/symphony.ts run\n 456 123 codex exec\n"),
    ).toEqual([
      {
        pid: 123,
        ppid: 1,
        command: "node bin/symphony.ts run",
      },
      {
        pid: 456,
        ppid: 123,
        command: "codex exec",
      },
    ]);
  });

  it("parses screen -ls output", () => {
    expect(
      parseScreenLsOutput(
        "There is a screen on:\n\t1234.symphony-factory\t(Detached)\n1 Socket in /tmp/screens.\n",
      ),
    ).toEqual([
      {
        id: "1234.symphony-factory",
        pid: 1234,
        name: "symphony-factory",
        state: "Detached",
      },
    ]);
  });

  it("parses date-stamped screen -ls output", () => {
    expect(
      parseScreenLsOutput(
        "There is a screen on:\n\t1234.symphony-factory\t(03/13/26 12:00:00)\t(Detached)\n1 Socket in /tmp/screens.\n",
      ),
    ).toEqual([
      {
        id: "1234.symphony-factory",
        pid: 1234,
        name: "symphony-factory",
        state: "Detached",
      },
    ]);
  });

  it("ignores dead screen sessions in screen -ls output", () => {
    expect(
      parseScreenLsOutput(
        "There are screens on:\n\t1234.symphony-factory\t(Dead)\n\t1235.symphony-factory\t(Detached)\n2 Sockets in /tmp/screens.\n",
      ),
    ).toEqual([
      {
        id: "1235.symphony-factory",
        pid: 1235,
        name: "symphony-factory",
        state: "Detached",
      },
    ]);
  });

  it("parses screen -ls stdout from a non-zero exit when a session list is present", () => {
    expect(
      parseScreenLsFailureOutput(
        "There is a screen on:\n\t1234.symphony-factory\t(03/13/26 12:00:00)\t(Detached)\n1 Socket in /tmp/screens.\n",
        "",
      ),
    ).toEqual([
      {
        id: "1234.symphony-factory",
        pid: 1234,
        name: "symphony-factory",
        state: "Detached",
      },
    ]);
  });

  it("collects descendant process ids", () => {
    expect(
      collectDescendantProcessIds(
        [
          { pid: 10, ppid: 1, command: "screen" },
          { pid: 11, ppid: 10, command: "pnpm" },
          { pid: 12, ppid: 11, command: "tsx" },
          { pid: 13, ppid: 12, command: "codex exec" },
          { pid: 20, ppid: 1, command: "other" },
        ],
        [10],
      ),
    ).toEqual([10, 11, 12, 13]);
  });
});

describe("UTF-8 locale selection", () => {
  it("parses locale -a output into installed locale names", () => {
    expect(parseLocaleListOutput("C\nen_US.UTF-8\n\nPOSIX\n")).toEqual([
      "C",
      "en_US.UTF-8",
      "POSIX",
    ]);
  });

  it("keeps a valid inherited UTF-8 locale when it is installed", () => {
    expect(
      selectFactoryUtf8Locale(
        {
          LC_ALL: "en_GB.UTF-8",
        },
        ["C", "en_GB.UTF-8", "en_US.UTF-8"],
      ),
    ).toEqual({
      locale: "en_GB.UTF-8",
      source: "inherited",
    });
  });

  it("ignores an unavailable inherited UTF-8 locale and falls back to an installed one", () => {
    expect(
      selectFactoryUtf8Locale(
        {
          LC_ALL: "C.UTF-8",
          LANG: "C",
        },
        ["C", "en_US.UTF-8"],
      ),
    ).toEqual({
      locale: "en_US.UTF-8",
      source: "fallback",
    });
  });

  it("treats LC_CTYPE as a fallback when LC_ALL overrides it", () => {
    expect(
      selectFactoryUtf8Locale(
        {
          LC_ALL: "C",
          LC_CTYPE: "fr_FR.UTF-8",
        },
        ["C", "fr_FR.UTF-8"],
      ),
    ).toEqual({
      locale: "fr_FR.UTF-8",
      source: "fallback",
    });
  });

  it("falls back to the first installed UTF-8 locale when preferred locales are unavailable", () => {
    expect(
      selectFactoryUtf8Locale(
        {
          LANG: "C",
        },
        ["C", "fr_FR.UTF-8", "de_DE.UTF-8"],
      ),
    ).toEqual({
      locale: "de_DE.UTF-8",
      source: "fallback",
    });
  });

  it("builds a launch environment with explicit UTF-8 locale overrides", () => {
    expect(
      createFactoryLaunchEnvironment(
        {
          LANG: "C",
          LC_ALL: "C.UTF-8",
          TERM: "screen-256color",
        },
        ["C", "en_US.UTF-8"],
      ),
    ).toMatchObject({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TERM: "screen-256color",
    });
  });

  it("fails clearly when no installed UTF-8 locale exists", () => {
    expect(() =>
      selectFactoryUtf8Locale(
        {
          LC_ALL: "C.UTF-8",
        },
        ["C", "POSIX"],
      ),
    ).toThrow(
      "Factory detached TUI requires an installed UTF-8 locale, but 'locale -a' reported none. Inherited locale candidates: C.UTF-8.",
    );
  });
});

describe("inspectFactoryControl", () => {
  it("reports stopped when there is no session, process, or snapshot", async () => {
    const snapshot = await inspectFactoryControl(createControlDeps());
    expect(snapshot.controlState).toBe("stopped");
    expect(snapshot.processIds).toEqual([]);
    expect(snapshot.snapshotFreshness.freshness).toBe("unavailable");
  });

  it("reports running when the session and snapshot worker are healthy", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
          { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(workerPid),
      }),
    );

    expect(snapshot.controlState).toBe("running");
    expect(snapshot.workerAlive).toBe(true);
    expect(snapshot.snapshotFreshness.freshness).toBe("fresh");
    expect(snapshot.problems).toEqual([]);
  });

  it("reports degraded when factory-owned processes remain without the screen session", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        processes: [
          { pid: 9002, ppid: 1, command: "pnpm tsx bin/symphony.ts run" },
          { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(workerPid),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.problems).toContain(
      "detached screen session is missing but factory-owned processes remain",
    );
  });

  it("reports a leftover offline snapshot as stale when no live runtime remains", async () => {
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        snapshot: createStatusSnapshot(999_999_999),
      }),
    );

    expect(snapshot.controlState).toBe("stopped");
    expect(snapshot.snapshotFreshness.freshness).toBe("stale");
    expect(snapshot.snapshotFreshness.reason).toBe("worker-offline");
  });

  it("reports startup snapshots as unavailable until a current snapshot is published", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
          { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(workerPid, {
          publication: {
            state: "initializing",
            detail:
              "Factory startup is in progress; no current runtime snapshot is available yet.",
          },
        }),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.snapshotFreshness.freshness).toBe("unavailable");
    expect(snapshot.snapshotFreshness.reason).toBe("startup-in-progress");
  });

  it("ignores another instance's detached session while inspecting the selected instance", async () => {
    const snapshot = await inspectFactoryControl({
      ...createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
          {
            id: "9101.symphony-factory-project-b-deadbeef01",
            pid: 9101,
            name: "symphony-factory-project-b-deadbeef01",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
          {
            pid: 9101,
            ppid: 1,
            command: "screen -dmS symphony-factory-project-b-deadbeef01",
          },
          { pid: 9102, ppid: 9101, command: "pnpm tsx bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(9002),
      }),
    });

    expect(snapshot.controlState).toBe("running");
    expect(snapshot.sessions).toEqual([
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ]);
    expect(snapshot.processIds).toEqual([9001, 9002]);
  });

  it("reports offline startup snapshots as stale startup failures", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        snapshot: createStatusSnapshot(workerPid, {
          publication: {
            state: "initializing",
            detail:
              "Factory startup is in progress; no current runtime snapshot is available yet.",
          },
        }),
      }),
    );

    expect(snapshot.controlState).toBe("stopped");
    expect(snapshot.snapshotFreshness.freshness).toBe("stale");
    expect(snapshot.snapshotFreshness.reason).toBe("startup-failed");
  });

  it("surfaces startup preparation while the runtime has not published status yet", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: workerPid, ppid: 9001, command: "node bin/symphony.ts run" },
        ],
        snapshot: null,
        startupSnapshot: createStartupSnapshot(workerPid),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.startup).toMatchObject({
      state: "preparing",
      summary: "Startup preparation is in progress.",
      stale: false,
    });
    expect(snapshot.problems).not.toContain(
      "screen session exists but no readable runtime status snapshot was found",
    );
  });

  it("reports explicit startup failures even when the worker has already exited", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        snapshot: null,
        startupSnapshot: createStartupSnapshot(workerPid, {
          state: "failed",
          summary: "Mirror refresh failed.",
        }),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.startup).toMatchObject({
      state: "failed",
      summary: "Mirror refresh failed.",
      stale: true,
    });
    expect(snapshot.problems).toContain(
      "startup failed: Mirror refresh failed.",
    );
    expect(snapshot.problems).not.toContain(
      "startup snapshot is stale (failed) and belongs to an offline runtime",
    );
  });

  it("reports stale preparing startup artifacts as degraded when no runtime is live", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        snapshot: null,
        startupSnapshot: createStartupSnapshot(workerPid, {
          state: "preparing",
        }),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.startup).toMatchObject({
      state: "preparing",
      stale: true,
    });
    expect(snapshot.problems).toContain(
      "startup snapshot is stale (preparing) and belongs to an offline runtime",
    );
  });

  it("treats stale ready startup artifacts as stopped with an unclean-exit message", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        snapshot: null,
        startupSnapshot: createStartupSnapshot(workerPid, {
          state: "ready",
          summary: "Startup preparation completed.",
        }),
      }),
    );

    expect(snapshot.controlState).toBe("stopped");
    expect(snapshot.startup).toMatchObject({
      state: "ready",
      stale: true,
    });
    expect(snapshot.problems).toContain(
      "runtime exited without cleanup after startup completed",
    );
  });

  it("does not classify a live runtime as running when startup already failed", async () => {
    const workerPid = 9101;
    const snapshot = await inspectFactoryControl(
      createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: workerPid, ppid: 9001, command: "node bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(workerPid),
        startupSnapshot: createStartupSnapshot(workerPid, {
          state: "failed",
          summary: "Mirror refresh failed.",
        }),
      }),
    );

    expect(snapshot.controlState).toBe("degraded");
    expect(snapshot.problems).toContain(
      "startup failed: Mirror refresh failed.",
    );
  });
});

describe("createFactoryRunCommand", () => {
  it("builds the detached run command with the required guardrails acknowledgment", () => {
    expect(createFactoryRunCommand("/tmp/target/WORKFLOW.md")).toEqual([
      "pnpm",
      "tsx",
      expect.stringMatching(/bin\/symphony\.ts$/u),
      "run",
      "--workflow",
      "/tmp/target/WORKFLOW.md",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ]);
  });

  it("builds the detached screen launch argv in UTF-8 mode", () => {
    expect(
      createFactoryScreenLaunchCommand(
        "symphony-factory",
        createFactoryRunCommand("/tmp/target/WORKFLOW.md"),
      ),
    ).toEqual([
      "-U",
      "-dmS",
      "symphony-factory",
      "pnpm",
      "tsx",
      expect.stringMatching(/bin\/symphony\.ts$/u),
      "run",
      "--workflow",
      "/tmp/target/WORKFLOW.md",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ]);
  });
});

describe("startFactory", () => {
  it("returns already-running when the factory is healthy", async () => {
    const workerPid = 9101;
    const result = await startFactory(
      createControlDeps({
        sessions: [
          {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Detached",
          },
        ],
        processes: [
          { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
          { pid: workerPid, ppid: 9001, command: "node bin/symphony.ts run" },
        ],
        snapshot: createStatusSnapshot(workerPid),
      }),
    );

    expect(result.kind).toBe("already-running");
    expect(result.status.controlState).toBe("running");
  });

  it("launches the detached session and waits until the runtime becomes healthy", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [];
    const processesState: HostProcessSnapshot[] = [];
    const workerPid = 9101;
    let currentSnapshot: FactoryStatusSnapshot | null = null;
    const launched: Array<{
      runtimeRoot: string;
      launchCwd: string;
      sessionName: string;
      command: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];

    const result = await startFactory({
      ...createControlDeps({
        launchScreenSession: async (options) => {
          launched.push(options);
          sessionsState.push({
            id: "9001.symphony-factory",
            pid: 9001,
            name: options.sessionName,
            state: "Detached",
          });
          processesState.push(
            { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
            { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
            { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
          );
          currentSnapshot = createStatusSnapshot(workerPid, {
            factoryState: "running",
          });
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json")) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (currentSnapshot === null) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(currentSnapshot, null, 2)}\n`;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(launched).toHaveLength(1);
    expect(launched[0]).toEqual({
      runtimeRoot: "/repo/.tmp/factory-main",
      launchCwd: expectLaunchCwdForCommand(
        createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
      ),
      sessionName: "symphony-factory",
      command: createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
      env: expect.objectContaining({
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
      }),
    });
    expect(result.kind).toBe("started");
    expect(result.status.controlState).toBe("running");
  });

  it("launches a third-party instance from the engine checkout with an explicit workflow path", async () => {
    const launched: Array<{
      runtimeRoot: string;
      launchCwd: string;
      sessionName: string;
      command: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    let statusPublished = false;

    const result = await startFactory({
      workflowPath: "/target-project/WORKFLOW.md",
      cwd: () => "/engine-checkout",
      pathExists: async () => true,
      loadWorkflowInstancePaths: async () =>
        deriveRuntimeInstancePaths({
          workflowPath: "/target-project/WORKFLOW.md",
          workspaceRoot: "/target-project/.tmp/workspaces",
        }),
      deriveSessionName: () => "symphony-factory-target-project",
      readFile: async (filePath) => {
        if (
          filePath === "/target-project/.tmp/status.json" &&
          statusPublished
        ) {
          return `${JSON.stringify(
            createStatusSnapshot(9101, {
              factoryState: "running",
            }),
            null,
            2,
          )}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      listProcesses: async () =>
        statusPublished
          ? [
              {
                pid: 9101,
                ppid: 9002,
                command: "node /engine-checkout/bin/symphony.ts run",
              },
            ]
          : [],
      listScreenSessions: async () =>
        statusPublished
          ? [
              {
                id: "9001.symphony-factory-target-project",
                pid: 9001,
                name: "symphony-factory-target-project",
                state: "Detached",
              },
            ]
          : [],
      listAvailableLocales: async () => ["en_US.UTF-8", "C"],
      ensureDirectory: async () => {},
      removeFile: async () => {},
      launchScreenSession: async (options) => {
        launched.push(options);
        statusPublished = true;
      },
      isProcessAlive: () => true,
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(launched).toEqual([
      {
        runtimeRoot: "/target-project/.tmp/factory-main",
        launchCwd: expectLaunchCwdForCommand(
          createFactoryRunCommand("/target-project/WORKFLOW.md"),
        ),
        sessionName: "symphony-factory-target-project",
        command: createFactoryRunCommand("/target-project/WORKFLOW.md"),
        env: expect.objectContaining({
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          LC_CTYPE: "en_US.UTF-8",
        }),
      },
    ]);
    expect(result.kind).toBe("started");
    expect(result.status.paths.repoRoot).toBe("/target-project");
  });

  it("keeps waiting while the restarted runtime only has an initializing snapshot", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [];
    const processesState: HostProcessSnapshot[] = [];
    const workerPid = 9101;
    let currentSnapshot: FactoryStatusSnapshot | null = null;
    let sleepCount = 0;

    const result = await startFactory({
      ...createControlDeps({
        launchScreenSession: async (options) => {
          sessionsState.push({
            id: "9001.symphony-factory",
            pid: 9001,
            name: options.sessionName,
            state: "Detached",
          });
          processesState.push(
            { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
            { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
            { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
          );
          currentSnapshot = createStatusSnapshot(workerPid, {
            publication: {
              state: "initializing",
              detail:
                "Factory startup is in progress; no current runtime snapshot is available yet.",
            },
          });
        },
        sleep: async () => {
          sleepCount += 1;
          if (sleepCount === 1 && currentSnapshot !== null) {
            currentSnapshot = {
              ...currentSnapshot,
              publication: {
                state: "current",
                detail: null,
              },
            };
          }
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json")) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (currentSnapshot === null) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(currentSnapshot, null, 2)}\n`;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(sleepCount).toBeGreaterThan(0);
    expect(result.kind).toBe("started");
    expect(result.status.controlState).toBe("running");
    expect(result.status.snapshotFreshness.freshness).toBe("fresh");
  });

  it("returns an explicit startup-failed result when startup preparation fails quickly", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [];
    const processesState: HostProcessSnapshot[] = [];
    let startupSnapshot: StartupSnapshot | null = null;

    const result = await startFactory({
      ...createControlDeps({
        launchScreenSession: async (options) => {
          sessionsState.push({
            id: "9001.symphony-factory",
            pid: 9001,
            name: options.sessionName,
            state: "Detached",
          });
          processesState.push(
            { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
            { pid: 9101, ppid: 9001, command: "node bin/symphony.ts run" },
          );
          startupSnapshot = createStartupSnapshot(9101, {
            state: "failed",
            summary: "Mirror refresh failed.",
          });
          processesState.splice(0, processesState.length);
          sessionsState.splice(0, sessionsState.length);
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json") && startupSnapshot !== null) {
          return `${JSON.stringify(startupSnapshot, null, 2)}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(result.kind).toBe("startup-failed");
    expect(result.status.startup?.summary).toBe("Mirror refresh failed.");
  });

  it("returns startup-failed when the worker dies during preparation and leaves a stale startup artifact", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [];
    const processesState: HostProcessSnapshot[] = [];
    let startupSnapshot: StartupSnapshot | null = null;

    const result = await startFactory({
      ...createControlDeps({
        launchScreenSession: async (options) => {
          sessionsState.push({
            id: "9001.symphony-factory",
            pid: 9001,
            name: options.sessionName,
            state: "Detached",
          });
          processesState.push(
            { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
            { pid: 9101, ppid: 9001, command: "node bin/symphony.ts run" },
          );
          startupSnapshot = createStartupSnapshot(9101, {
            state: "preparing",
            summary: "Startup preparation is in progress.",
          });
          processesState.splice(0, processesState.length);
          sessionsState.splice(0, sessionsState.length);
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json") && startupSnapshot !== null) {
          return `${JSON.stringify(startupSnapshot, null, 2)}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(result.kind).toBe("startup-failed");
    expect(result.status.controlState).toBe("degraded");
    expect(result.status.startup).toMatchObject({
      state: "preparing",
      stale: true,
    });
  });

  it("does not use the status snapshot worker to classify a preparing startup artifact as failed", async () => {
    let currentSnapshot: FactoryStatusSnapshot | null = null;
    let startupSnapshot: StartupSnapshot | null = null;

    await expect(
      startFactory({
        ...createControlDeps({
          launchScreenSession: async () => {
            currentSnapshot = createStatusSnapshot(9201, {
              factoryState: "running",
            });
            startupSnapshot = createStartupSnapshot(9101, {
              state: "preparing",
            });
          },
          nowValues: [0, 1_000, 8_000, 15_000, 16_000],
        }),
        listProcesses: async () => [],
        listScreenSessions: async () => [],
        readFile: async (filePath) => {
          if (filePath.endsWith("startup.json") && startupSnapshot !== null) {
            return `${JSON.stringify(startupSnapshot, null, 2)}\n`;
          }
          if (filePath.endsWith("status.json") && currentSnapshot !== null) {
            return `${JSON.stringify(currentSnapshot, null, 2)}\n`;
          }
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        isProcessAlive: (pid) => pid === 9101,
      }),
    ).rejects.toThrow(
      "Factory start timed out before a healthy runtime appeared under /repo/.tmp/factory-main.",
    );
  });

  it("starts only after degraded cleanup reaches stopped", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ];
    const processesState: HostProcessSnapshot[] = [];
    const workerPid = 9101;
    let currentSnapshot: FactoryStatusSnapshot | null = null;
    const quitCalls: string[] = [];
    const launched: string[] = [];

    const result = await startFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: processesState,
        snapshot: null,
        quitScreenSession: async (sessionId) => {
          quitCalls.push(sessionId);
          sessionsState.splice(0, sessionsState.length);
        },
        launchScreenSession: async () => {
          launched.push("launch");
          sessionsState.push({
            id: "9002.symphony-factory",
            pid: 9002,
            name: "symphony-factory",
            state: "Detached",
          });
          processesState.push(
            { pid: 9002, ppid: 1, command: "screen -dmS symphony-factory" },
            { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
          );
          currentSnapshot = createStatusSnapshot(workerPid, {
            factoryState: "running",
          });
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json")) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (currentSnapshot === null) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(currentSnapshot, null, 2)}\n`;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(quitCalls).toEqual(["9001.symphony-factory"]);
    expect(launched).toEqual(["launch"]);
    expect(result.kind).toBe("started");
    expect(result.status.controlState).toBe("running");
  });

  it("returns a degraded result when pre-start cleanup cannot clear degraded state", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ];
    const launchScreenSession =
      vi.fn<NonNullable<FactoryControlDeps["launchScreenSession"]>>();

    const result = await startFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: [],
        snapshot: null,
        quitScreenSession: async () => {},
        launchScreenSession,
      }),
      listScreenSessions: async () => sessionsState,
      listProcesses: async () => [],
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: () => false,
    });

    expect(result.kind).toBe("blocked-degraded");
    expect(result.status.controlState).toBe("degraded");
    expect(result.status.problems).toContain(
      "screen session exists but no readable runtime status snapshot was found",
    );
    expect(launchScreenSession).not.toHaveBeenCalled();
  });

  it("times out when the detached runtime never becomes healthy after launch", async () => {
    const launched: Array<{
      runtimeRoot: string;
      launchCwd: string;
      sessionName: string;
      command: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];

    await expect(
      startFactory(
        createControlDeps({
          launchScreenSession: async (options) => {
            launched.push(options);
          },
          nowValues: [0, 1_000, 8_000, 15_000, 16_000],
        }),
      ),
    ).rejects.toThrow(
      "Factory start timed out before a healthy runtime appeared under /repo/.tmp/factory-main.",
    );

    expect(launched).toEqual([
      {
        runtimeRoot: "/repo/.tmp/factory-main",
        launchCwd: expectLaunchCwdForCommand(
          createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        ),
        sessionName: "symphony-factory",
        command: createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        env: expect.objectContaining({
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          LC_CTYPE: "en_US.UTF-8",
        }),
      },
    ]);
  });

  it("normalizes a bad inherited locale before launching the detached runtime", async () => {
    const launched: Array<{
      runtimeRoot: string;
      launchCwd: string;
      sessionName: string;
      command: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];

    await expect(
      startFactory(
        createControlDeps({
          environment: {
            LC_ALL: "C.UTF-8",
            LANG: "C",
            TERM: "screen-256color",
          },
          availableLocales: ["C", "en_US.UTF-8"],
          launchScreenSession: async (options) => {
            launched.push(options);
          },
          nowValues: [0, 1_000, 8_000, 15_000, 16_000],
        }),
      ),
    ).rejects.toThrow(
      "Factory start timed out before a healthy runtime appeared under /repo/.tmp/factory-main.",
    );

    expect(launched).toEqual([
      {
        runtimeRoot: "/repo/.tmp/factory-main",
        launchCwd: expectLaunchCwdForCommand(
          createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        ),
        sessionName: "symphony-factory",
        command: createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        env: expect.objectContaining({
          TERM: "screen-256color",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          LC_CTYPE: "en_US.UTF-8",
        }),
      },
    ]);
  });

  it("fails clearly before launch when no installed UTF-8 locale is available", async () => {
    const launchScreenSession =
      vi.fn<NonNullable<FactoryControlDeps["launchScreenSession"]>>();

    await expect(
      startFactory(
        createControlDeps({
          environment: {
            LC_ALL: "C.UTF-8",
          },
          availableLocales: ["C", "POSIX"],
          launchScreenSession,
        }),
      ),
    ).rejects.toThrow(
      "Factory detached TUI requires an installed UTF-8 locale, but 'locale -a' reported none. Inherited locale candidates: C.UTF-8.",
    );

    expect(launchScreenSession).not.toHaveBeenCalled();
  });
});

describe("stopFactory", () => {
  it("returns already-stopped when there is no active runtime", async () => {
    const result = await stopFactory(createControlDeps());
    expect(result.kind).toBe("already-stopped");
    expect(result.terminatedPids).toEqual([]);
  });

  it("quits the screen session and terminates remaining descendants", async () => {
    const workerPid = 9101;
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ];
    const processesState: HostProcessSnapshot[] = [
      { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
      { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
      { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
      {
        pid: 9102,
        ppid: workerPid,
        command: "codex exec --dangerously-bypass-approvals-and-sandbox",
      },
    ];
    const quitCalls: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: processesState,
        snapshot: createStatusSnapshot(workerPid),
        quitScreenSession: async (sessionId) => {
          quitCalls.push(sessionId);
          sessionsState.splice(0, sessionsState.length);
          const remaining = processesState.filter(
            (processSnapshot) => processSnapshot.pid !== 9001,
          );
          processesState.splice(0, processesState.length, ...remaining);
        },
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
          const index = processesState.findIndex(
            (processSnapshot) => processSnapshot.pid === pid,
          );
          if (index >= 0) {
            processesState.splice(index, 1);
          }
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async () => {
        if (
          processesState.some(
            (processSnapshot) => processSnapshot.pid === workerPid,
          )
        ) {
          return `${JSON.stringify(createStatusSnapshot(workerPid), null, 2)}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(quitCalls).toEqual(["9001.symphony-factory"]);
    expect(signals).toEqual(
      expect.arrayContaining([
        { pid: 9002, signal: "SIGTERM" },
        { pid: workerPid, signal: "SIGTERM" },
        { pid: 9102, signal: "SIGTERM" },
      ]),
    );
    expect(result.kind).toBe("stopped");
    expect(result.status.controlState).toBe("stopped");
  });

  it("stops only the selected instance when another detached session is healthy", async () => {
    const workerPid = 9101;
    const otherSessionName = "symphony-factory-project-b-deadbeef01";
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
      {
        id: `9201.${otherSessionName}`,
        pid: 9201,
        name: otherSessionName,
        state: "Detached",
      },
    ];
    const processesState: HostProcessSnapshot[] = [
      { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
      { pid: 9002, ppid: 9001, command: "pnpm tsx bin/symphony.ts run" },
      { pid: workerPid, ppid: 9002, command: "node bin/symphony.ts run" },
      {
        pid: 9201,
        ppid: 1,
        command: `screen -dmS ${otherSessionName}`,
      },
      { pid: 9202, ppid: 9201, command: "pnpm tsx bin/symphony.ts run" },
    ];
    const quitCalls: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: processesState,
        snapshot: createStatusSnapshot(workerPid),
        quitScreenSession: async (sessionId) => {
          quitCalls.push(sessionId);
          const remainingSessions = sessionsState.filter(
            (session) => session.id !== sessionId,
          );
          sessionsState.splice(0, sessionsState.length, ...remainingSessions);
          const remainingProcesses = processesState.filter(
            (processSnapshot) => processSnapshot.pid !== 9001,
          );
          processesState.splice(
            0,
            processesState.length,
            ...remainingProcesses,
          );
        },
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
          const index = processesState.findIndex(
            (processSnapshot) => processSnapshot.pid === pid,
          );
          if (index >= 0) {
            processesState.splice(index, 1);
          }
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async () => {
        if (
          processesState.some(
            (processSnapshot) => processSnapshot.pid === workerPid,
          )
        ) {
          return `${JSON.stringify(createStatusSnapshot(workerPid), null, 2)}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    });

    expect(quitCalls).toEqual(["9001.symphony-factory"]);
    expect(signals).toEqual(
      expect.arrayContaining([
        { pid: 9002, signal: "SIGTERM" },
        { pid: workerPid, signal: "SIGTERM" },
      ]),
    );
    expect(signals).not.toEqual(
      expect.arrayContaining([{ pid: 9202, signal: "SIGTERM" }]),
    );
    expect(processesState).toEqual(
      expect.arrayContaining([
        { pid: 9201, ppid: 1, command: `screen -dmS ${otherSessionName}` },
        { pid: 9202, ppid: 9201, command: "pnpm tsx bin/symphony.ts run" },
      ]),
    );
    expect(result.kind).toBe("stopped");
    expect(result.status.controlState).toBe("stopped");
  });

  it("waits for one post-SIGKILL poll before timing out", async () => {
    const workerPid = 9101;
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ];
    const processesState: HostProcessSnapshot[] = [
      { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
      { pid: workerPid, ppid: 9001, command: "node bin/symphony.ts run" },
      {
        pid: 9102,
        ppid: workerPid,
        command: "codex exec --dangerously-bypass-approvals-and-sandbox",
      },
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: processesState,
        snapshot: createStatusSnapshot(workerPid),
        quitScreenSession: async () => {
          sessionsState.splice(0, sessionsState.length);
          processesState.splice(
            0,
            processesState.length,
            ...processesState.filter(
              (processSnapshot) => processSnapshot.pid !== 9001,
            ),
          );
        },
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
          if (signal === "SIGKILL") {
            const index = processesState.findIndex(
              (processSnapshot) => processSnapshot.pid === pid,
            );
            if (index >= 0) {
              processesState.splice(index, 1);
            }
          }
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async () => {
        if (
          processesState.some(
            (processSnapshot) => processSnapshot.pid === workerPid,
          )
        ) {
          return `${JSON.stringify(createStatusSnapshot(workerPid), null, 2)}\n`;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let current = 0;
        return () => {
          current += 15_000;
          return current;
        };
      })(),
    });

    expect(signals).toEqual(
      expect.arrayContaining([
        { pid: workerPid, signal: "SIGTERM" },
        { pid: 9102, signal: "SIGTERM" },
        { pid: workerPid, signal: "SIGKILL" },
        { pid: 9102, signal: "SIGKILL" },
      ]),
    );
    expect(result.kind).toBe("stopped");
    expect(result.status.controlState).toBe("stopped");
  });

  it("treats dead screen sessions as stopped once all live processes are gone", async () => {
    const workerPid = 9101;
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
    ];
    const processesState: HostProcessSnapshot[] = [
      { pid: 9001, ppid: 1, command: "screen -dmS symphony-factory" },
      { pid: workerPid, ppid: 9001, command: "node bin/symphony.ts run" },
    ];

    const result = await stopFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: processesState,
        snapshot: createStatusSnapshot(workerPid),
        quitScreenSession: async () => {
          sessionsState.splice(0, sessionsState.length, {
            id: "9001.symphony-factory",
            pid: 9001,
            name: "symphony-factory",
            state: "Dead",
          });
          processesState.splice(0, processesState.length);
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: () => false,
      now: (() => {
        let current = 0;
        return () => {
          current += 100;
          return current;
        };
      })(),
    });

    expect(result.kind).toBe("stopped");
    expect(result.status.controlState).toBe("stopped");
    expect(result.status.sessions).toEqual([]);
  });

  it("ignores already-missing screen sessions while stopping multiple sessions", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [
      {
        id: "9001.symphony-factory",
        pid: 9001,
        name: "symphony-factory",
        state: "Detached",
      },
      {
        id: "9002.symphony-factory",
        pid: 9002,
        name: "symphony-factory",
        state: "Detached",
      },
    ];

    const result = await stopFactory({
      ...createControlDeps({
        sessions: sessionsState,
        processes: [],
        snapshot: null,
        quitScreenSession: async (sessionId) => {
          if (sessionId === "9001.symphony-factory") {
            sessionsState.splice(0, sessionsState.length);
            return;
          }
          const error = new Error("No screen session found.") as Error & {
            stderr: string;
          };
          error.stderr = "No screen session found.";
          throw error;
        },
      }),
      listProcesses: async () => [],
      listScreenSessions: async () => sessionsState,
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      isProcessAlive: () => false,
    });

    expect(result.kind).toBe("stopped");
    expect(result.status.controlState).toBe("stopped");
    expect(result.status.sessions).toEqual([]);
  });

  it("does not swallow synthetic ESRCH errors from quitScreenSession", async () => {
    await expect(
      stopFactory({
        ...createControlDeps({
          sessions: [
            {
              id: "9001.symphony-factory",
              pid: 9001,
              name: "symphony-factory",
              state: "Detached",
            },
          ],
          processes: [],
          snapshot: null,
          quitScreenSession: async () => {
            const error = new Error("esrch") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
          },
        }),
      }),
    ).rejects.toThrow(
      "Failed to stop detached screen session 9001.symphony-factory.",
    );
  });
});

describe("factory restart launch contract", () => {
  it("reuses the same detached run command on every start after a stop", async () => {
    const sessionsState: ScreenSessionSnapshot[] = [];
    const processesState: HostProcessSnapshot[] = [];
    let currentSnapshot: FactoryStatusSnapshot | null = null;
    const launches: Array<{
      runtimeRoot: string;
      launchCwd: string;
      sessionName: string;
      command: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    let nextSessionPid = 9001;
    let nextWorkerPid = 9201;

    const deps: FactoryControlDeps = {
      ...createControlDeps({
        launchScreenSession: async (options) => {
          launches.push(options);
          const sessionPid = nextSessionPid++;
          const workerPid = nextWorkerPid++;
          sessionsState.splice(0, sessionsState.length, {
            id: `${sessionPid}.${options.sessionName}`,
            pid: sessionPid,
            name: options.sessionName,
            state: "Detached",
          });
          processesState.splice(
            0,
            processesState.length,
            {
              pid: sessionPid,
              ppid: 1,
              command: "screen -dmS symphony-factory",
            },
            {
              pid: sessionPid + 100,
              ppid: sessionPid,
              command: options.command.join(" "),
            },
            {
              pid: workerPid,
              ppid: sessionPid + 100,
              command: `node ${options.command.slice(2).join(" ")}`,
            },
          );
          currentSnapshot = createStatusSnapshot(workerPid, {
            factoryState: "running",
          });
        },
        quitScreenSession: async () => {
          sessionsState.splice(0, sessionsState.length);
          processesState.splice(0, processesState.length);
          currentSnapshot = null;
        },
      }),
      listProcesses: async () => processesState,
      listScreenSessions: async () => sessionsState,
      readFile: async (filePath) => {
        if (filePath.endsWith("startup.json")) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (currentSnapshot === null) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${JSON.stringify(currentSnapshot, null, 2)}\n`;
      },
      isProcessAlive: (pid) =>
        processesState.some((processSnapshot) => processSnapshot.pid === pid),
      now: (() => {
        let now = 0;
        return () => {
          now += 100;
          return now;
        };
      })(),
    };

    const firstStart = await startFactory(deps);
    const stopped = await stopFactory(deps);
    const secondStart = await startFactory(deps);

    expect(firstStart.status.controlState).toBe("running");
    expect(stopped.status.controlState).toBe("stopped");
    expect(secondStart.status.controlState).toBe("running");
    expect(launches).toHaveLength(2);
    expect(launches).toEqual([
      expect.objectContaining({
        command: createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        env: expect.objectContaining({
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          LC_CTYPE: "en_US.UTF-8",
        }),
      }),
      expect.objectContaining({
        command: createFactoryRunCommand("/repo/.tmp/factory-main/WORKFLOW.md"),
        env: expect.objectContaining({
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          LC_CTYPE: "en_US.UTF-8",
        }),
      }),
    ]);
  });
});

describe("renderFactoryControlStatus", () => {
  it("renders the runtime path and snapshot guidance for stopped state", () => {
    const output = renderFactoryControlStatus({
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
      startup: {
        state: "ready",
        provider: "github-bootstrap/noop",
        summary: "Startup preparation completed.",
        updatedAt: "2026-03-13T11:58:30.000Z",
        workerPid: 4321,
        workerAlive: false,
        stale: false,
        runtimeIdentity: {
          checkoutPath: "/repo/.tmp/factory-main",
          headSha: "4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26",
          committedAt: "2026-03-13T11:57:00.000Z",
          isDirty: false,
          source: "git",
          detail: null,
        },
      },
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
    });

    expect(output).toContain("Factory control: stopped");
    expect(output).toContain("Runtime root: /repo/.tmp/factory-main");
    expect(output).toContain(
      "Runtime version: 4e5d1350f4b6b48525f4dca84e0d7df5c27f4c26 | committed 2026-03-13T11:57:00.000Z | clean",
    );
    expect(output).toContain("Snapshot freshness: unavailable");
    expect(output).toContain(
      "Status detail: No runtime snapshot is available.",
    );
  });
});
