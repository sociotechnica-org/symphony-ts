import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPromptBuilder,
  loadWorkflow,
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
    max_follow_up_attempts: 3
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
    FOO: bar`;
}

describe("workflow config", () => {
  it("loads workflow config and renders prompt strictly", async () => {
    const dir = await createTempDir("workflow-");
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
  review_bot_logins:
    - greptile[bot]
${buildSharedWorkflowSections()}`,
        "Issue {{ issue.identifier }} / {{ config.tracker.repo }}",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.workspace.root).toContain(
      `${path.sep}.tmp${path.sep}ws`,
    );
    expect(workflow.config.tracker.kind).toBe("github-bootstrap");
    expect(workflow.config.polling.retry.maxAttempts).toBe(2);
    expect(workflow.config.polling.retry.maxFollowUpAttempts).toBe(3);
    const promptBuilder = createPromptBuilder(workflow);
    const rendered = await promptBuilder.build({
      issue: {
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
      attempt: null,
      pullRequest: null,
    });
    expect(rendered).toContain("repo#1");
    expect(rendered).toContain("sociotechnica-org/symphony-ts");
  });

  it("loads a valid linear workflow with upstream defaults", async () => {
    const dir = await createTempDir("workflow-linear-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-token
  project_slug: team-project
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.tracker).toEqual({
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "team-project",
      assignee: null,
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
    });
  });

  it("loads a linear workflow token and assignee from env-backed values", async () => {
    const dir = await createTempDir("workflow-linear-env-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousApiKey = process.env.LINEAR_API_KEY;
    const previousWorker = process.env.LINEAR_WORKER;

    process.env.LINEAR_API_KEY = "env-linear-token";
    process.env.LINEAR_WORKER = "worker@example.com";

    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: $MISSING_LINEAR_SECRET
  project_slug: team-project
  assignee: $LINEAR_WORKER
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    try {
      const workflow = await loadWorkflow(workflowPath);
      if (workflow.config.tracker.kind !== "linear") {
        throw new Error("expected linear tracker config");
      }

      expect(workflow.config.tracker.apiKey).toBe("env-linear-token");
      expect(workflow.config.tracker.assignee).toBe("worker@example.com");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = previousApiKey;
      }
      if (previousWorker === undefined) {
        delete process.env.LINEAR_WORKER;
      } else {
        process.env.LINEAR_WORKER = previousWorker;
      }
    }
  });

  it("fails clearly when tracker.kind is unsupported", async () => {
    const dir = await createTempDir("workflow-unsupported-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear-preview
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Unsupported tracker.kind 'linear-preview'. Supported kinds: github-bootstrap, linear",
    );
  });

  it("fails clearly when a linear workflow is missing a token", async () => {
    const dir = await createTempDir("workflow-linear-missing-token-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  project_slug: team-project
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    try {
      await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
        "Linear tracker requires tracker.api_key or LINEAR_API_KEY",
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = previousApiKey;
      }
    }
  });

  it("fails clearly when a linear workflow is missing project scope", async () => {
    const dir = await createTempDir("workflow-linear-missing-project-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-token
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Linear tracker requires tracker.project_slug",
    );
  });

  it("fails clearly when linear state lists are malformed", async () => {
    const dir = await createTempDir("workflow-linear-bad-states-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-token
  project_slug: team-project
  active_states: not-a-list
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Expected string array for tracker.active_states",
    );
  });
});
