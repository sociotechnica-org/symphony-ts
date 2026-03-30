import { describe, expect, it, vi } from "vitest";
import type { FactoryControlStatusSnapshot } from "../../src/cli/factory-control.js";
import {
  renderWatchError,
  renderWatchFrame,
  watchFactory,
} from "../../src/cli/factory-watch.js";

function createSnapshot(): FactoryControlStatusSnapshot {
  return {
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
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    },
    sessions: [
      {
        id: "1001.symphony-factory",
        pid: 1001,
        name: "symphony-factory",
        state: "Detached",
      },
    ],
    workerAlive: true,
    startup: null,
    snapshotFreshness: {
      freshness: "fresh",
      reason: "current-snapshot",
      summary: "The snapshot belongs to the live factory runtime.",
      workerAlive: true,
      publicationState: "current",
    },
    statusSnapshot: null,
    processIds: [1001, 1002],
    problems: [],
  };
}

describe("renderWatchFrame", () => {
  it("adds watch framing without mutating the control body", () => {
    const output = renderWatchFrame("Factory control: running\n", false);

    expect(output).toContain("Detached factory watch");
    expect(output).toContain("Ctrl-C stops this watch client only.");
    expect(output).toContain("Factory control: running");
  });
});

describe("renderWatchError", () => {
  it("renders a retrying degraded watch message", () => {
    const output = renderWatchError(new Error("runtime missing"));

    expect(output).toContain("Factory control: degraded");
    expect(output).toContain("Watch error: runtime missing");
    expect(output).toContain("watch will retry on the next poll");
  });
});

describe("watchFactory", () => {
  it("renders snapshots repeatedly until interrupted", async () => {
    const writes: string[] = [];
    const listeners = new Map<NodeJS.Signals, () => void>();
    let iterations = 0;
    const inspectFactoryControl = vi.fn(async () => createSnapshot());

    await watchFactory({
      workflowPath: "/repo/WORKFLOW.md",
      inspectFactoryControl,
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      writeStdout: (chunk) => {
        writes.push(chunk);
      },
      isStdoutTTY: () => false,
      onSignal: (signal, listener) => {
        listeners.set(signal, listener);
      },
      offSignal: (signal) => {
        listeners.delete(signal);
      },
      sleep: async () => {
        iterations += 1;
        if (iterations === 2) {
          listeners.get("SIGINT")?.();
        }
      },
    });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("Detached factory watch");
    expect(writes[1]).toContain("Factory control: running");
    expect(listeners.size).toBe(0);
    expect(inspectFactoryControl).toHaveBeenNthCalledWith(1, {
      workflowPath: "/repo/WORKFLOW.md",
    });
    expect(inspectFactoryControl).toHaveBeenNthCalledWith(2, {
      workflowPath: "/repo/WORKFLOW.md",
    });
  });

  it("removes its own signal handlers when interrupted", async () => {
    const onSignal =
      vi.fn<(signal: NodeJS.Signals, listener: () => void) => void>();
    const offSignal =
      vi.fn<(signal: NodeJS.Signals, listener: () => void) => void>();
    let stop: (() => void) | undefined;

    onSignal.mockImplementation((signal, listener) => {
      if (signal === "SIGINT") {
        stop = listener;
      }
    });

    await watchFactory({
      inspectFactoryControl: vi.fn(async () => createSnapshot()),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      writeStdout: vi.fn(),
      isStdoutTTY: () => false,
      onSignal,
      offSignal,
      sleep: async () => {
        stop?.();
      },
    });

    expect(onSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(offSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(offSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("renders inspect failures and keeps polling until interrupted", async () => {
    const writes: string[] = [];
    const listeners = new Map<NodeJS.Signals, () => void>();
    let iterations = 0;

    await watchFactory({
      inspectFactoryControl: vi
        .fn()
        .mockRejectedValueOnce(new Error("runtime missing"))
        .mockResolvedValue(createSnapshot()),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      writeStdout: (chunk) => {
        writes.push(chunk);
      },
      isStdoutTTY: () => false,
      onSignal: (signal, listener) => {
        listeners.set(signal, listener);
      },
      offSignal: (signal) => {
        listeners.delete(signal);
      },
      sleep: async () => {
        iterations += 1;
        if (iterations === 2) {
          listeners.get("SIGINT")?.();
        }
      },
    });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("Watch error: runtime missing");
    expect(writes[1]).toContain("Factory control: running");
  });

  it("treats ABORT_ERR sleep failures as local watch shutdown", async () => {
    const writes: string[] = [];
    const listeners = new Map<NodeJS.Signals, () => void>();
    const abortError = Object.assign(new Error("Factory watch aborted."), {
      code: "ABORT_ERR",
    });

    await watchFactory({
      inspectFactoryControl: vi.fn(async () => createSnapshot()),
      renderFactoryControlStatus: vi.fn(() => "Factory control: running\n"),
      writeStdout: (chunk) => {
        writes.push(chunk);
      },
      isStdoutTTY: () => false,
      onSignal: (signal, listener) => {
        listeners.set(signal, listener);
      },
      offSignal: (signal) => {
        listeners.delete(signal);
      },
      sleep: async () => {
        listeners.get("SIGINT")?.();
        throw abortError;
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Factory control: running");
    expect(listeners.size).toBe(0);
  });
});
