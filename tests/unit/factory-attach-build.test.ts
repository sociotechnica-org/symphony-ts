import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_ATTACH_MACOS_HELPER_SOURCE } from "../../src/cli/factory-attach-macos-helper-source.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs/promises");
});

describe("macOS attach helper rebuild", () => {
  it("preserves the compiler failure when temp-binary cleanup also fails", async () => {
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          const compiler = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
          };
          compiler.stderr = new EventEmitter();
          queueMicrotask(() => {
            compiler.stderr.emit("data", Buffer.from("broken compile"));
            compiler.emit("exit", 1, null);
          });
          return compiler;
        }),
      };
    });

    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async () => FACTORY_ATTACH_MACOS_HELPER_SOURCE),
      rename: vi.fn(async () => {}),
      stat: vi.fn(async (path: string) => {
        if (path.endsWith(".c")) {
          return {
            mtimeMs: 10,
            size: FACTORY_ATTACH_MACOS_HELPER_SOURCE.length,
          };
        }
        const error = new Error("missing binary") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }),
      unlink: vi.fn(async () => {
        const error = new Error(
          "EPERM cleanup failure",
        ) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
      writeFile: vi.fn(async () => {}),
    }));

    const { createFactoryAttachLaunchSpec } =
      await import("../../src/cli/factory-attach.js");

    await expect(
      createFactoryAttachLaunchSpec("1234.session", "darwin"),
    ).rejects.toThrowError(/could not build the local macOS PTY helper/i);
    await expect(
      createFactoryAttachLaunchSpec("1234.session", "darwin"),
    ).rejects.not.toThrowError(/EPERM cleanup failure/);
  });
});
