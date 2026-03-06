import { Liquid } from "liquidjs";
import path from "node:path";
import fs from "node:fs/promises";
import * as yaml from "yaml";
import { ConfigError, WorkflowError } from "../domain/errors.js";
import type { PullRequestLifecycle } from "../domain/pull-request.js";
import type {
  PromptBuilder,
  ResolvedConfig,
  WorkflowDefinition,
} from "../domain/workflow.js";

interface RawWorkflow {
  readonly tracker?: Record<string, unknown>;
  readonly polling?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly hooks?: Record<string, unknown>;
  readonly agent?: Record<string, unknown>;
}

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

interface PromptRenderInput {
  readonly issue: {
    readonly identifier: string;
  };
  readonly attempt: number | null;
  readonly pullRequest: PullRequestLifecycle | null;
  readonly config: ResolvedConfig;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Expected non-empty string for ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Expected number for ${field}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`Expected string array for ${field}`);
  }
  return value;
}

function parseFrontMatter(raw: string): {
  readonly frontMatter: RawWorkflow;
  readonly body: string;
} {
  if (!raw.startsWith("---")) {
    throw new WorkflowError(
      "WORKFLOW.md must start with YAML front matter delimited by ---",
    );
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new WorkflowError("Invalid WORKFLOW.md front matter block");
  }

  const frontMatterSource = match[1];
  const bodySource = match[2];
  if (frontMatterSource === undefined || bodySource === undefined) {
    throw new WorkflowError("Invalid WORKFLOW.md front matter block");
  }

  const parsed = yaml.parse(frontMatterSource);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "WORKFLOW.md front matter must be a mapping/object",
    );
  }

  return {
    frontMatter: parsed as RawWorkflow,
    body: bodySource.trim(),
  };
}

function resolveConfig(raw: RawWorkflow, workflowPath: string): ResolvedConfig {
  const tracker = raw.tracker ?? {};
  const polling = raw.polling ?? {};
  const workspace = raw.workspace ?? {};
  const hooks = raw.hooks ?? {};
  const agent = raw.agent ?? {};

  const resolved: ResolvedConfig = {
    workflowPath,
    tracker: {
      kind: "github-bootstrap",
      repo: requireString(tracker["repo"], "tracker.repo"),
      apiUrl: requireString(tracker["api_url"], "tracker.api_url"),
      readyLabel: requireString(tracker["ready_label"], "tracker.ready_label"),
      runningLabel: requireString(
        tracker["running_label"],
        "tracker.running_label",
      ),
      failedLabel: requireString(
        tracker["failed_label"],
        "tracker.failed_label",
      ),
      successComment: requireString(
        tracker["success_comment"],
        "tracker.success_comment",
      ),
      reviewBotLogins:
        tracker["review_bot_logins"] === undefined
          ? []
          : requireStringArray(
              tracker["review_bot_logins"],
              "tracker.review_bot_logins",
            ),
    },
    polling: {
      intervalMs: requireNumber(polling["interval_ms"], "polling.interval_ms"),
      maxConcurrentRuns: requireNumber(
        polling["max_concurrent_runs"],
        "polling.max_concurrent_runs",
      ),
      retry: resolveRetryConfig(polling["retry"]),
    },
    workspace: {
      root: path.resolve(
        path.dirname(workflowPath),
        requireString(workspace["root"], "workspace.root"),
      ),
      repoUrl: requireString(workspace["repo_url"], "workspace.repo_url"),
      branchPrefix: requireString(
        workspace["branch_prefix"],
        "workspace.branch_prefix",
      ),
      cleanupOnSuccess: Boolean(workspace["cleanup_on_success"]),
    },
    hooks: {
      afterCreate:
        hooks["after_create"] === undefined
          ? []
          : requireStringArray(hooks["after_create"], "hooks.after_create"),
    },
    agent: {
      command: requireString(agent["command"], "agent.command"),
      promptTransport: requireString(
        agent["prompt_transport"],
        "agent.prompt_transport",
      ) as "stdin" | "file",
      timeoutMs: requireNumber(agent["timeout_ms"], "agent.timeout_ms"),
      env: Object.fromEntries(
        Object.entries((agent["env"] ?? {}) as Record<string, unknown>).map(
          ([key, value]) => [key, String(value)],
        ),
      ),
    },
  };

  if (!["stdin", "file"].includes(resolved.agent.promptTransport)) {
    throw new ConfigError("agent.prompt_transport must be 'stdin' or 'file'");
  }

  if (resolved.polling.maxConcurrentRuns < 1) {
    throw new ConfigError("polling.max_concurrent_runs must be >= 1");
  }

  if (resolved.polling.retry.maxAttempts < 1) {
    throw new ConfigError("polling.retry.max_attempts must be >= 1");
  }

  return resolved;
}

function resolveRetryConfig(value: unknown): {
  readonly maxAttempts: number;
  readonly backoffMs: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for polling.retry");
  }

  const retry = value as Record<string, unknown>;
  return {
    maxAttempts: requireNumber(
      retry["max_attempts"],
      "polling.retry.max_attempts",
    ),
    backoffMs: requireNumber(retry["backoff_ms"], "polling.retry.backoff_ms"),
  };
}

export async function loadWorkflow(
  workflowPath: string,
): Promise<WorkflowDefinition> {
  let raw: string;
  try {
    raw = await fs.readFile(workflowPath, "utf8");
  } catch (error) {
    throw new WorkflowError(`Failed to read workflow file at ${workflowPath}`, {
      cause: error as Error,
    });
  }

  const parsed = parseFrontMatter(raw);
  return {
    config: resolveConfig(parsed.frontMatter, workflowPath),
    promptTemplate: parsed.body,
  };
}

async function renderPromptTemplate(
  definition: WorkflowDefinition,
  input: PromptRenderInput,
): Promise<string> {
  try {
    return await liquid.parseAndRender(definition.promptTemplate, {
      issue: input.issue,
      attempt: input.attempt,
      pull_request: input.pullRequest,
      config: input.config,
    });
  } catch (error) {
    throw new WorkflowError(
      `Failed to render prompt for ${input.issue.identifier}`,
      {
        cause: error as Error,
      },
    );
  }
}

export function createPromptBuilder(
  definition: WorkflowDefinition,
): PromptBuilder {
  return {
    async build(input): Promise<string> {
      return await renderPromptTemplate(definition, {
        issue: input.issue,
        attempt: input.attempt,
        pullRequest: input.pullRequest,
        config: definition.config,
      });
    },
  };
}
