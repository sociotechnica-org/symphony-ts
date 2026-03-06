import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, renderPrompt } from "../../src/config/workflow.js";
import { createTempDir } from "../support/git.js";

describe("workflow config", () => {
  it("loads workflow config and renders prompt strictly", async () => {
    const dir = await createTempDir("workflow-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      `---
tracker:
  repo: sociotechnica-org/symphony-ts
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    backoff_ms: 10
workspace:
  root: ./.tmp/ws
  repo_url: git@example.com:repo.git
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create:
    - git fetch origin
agent:
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000
  env:
    FOO: bar
---
Issue {{ issue.identifier }} / {{ config.tracker.repo }}`,
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.workspace.root).toContain(
      `${path.sep}.tmp${path.sep}ws`,
    );
    const rendered = await renderPrompt(
      workflow,
      {
        id: "1",
        identifier: "repo#1",
        number: 1,
        title: "T",
        description: "D",
        labels: ["a"],
        state: "open",
        url: "https://example.test/issues/1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
    );
    expect(rendered).toContain("repo#1");
    expect(rendered).toContain("sociotechnica-org/symphony-ts");
  });
});
