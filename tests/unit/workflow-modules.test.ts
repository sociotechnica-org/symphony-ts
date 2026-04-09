import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPromptBuilder,
  loadWorkflow,
  loadWorkflowInstancePaths,
} from "../../src/config/workflow.js";
import { createTempDir } from "../support/git.js";

function buildWorkflow(
  frontMatter: string,
  promptBody = "Prompt body",
): string {
  return `---
${frontMatter}
---
${promptBody}
`;
}

function buildSharedWorkflowSections(): string {
  return `polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    backoff_ms: 10
workspace:
  root: ./.tmp/ws
  repo_url: git@example.com:repo.git
  branch_prefix: symphony/
hooks:
  after_create:
    - git fetch origin
agent:
  runner:
    kind: codex
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000`;
}

describe("workflow module seams", () => {
  it("loads workflow definitions through the public facade and trims the prompt body", async () => {
    const dir = await createTempDir("workflow-loader-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  repo: sociotechnica-org/symphony-ts
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
${buildSharedWorkflowSections()}`,
        "\nPrompt body from source loader\n\n",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);

    expect(workflow.promptTemplate).toBe("Prompt body from source loader");
    expect(workflow.config.workspace.root).toBe(path.join(dir, ".tmp", "ws"));
  });

  it("loads instance paths without requiring the full workflow config to resolve", async () => {
    const dir = await createTempDir("workflow-instance-paths-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(`workspace:
  root: ./.tmp/ws`),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrow("tracker.repo");
    await expect(
      loadWorkflowInstancePaths(workflowPath),
    ).resolves.toMatchObject({
      instanceRoot: dir,
      workspaceRoot: path.join(dir, ".tmp", "ws"),
    });
  });

  it("redacts prompt-visible config in the dedicated prompt builder module", async () => {
    const dir = await createTempDir("workflow-prompt-builder-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-secret
  project_slug: symphony
${buildSharedWorkflowSections()}`,
        "Tracker key {{ config.tracker.apiKey }}",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    const promptBuilder = createPromptBuilder(workflow);
    const rendered = await promptBuilder.build({
      issue: {
        id: "1",
        identifier: "SYM-1",
        number: 1,
        title: "Test issue",
        description: "Prompt builder seam test",
        labels: [],
        state: "open",
        url: "https://example.test/issues/1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        queuePriority: null,
      },
      attempt: null,
      pullRequest: null,
    });

    expect(rendered).toContain("Tracker key [redacted]");
    expect(rendered).not.toContain("linear-secret");
  });
});
