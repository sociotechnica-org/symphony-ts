import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeOperatorSessionCompatibility,
  fingerprintOperatorCommand,
  readOperatorSessionState,
  writeOperatorSessionState,
} from "../../src/observability/operator-session-state.js";
import { prepareOperatorCycle } from "../../src/runner/operator-session.js";
import { createTempDir } from "../support/git.js";

describe("operator session state", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it("stores and reloads persisted operator session records", async () => {
    const tempDir = await createTempDir("symphony-operator-session-");
    tempRoots.push(tempDir);
    const filePath = path.join(tempDir, "operator-session.json");

    await writeOperatorSessionState(filePath, {
      version: 1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      baseCommandFingerprint: fingerprintOperatorCommand({
        provider: "claude",
        baseCommand:
          "claude -p --output-format json --permission-mode bypassPermissions --model claude-sonnet-4-5",
      }),
      backendSessionId: "claude-session-1",
      createdAt: "2026-03-31T00:00:00Z",
      lastUsedAt: "2026-03-31T00:05:00Z",
      lastMode: "fresh",
      lastSummary: "Captured reusable operator session.",
    });

    await expect(readOperatorSessionState(filePath)).resolves.toEqual({
      version: 1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      baseCommandFingerprint: fingerprintOperatorCommand({
        provider: "claude",
        baseCommand:
          "claude -p --output-format json --permission-mode bypassPermissions --model claude-sonnet-4-5",
      }),
      backendSessionId: "claude-session-1",
      createdAt: "2026-03-31T00:00:00Z",
      lastUsedAt: "2026-03-31T00:05:00Z",
      lastMode: "fresh",
      lastSummary: "Captured reusable operator session.",
    });
  });

  it("reports model mismatches as incompatible", () => {
    const compatibility = describeOperatorSessionCompatibility({
      stored: {
        version: 1,
        provider: "claude",
        model: "claude-sonnet-4-5",
        baseCommandFingerprint: "fingerprint",
        backendSessionId: "claude-session-1",
        createdAt: "2026-03-31T00:00:00Z",
        lastUsedAt: "2026-03-31T00:05:00Z",
        lastMode: "fresh",
        lastSummary: "Captured reusable operator session.",
      },
      provider: "claude",
      model: "claude-haiku-4-5",
      baseCommand:
        "claude -p --output-format json --permission-mode bypassPermissions --model claude-haiku-4-5",
    });

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.reason).toContain("stored model");
  });

  it("clears malformed stored session files and runs fresh", async () => {
    const tempDir = await createTempDir("symphony-operator-session-bad-");
    tempRoots.push(tempDir);
    const filePath = path.join(tempDir, "operator-session.json");
    await fs.writeFile(filePath, '{"version":"bad"}\n', "utf8");

    const prepared = await prepareOperatorCycle({
      provider: "claude",
      model: "claude-sonnet-4-5",
      baseCommand:
        "claude -p --output-format json --permission-mode bypassPermissions --model claude-sonnet-4-5",
      resumeSession: true,
      sessionStatePath: filePath,
    });

    expect(prepared.sessionMode).toBe("fresh");
    expect(prepared.sessionSummary).toContain("unreadable");
    await expect(readOperatorSessionState(filePath)).resolves.toBeNull();
  });
});
