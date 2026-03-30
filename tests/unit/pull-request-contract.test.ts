import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderThirdPartyWorkflowTemplate } from "../../src/templates/third-party-workflow.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("pull request contract", () => {
  it("keeps the self-hosting workflow explicit about non-draft pull requests", async () => {
    const workflowBody = await fs.readFile(
      path.join(repoRoot, "WORKFLOW.md"),
      "utf8",
    );

    expect(workflowBody).toContain(
      "ready for review by default, not as a draft",
    );
    expect(workflowBody).toContain(
      "Only use draft mode when repository instructions or explicit issue/prompt policy require it",
    );
  });

  it("keeps the starter workflow template explicit about non-draft pull requests", () => {
    const workflowBody = renderThirdPartyWorkflowTemplate({
      trackerRepo: "acme/widgets",
      runnerKind: "codex",
    });

    expect(workflowBody).toContain(
      "ready for review by default, not as a draft",
    );
    expect(workflowBody).toContain(
      "Only use draft mode when repository instructions or explicit issue/prompt policy require it",
    );
  });
});
