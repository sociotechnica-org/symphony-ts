import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFactoryRuntimeIdentity,
  renderFactoryRuntimeIdentity,
} from "../../src/observability/runtime-identity.js";
import {
  commitAllFiles,
  createTempDir,
  initializeGitRepo,
} from "../support/git.js";

describe("factory runtime identity", () => {
  it("collects commit metadata from a git checkout", async () => {
    const tempDir = await createTempDir("symphony-runtime-identity-git-");

    try {
      await initializeGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# test\n", "utf8");
      const sha = await commitAllFiles(tempDir, "initial commit");

      const identity = await collectFactoryRuntimeIdentity(tempDir);

      expect(identity).toMatchObject({
        checkoutPath: tempDir,
        headSha: sha,
        source: "git",
        isDirty: false,
      });
      expect(identity.committedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks the checkout dirty when tracked files change", async () => {
    const tempDir = await createTempDir("symphony-runtime-identity-dirty-");

    try {
      await initializeGitRepo(tempDir);
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "# test\n", "utf8");
      await commitAllFiles(tempDir, "initial commit");
      await fs.writeFile(readmePath, "# dirty\n", "utf8");

      const identity = await collectFactoryRuntimeIdentity(tempDir);

      expect(identity.isDirty).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a normalized unavailable identity outside a git checkout", async () => {
    const tempDir = await createTempDir("symphony-runtime-identity-plain-");

    try {
      const identity = await collectFactoryRuntimeIdentity(tempDir);

      expect(identity).toMatchObject({
        checkoutPath: tempDir,
        headSha: null,
        committedAt: null,
        isDirty: null,
        source: "not-a-git-checkout",
      });
      expect(renderFactoryRuntimeIdentity(identity)).toContain("unavailable");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
