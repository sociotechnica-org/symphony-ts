import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearFactoryHaltRecord,
  deriveFactoryHaltFilePath,
  inspectFactoryHalt,
  parseFactoryHaltRecord,
  writeFactoryHaltRecord,
} from "../../src/domain/factory-halt.js";
import { deriveRuntimeInstancePaths } from "../../src/domain/workflow.js";
import { createTempDir } from "../support/git.js";

function createInstance(tempDir: string) {
  return deriveRuntimeInstancePaths({
    workflowPath: path.join(tempDir, "WORKFLOW.md"),
    workspaceRoot: path.join(tempDir, ".tmp", "workspaces"),
  });
}

describe("factory halt state", () => {
  it("writes and reads a halt record", async () => {
    const tempDir = await createTempDir("symphony-factory-halt-");
    const instance = createInstance(tempDir);

    await writeFactoryHaltRecord(instance, {
      reason: "Stop the line until the release is reconciled.",
      haltedAt: "2026-03-30T12:00:00.000Z",
      source: "factory-cli",
      actor: "operator",
    });

    expect(await inspectFactoryHalt(instance)).toEqual({
      state: "halted",
      reason: "Stop the line until the release is reconciled.",
      haltedAt: "2026-03-30T12:00:00.000Z",
      source: "factory-cli",
      actor: "operator",
      detail: null,
    });
  });

  it("treats missing halt state as clear", async () => {
    const tempDir = await createTempDir("symphony-factory-halt-");
    const instance = createInstance(tempDir);

    expect(await inspectFactoryHalt(instance)).toEqual({
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    });
  });

  it("surfaces malformed halt state as degraded", async () => {
    const tempDir = await createTempDir("symphony-factory-halt-");
    const instance = createInstance(tempDir);
    const filePath = deriveFactoryHaltFilePath(instance);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{\n", "utf8");

    expect(await inspectFactoryHalt(instance)).toEqual({
      state: "degraded",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: expect.stringContaining("Failed to parse factory halt state"),
    });
  });

  it("clears halt state on resume", async () => {
    const tempDir = await createTempDir("symphony-factory-halt-");
    const instance = createInstance(tempDir);

    await writeFactoryHaltRecord(instance, {
      reason: "Stop the line.",
    });
    await clearFactoryHaltRecord(instance);

    expect(await inspectFactoryHalt(instance)).toEqual({
      state: "clear",
      reason: null,
      haltedAt: null,
      source: null,
      actor: null,
      detail: null,
    });
  });

  it("rejects invalid parsed content", () => {
    expect(() => parseFactoryHaltRecord('{"version":1}', "/tmp/halt.json"))
      .toThrowError("expected a non-empty reason");
  });
});
