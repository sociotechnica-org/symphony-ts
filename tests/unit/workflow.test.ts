import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  runner:
    kind: codex
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000
  env:
    FOO: bar`;
}

describe("workflow config", () => {
  const savedSymphonyRepo = process.env["SYMPHONY_REPO"];
  beforeEach(() => {
    delete process.env["SYMPHONY_REPO"];
  });
  afterEach(() => {
    if (savedSymphonyRepo !== undefined) {
      process.env["SYMPHONY_REPO"] = savedSymphonyRepo;
    } else {
      delete process.env["SYMPHONY_REPO"];
    }
  });

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
    expect(workflow.config.polling.watchdog).toBeUndefined();
    expect(workflow.config.agent.runner.kind).toBe("codex");
    expect(workflow.config.agent.maxTurns).toBe(1);
    expect(workflow.config.agent.env["GITHUB_REPO"]).toBe(
      "sociotechnica-org/symphony-ts",
    );
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

  it("renders continuation guidance separately from the workflow template", async () => {
    const dir = await createTempDir("workflow-continuation-");
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
polling:
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
  runner:
    kind: codex
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000
  max_turns: 4
  env:
    FOO: bar`,
        "Issue {{ issue.identifier }} / {{ config.tracker.repo }}",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.agent.maxTurns).toBe(4);
    const promptBuilder = createPromptBuilder(workflow);
    const rendered = await promptBuilder.buildContinuation({
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
      turnNumber: 2,
      maxTurns: workflow.config.agent.maxTurns,
      pullRequest: null,
    });

    expect(rendered).toContain("Continuation guidance:");
    expect(rendered).toContain("continuation turn #2 of 4");
    expect(rendered).toContain(
      "If your runner preserves prior thread history, use it.",
    );
    expect(rendered).not.toContain("previous Codex turn");
    expect(rendered).not.toContain(
      "Issue repo#1 / sociotechnica-org/symphony-ts",
    );
  });

  it("loads an explicit polling.watchdog block", async () => {
    const dir = await createTempDir("workflow-watchdog-");
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
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 3
    backoff_ms: 10
  watchdog:
    enabled: true
    check_interval_ms: 60000
    stall_threshold_ms: 300000
    max_recovery_attempts: 2
workspace:
  root: ./.tmp/ws
  repo_url: git@example.com:repo.git
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);

    expect(workflow.config.polling.watchdog).toEqual({
      enabled: true,
      checkIntervalMs: 60000,
      stallThresholdMs: 300000,
      maxRecoveryAttempts: 2,
    });
  });

  it("rejects an invalid polling.watchdog block", async () => {
    const dir = await createTempDir("workflow-watchdog-invalid-");
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
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 3
    backoff_ms: 10
  watchdog:
    enabled: true
    check_interval_ms: 60000
    stall_threshold_ms: 300000
    max_recovery_attempts: -1
workspace:
  root: ./.tmp/ws
  repo_url: git@example.com:repo.git
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex exec -
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "polling.watchdog.max_recovery_attempts must be an integer >= 0",
    );
  });

  it("rejects a non-integer agent.max_turns", async () => {
    const dir = await createTempDir("workflow-max-turns-fractional-");
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
${buildSharedWorkflowSections()}
  max_turns: 1.5`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "agent.max_turns must be an integer >= 1",
    );
  });

  it("loads an explicit generic command runner selection", async () => {
    const dir = await createTempDir("workflow-generic-runner-");
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
polling:
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
  after_create: []
agent:
  runner:
    kind: generic-command
  command: claude --print
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);

    expect(workflow.config.agent.runner).toEqual({
      kind: "generic-command",
    });
  });

  it("rejects an unsupported agent.runner.kind", async () => {
    const dir = await createTempDir("workflow-invalid-runner-kind-");
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
polling:
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
  after_create: []
agent:
  runner:
    kind: claude
  command: claude --print
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Unsupported agent.runner.kind 'claude'. Supported kinds: codex, generic-command",
    );
  });

  it("infers a generic command runner when agent.runner is omitted for non-codex commands", async () => {
    const dir = await createTempDir("workflow-inferred-generic-runner-");
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
polling:
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
  after_create: []
agent:
  command: claude --print
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);

    expect(workflow.config.agent.runner).toEqual({
      kind: "generic-command",
    });
  });

  it("infers codex from quoted commands using the shared shell tokenizer", async () => {
    const dir = await createTempDir("workflow-inferred-quoted-codex-runner-");
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
polling:
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
  after_create: []
agent:
  command: "'codex' exec -m gpt-5.4"
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);

    expect(workflow.config.agent.runner).toEqual({
      kind: "codex",
    });
  });

  it("derives workspace.repoUrl from tracker.repo and api_url when repo_url is omitted", async () => {
    const dir = await createTempDir("workflow-derived-url-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  repo: my-org/my-repo
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
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  runner:
    kind: generic-command
  command: echo test
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.workspace.repoUrl).toBe(
      "git@github.com:my-org/my-repo.git",
    );
    expect(workflow.config.agent.env["GITHUB_REPO"]).toBe("my-org/my-repo");
  });

  it("SYMPHONY_REPO overrides tracker.repo and derives repoUrl and GITHUB_REPO", async () => {
    process.env["SYMPHONY_REPO"] = "my-org/my-test-repo";

    const dir = await createTempDir("workflow-override-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
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
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  runner:
    kind: generic-command
  command: echo test
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}`,
        "Repo: {{ config.tracker.repo }}",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.tracker.kind).toBe("github-bootstrap");
    if (workflow.config.tracker.kind === "github-bootstrap") {
      expect(workflow.config.tracker.repo).toBe("my-org/my-test-repo");
    }
    expect(workflow.config.workspace.repoUrl).toBe(
      "git@github.com:my-org/my-test-repo.git",
    );
    expect(workflow.config.agent.env["GITHUB_REPO"]).toBe(
      "my-org/my-test-repo",
    );
  });

  it("SYMPHONY_REPO overrides explicit workspace.repo_url", async () => {
    process.env["SYMPHONY_REPO"] = "my-org/override-repo";

    const dir = await createTempDir("workflow-repo-url-override-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  repo: my-org/original-repo
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workflow = await loadWorkflow(workflowPath);
      expect(workflow.config.workspace.repoUrl).toBe(
        "git@github.com:my-org/override-repo.git",
      );
      expect(workflow.config.agent.env["GITHUB_REPO"]).toBe(
        "my-org/override-repo",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SYMPHONY_REPO overrides workspace.repo_url"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'SYMPHONY_REPO="my-org/override-repo" overrides tracker.repo="my-org/original-repo"',
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws when SYMPHONY_REPO is empty string", async () => {
    process.env["SYMPHONY_REPO"] = "";
    const dir = await createTempDir("workflow-empty-env-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  repo: sociotechnica-org/symphony-ts
  api_url: https://api.github.com
  ready_label: r
  running_label: r
  failed_label: f
  success_comment: done
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );
    await expect(loadWorkflow(workflowPath)).rejects.toThrow(
      "SYMPHONY_REPO env var",
    );
  });

  it("throws with helpful message when neither SYMPHONY_REPO nor tracker.repo is set", async () => {
    const dir = await createTempDir("workflow-no-repo-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  api_url: https://api.github.com
  ready_label: r
  running_label: r
  failed_label: f
  success_comment: done
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );
    await expect(loadWorkflow(workflowPath)).rejects.toThrow("SYMPHONY_REPO");
  });

  it("warns when SYMPHONY_REPO is set with a linear tracker", async () => {
    process.env["SYMPHONY_REPO"] = "my-org/ignored-repo";
    const dir = await createTempDir("workflow-linear-warn-");
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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workflow = await loadWorkflow(workflowPath);
      expect(workflow.config.tracker.kind).toBe("linear");
      expect(workflow.config.agent.env["GITHUB_REPO"]).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'SYMPHONY_REPO is set but ignored for tracker.kind="linear"',
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
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

  it("redacts the linear API key from prompt rendering while preserving the runtime config", async () => {
    const dir = await createTempDir("workflow-linear-redacted-prompt-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-token
  project_slug: team-project
${buildSharedWorkflowSections()}`,
        "token={{ config.tracker.apiKey }}",
      ),
      "utf8",
    );

    const workflow = await loadWorkflow(workflowPath);
    if (workflow.config.tracker.kind !== "linear") {
      throw new Error("expected linear tracker config");
    }

    expect(workflow.config.tracker.apiKey).toBe("linear-token");

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

    expect(rendered).toBe("token=[redacted]");
  });

  it("loads a linear workflow token and assignee from env-backed values", async () => {
    const dir = await createTempDir("workflow-linear-env-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousApiKey = process.env.LINEAR_API_KEY;
    const previousWorker = process.env.LINEAR_WORKER;

    try {
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

  it("does not inherit an assignee filter from ambient env when tracker.assignee is omitted", async () => {
    const dir = await createTempDir("workflow-linear-no-assignee-env-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousAssignee = process.env.LINEAR_ASSIGNEE;

    try {
      process.env.LINEAR_ASSIGNEE = "ambient-worker@example.com";

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
      if (workflow.config.tracker.kind !== "linear") {
        throw new Error("expected linear tracker config");
      }

      expect(workflow.config.tracker.assignee).toBeNull();
    } finally {
      if (previousAssignee === undefined) {
        delete process.env.LINEAR_ASSIGNEE;
      } else {
        process.env.LINEAR_ASSIGNEE = previousAssignee;
      }
    }
  });

  it("treats an explicit unset assignee env reference as no assignee filter", async () => {
    const dir = await createTempDir("workflow-linear-unset-assignee-env-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousUnsetAssignee = process.env.MISSING_LINEAR_ASSIGNEE;

    try {
      delete process.env.MISSING_LINEAR_ASSIGNEE;

      await fs.writeFile(
        workflowPath,
        buildWorkflow(
          `tracker:
  kind: linear
  api_key: linear-token
  project_slug: team-project
  assignee: $MISSING_LINEAR_ASSIGNEE
${buildSharedWorkflowSections()}`,
        ),
        "utf8",
      );

      const workflow = await loadWorkflow(workflowPath);
      if (workflow.config.tracker.kind !== "linear") {
        throw new Error("expected linear tracker config");
      }

      expect(workflow.config.tracker.assignee).toBeNull();
    } finally {
      if (previousUnsetAssignee === undefined) {
        delete process.env.MISSING_LINEAR_ASSIGNEE;
      } else {
        process.env.MISSING_LINEAR_ASSIGNEE = previousUnsetAssignee;
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

  it("fails clearly when tracker.kind is explicitly blank", async () => {
    const dir = await createTempDir("workflow-blank-kind-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind:
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Expected non-empty string for tracker.kind",
    );
  });

  it("fails early when a top-level workflow section is explicitly null", async () => {
    const dir = await createTempDir("workflow-null-tracker-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Expected object for tracker",
    );
  });

  it("fails clearly when a linear workflow is missing a token", async () => {
    const dir = await createTempDir("workflow-linear-missing-token-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const previousApiKey = process.env.LINEAR_API_KEY;

    try {
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

  it("fails clearly when a linear workflow endpoint is not a valid URL", async () => {
    const dir = await createTempDir("workflow-linear-bad-endpoint-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  endpoint: api.linear.app/graphql
  api_key: linear-token
  project_slug: team-project
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "tracker.endpoint must be a valid URL, got 'api.linear.app/graphql'",
    );
  });

  it("fails clearly when a linear workflow endpoint uses an unsupported URL scheme", async () => {
    const dir = await createTempDir("workflow-linear-ftp-endpoint-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  endpoint: ftp://api.linear.app/graphql
  api_key: linear-token
  project_slug: team-project
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "tracker.endpoint must use https:// or http://, got 'ftp://api.linear.app/graphql'",
    );
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

  it("fails clearly when linear state lists are empty", async () => {
    const dir = await createTempDir("workflow-linear-empty-states-");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      buildWorkflow(
        `tracker:
  kind: linear
  api_key: linear-token
  project_slug: team-project
  active_states: []
${buildSharedWorkflowSections()}`,
      ),
      "utf8",
    );

    await expect(loadWorkflow(workflowPath)).rejects.toThrowError(
      "Expected non-empty string array for tracker.active_states",
    );
  });
});
