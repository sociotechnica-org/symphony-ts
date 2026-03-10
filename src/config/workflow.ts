import { Liquid } from "liquidjs";
import path from "node:path";
import fs from "node:fs/promises";
import * as yaml from "yaml";
import { ConfigError, WorkflowError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type {
  GitHubBootstrapTrackerConfig,
  LinearTrackerConfig,
  PromptBuilder,
  ResolvedConfig,
  TrackerConfig,
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

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_LINEAR_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;
const SUPPORTED_TRACKER_KINDS = ["github-bootstrap", "linear"] as const;
type SupportedTrackerKind = (typeof SUPPORTED_TRACKER_KINDS)[number];

interface PromptRenderInput {
  readonly issue: {
    readonly identifier: string;
  };
  readonly attempt: number | null;
  readonly pullRequest: HandoffLifecycle | null;
  readonly config: ResolvedConfig;
}

interface ParsedWorkflow {
  readonly frontMatter: RawWorkflow;
  readonly body: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Expected non-empty string for ${field}`);
  }
  return value;
}

function requireUrlString(value: unknown, field: string): string {
  const resolved = requireString(value, field);
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new ConfigError(`${field} must be a valid URL, got '${resolved}'`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `${field} must use https:// or http://, got '${resolved}'`,
    );
  }
  return resolved;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Expected number for ${field}`);
  }
  return value;
}

function requireObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`Expected string array for ${field}`);
  }
  return value;
}

function requireNonEmptyStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  const items = requireStringArray(value, field);
  if (items.length === 0) {
    throw new ConfigError(`Expected non-empty string array for ${field}`);
  }
  return items;
}

function normalizeSecretValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveEnvReferenceName(value: string): string | null {
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/u);
  return match?.[1] ?? null;
}

function resolveEnvBackedSecret(
  value: unknown,
  field: string,
  fallbackEnvName: string,
): string | null {
  if (value === undefined || value === null) {
    return normalizeSecretValue(process.env[fallbackEnvName]);
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }

  const trimmed = value.trim();
  const referencedEnvName = resolveEnvReferenceName(trimmed);
  if (referencedEnvName === null) {
    return normalizeSecretValue(trimmed);
  }

  // Match the Elixir config seam: an unset explicit env reference falls back
  // to the default env var for this field instead of failing immediately.
  const referencedValue = process.env[referencedEnvName];
  if (referencedValue === undefined) {
    return normalizeSecretValue(process.env[fallbackEnvName]);
  }

  return normalizeSecretValue(referencedValue);
}

function resolveOptionalEnvBackedSecret(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Expected string for ${field}`);
  }

  const trimmed = value.trim();
  const referencedEnvName = resolveEnvReferenceName(trimmed);
  if (referencedEnvName === null) {
    return normalizeSecretValue(trimmed);
  }

  return normalizeSecretValue(process.env[referencedEnvName]);
}

function isSupportedTrackerKind(value: string): value is SupportedTrackerKind {
  return (SUPPORTED_TRACKER_KINDS as readonly string[]).includes(value);
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

async function readWorkflowSource(workflowPath: string): Promise<string> {
  try {
    return await fs.readFile(workflowPath, "utf8");
  } catch (error) {
    throw new WorkflowError(`Failed to read workflow file at ${workflowPath}`, {
      cause: error as Error,
    });
  }
}

async function readParsedWorkflow(
  workflowPath: string,
): Promise<ParsedWorkflow> {
  return parseFrontMatter(await readWorkflowSource(workflowPath));
}

function resolveConfig(raw: RawWorkflow, workflowPath: string): ResolvedConfig {
  const tracker = requireObject(raw.tracker, "tracker");
  const polling = requireObject(raw.polling, "polling");
  const workspace = requireObject(raw.workspace, "workspace");
  const hooks = requireObject(raw.hooks, "hooks");
  const agent = requireObject(raw.agent, "agent");

  const resolved: ResolvedConfig = {
    workflowPath,
    tracker: resolveTrackerConfig(tracker),
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
  if (resolved.polling.retry.maxFollowUpAttempts < 1) {
    throw new ConfigError("polling.retry.max_follow_up_attempts must be >= 1");
  }

  return resolved;
}

function resolveTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): TrackerConfig {
  const kind = resolveTrackerKind(tracker);
  switch (kind) {
    case "github-bootstrap":
      return resolveGitHubBootstrapTrackerConfig(tracker);
    case "linear":
      return resolveLinearTrackerConfig(tracker);
  }
}

function resolveTrackerKind(
  tracker: Readonly<Record<string, unknown>>,
): TrackerConfig["kind"] {
  if (!Object.hasOwn(tracker, "kind")) {
    return "github-bootstrap";
  }

  const value = tracker["kind"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("Expected non-empty string for tracker.kind");
  }

  const normalizedKind = value.trim();
  if (isSupportedTrackerKind(normalizedKind)) {
    return normalizedKind;
  }

  throw new ConfigError(
    `Unsupported tracker.kind '${normalizedKind}'. Supported kinds: ${SUPPORTED_TRACKER_KINDS.join(", ")}`,
  );
}

function resolveGitHubBootstrapTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): GitHubBootstrapTrackerConfig {
  return {
    kind: "github-bootstrap",
    repo: requireString(tracker["repo"], "tracker.repo"),
    apiUrl: requireString(tracker["api_url"], "tracker.api_url"),
    readyLabel: requireString(tracker["ready_label"], "tracker.ready_label"),
    runningLabel: requireString(
      tracker["running_label"],
      "tracker.running_label",
    ),
    failedLabel: requireString(tracker["failed_label"], "tracker.failed_label"),
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
  };
}

function resolveLinearTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): LinearTrackerConfig {
  const apiKey = resolveEnvBackedSecret(
    tracker["api_key"],
    "tracker.api_key",
    "LINEAR_API_KEY",
  );
  if (apiKey === null) {
    throw new ConfigError(
      "Linear tracker requires tracker.api_key or LINEAR_API_KEY",
    );
  }

  const projectSlug = requireOptionalString(
    tracker["project_slug"],
    "tracker.project_slug",
  );
  if (projectSlug === null) {
    throw new ConfigError("Linear tracker requires tracker.project_slug");
  }

  return {
    kind: "linear",
    endpoint:
      tracker["endpoint"] === undefined
        ? DEFAULT_LINEAR_ENDPOINT
        : requireUrlString(tracker["endpoint"], "tracker.endpoint"),
    apiKey,
    projectSlug,
    assignee: resolveOptionalEnvBackedSecret(
      tracker["assignee"],
      "tracker.assignee",
    ),
    activeStates:
      tracker["active_states"] === undefined
        ? DEFAULT_LINEAR_ACTIVE_STATES
        : requireNonEmptyStringArray(
            tracker["active_states"],
            "tracker.active_states",
          ),
    terminalStates:
      tracker["terminal_states"] === undefined
        ? DEFAULT_LINEAR_TERMINAL_STATES
        : requireNonEmptyStringArray(
            tracker["terminal_states"],
            "tracker.terminal_states",
          ),
  };
}

function resolveRetryConfig(value: unknown): {
  readonly maxAttempts: number;
  readonly maxFollowUpAttempts: number;
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
    maxFollowUpAttempts:
      retry["max_follow_up_attempts"] === undefined
        ? requireNumber(retry["max_attempts"], "polling.retry.max_attempts")
        : requireNumber(
            retry["max_follow_up_attempts"],
            "polling.retry.max_follow_up_attempts",
          ),
    backoffMs: requireNumber(retry["backoff_ms"], "polling.retry.backoff_ms"),
  };
}

export async function loadWorkflow(
  workflowPath: string,
): Promise<WorkflowDefinition> {
  const parsed = await readParsedWorkflow(workflowPath);
  return {
    config: resolveConfig(parsed.frontMatter, workflowPath),
    promptTemplate: parsed.body,
  };
}

export async function loadWorkflowWorkspaceRoot(
  workflowPath: string,
): Promise<string> {
  const parsed = await readParsedWorkflow(workflowPath);
  const workspace = requireObject(parsed.frontMatter.workspace, "workspace");
  return path.resolve(
    path.dirname(workflowPath),
    requireString(workspace["root"], "workspace.root"),
  );
}

function exhaustiveTrackerConfig(tracker: never): never {
  throw new ConfigError(
    `Unsupported tracker config '${JSON.stringify(tracker)}'`,
  );
}

function redactTrackerConfig(tracker: TrackerConfig): TrackerConfig {
  switch (tracker.kind) {
    case "github-bootstrap":
      return tracker;
    case "linear":
      return {
        ...tracker,
        apiKey: "[redacted]",
      };
    default:
      return exhaustiveTrackerConfig(tracker);
  }
}

function redactPromptConfig(config: ResolvedConfig): ResolvedConfig {
  return {
    ...config,
    tracker: redactTrackerConfig(config.tracker),
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
      config: redactPromptConfig(input.config),
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
