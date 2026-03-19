import { Liquid } from "liquidjs";
import path from "node:path";
import fs from "node:fs/promises";
import * as yaml from "yaml";
import { ConfigError, WorkflowError } from "../domain/errors.js";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { PromptIssueContext } from "../domain/prompt-context.js";
import { parseLocalRunnerCommand } from "../runner/local-command.js";
import {
  buildPromptIssueContext,
  buildPromptPullRequestContext,
} from "../tracker/prompt-context.js";
import type {
  AgentRunnerConfig,
  CodexRemoteExecutionConfig,
  GitHubCompatibleTrackerConfig,
  LinearTrackerConfig,
  ObservabilityConfig,
  PromptBuilder,
  ResolvedConfig,
  SshWorkerHostConfig,
  TrackerConfig,
  WorkspaceRetentionMode,
  WatchdogConfig,
  WorkflowDefinition,
} from "../domain/workflow.js";

interface RawWorkflow {
  readonly tracker?: Record<string, unknown>;
  readonly polling?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly hooks?: Record<string, unknown>;
  readonly agent?: Record<string, unknown>;
  readonly observability?: Record<string, unknown>;
}

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_WORKSPACE_RETENTION = {
  onSuccess: "delete",
  onFailure: "retain",
} as const satisfies Record<string, WorkspaceRetentionMode>;
const DEFAULT_LINEAR_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;
const DEFAULT_DISABLED_WATCHDOG_CONFIG: Omit<WatchdogConfig, "enabled"> = {
  checkIntervalMs: 60_000,
  stallThresholdMs: 300_000,
  maxRecoveryAttempts: 2,
};
const SUPPORTED_TRACKER_KINDS = [
  "github",
  "github-bootstrap",
  "linear",
] as const;
const SUPPORTED_AGENT_RUNNER_KINDS = [
  "codex",
  "generic-command",
  "claude-code",
] as const;
type SupportedTrackerKind = (typeof SUPPORTED_TRACKER_KINDS)[number];
type SupportedAgentRunnerKind = (typeof SUPPORTED_AGENT_RUNNER_KINDS)[number];

interface PromptRenderInput {
  readonly issue: PromptIssueContext;
  readonly attempt: number | null;
  readonly pullRequest: ReturnType<typeof buildPromptPullRequestContext>;
  readonly config: ResolvedConfig;
}

interface ContinuationPromptRenderInput {
  readonly issue: {
    readonly identifier: string;
  };
  readonly turnNumber: number;
  readonly maxTurns: number;
  readonly pullRequest: HandoffLifecycle | null;
}

interface ParsedWorkflow {
  readonly frontMatter: RawWorkflow;
  readonly body: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Expected non-empty string for ${field}`);
  }
  return value.trim();
}

function requireGitHubRepo(value: unknown): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ConfigError(
      `tracker.repo must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new ConfigError(
      "tracker.repo is not set; provide it in WORKFLOW.md or set the SYMPHONY_REPO environment variable",
    );
  }
  return value.trim();
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

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`Expected boolean for ${field}`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new ConfigError(
      `${field} must be one of ${options.map((option) => `'${option}'`).join(", ")}`,
    );
  }
  return value as T;
}

function coerceOptionalObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  // Omitted top-level sections keep the legacy "{}" parsing path, but an
  // explicit YAML null is treated as malformed boundary input and fails early.
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

function isSupportedAgentRunnerKind(
  value: string,
): value is SupportedAgentRunnerKind {
  return (SUPPORTED_AGENT_RUNNER_KINDS as readonly string[]).includes(value);
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

function resolveRepoUrl(
  explicitRepoUrl: unknown,
  derivedRepoUrl: string | undefined,
  envOverrideActive: boolean,
  workflowPath: string,
): string {
  // When SYMPHONY_REPO is set, the derived URL always wins so the factory
  // polls, clones, and pushes to the same repo.
  if (derivedRepoUrl !== undefined && envOverrideActive) {
    if (explicitRepoUrl !== undefined) {
      console.warn(
        `[symphony] SYMPHONY_REPO overrides workspace.repo_url; using ${derivedRepoUrl}`,
      );
    }
    return derivedRepoUrl;
  }

  if (explicitRepoUrl === undefined) {
    if (derivedRepoUrl !== undefined) {
      return derivedRepoUrl;
    }
    const hint = envOverrideActive
      ? " (SYMPHONY_REPO is set but has no effect for this tracker kind)"
      : "";
    throw new ConfigError(
      `workspace.repo_url is required when not using a GitHub-backed tracker${hint}`,
    );
  }

  return resolveWorkspaceRepoUrl(
    requireString(explicitRepoUrl, "workspace.repo_url"),
    workflowPath,
  );
}

function resolveWorkspaceRepoUrl(
  repoUrl: string,
  workflowPath: string,
): string {
  if (isRemoteRepoUrl(repoUrl)) {
    return repoUrl;
  }
  return path.resolve(path.dirname(workflowPath), repoUrl);
}

function isRemoteRepoUrl(repoUrl: string): boolean {
  if (hasUrlScheme(repoUrl)) {
    return true;
  }
  return isScpStyleRepoUrl(repoUrl);
}

function isRemoteExecutionRepoUrl(repoUrl: string): boolean {
  if (isScpStyleRepoUrl(repoUrl)) {
    return true;
  }
  if (!hasUrlScheme(repoUrl)) {
    return false;
  }
  try {
    return new URL(repoUrl).protocol !== "file:";
  } catch {
    return true;
  }
}

function hasUrlScheme(repoUrl: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repoUrl);
}

function isScpStyleRepoUrl(repoUrl: string): boolean {
  return /^[^/\\\s]+@[^:/\\\s]+:.+$/.test(repoUrl);
}

function resolveObservabilityConfig(
  raw: Readonly<Record<string, unknown>>,
): ObservabilityConfig {
  const dashboardEnabled = raw["dashboard_enabled"];
  const refreshMs = raw["refresh_ms"];
  const renderIntervalMs = raw["render_interval_ms"];
  return {
    dashboardEnabled:
      dashboardEnabled === undefined
        ? true
        : dashboardEnabled === false || dashboardEnabled === "false"
          ? false
          : Boolean(dashboardEnabled),
    refreshMs:
      refreshMs === undefined
        ? 1000
        : requireNumber(refreshMs, "observability.refresh_ms"),
    renderIntervalMs:
      renderIntervalMs === undefined
        ? 16
        : requireNumber(renderIntervalMs, "observability.render_interval_ms"),
  };
}

function resolveConfig(raw: RawWorkflow, workflowPath: string): ResolvedConfig {
  const tracker = coerceOptionalObject(raw.tracker, "tracker");
  const polling = coerceOptionalObject(raw.polling, "polling");
  const workspace = coerceOptionalObject(raw.workspace, "workspace");
  const hooks = coerceOptionalObject(raw.hooks, "hooks");
  const agent = coerceOptionalObject(raw.agent, "agent");
  const observabilityRaw = coerceOptionalObject(
    raw.observability,
    "observability",
  );

  // Apply SYMPHONY_REPO env override (GitHub-backed trackers only; ignored by other tracker kinds)
  const rawRepoEnv = process.env["SYMPHONY_REPO"];
  const repoOverride =
    rawRepoEnv !== undefined
      ? requireString(rawRepoEnv, "SYMPHONY_REPO env var")
      : undefined;
  const rawTrackerRepo = tracker["repo"];
  const effectiveTracker =
    repoOverride !== undefined ? { ...tracker, repo: repoOverride } : tracker;

  if (
    repoOverride !== undefined &&
    typeof rawTrackerRepo === "string" &&
    rawTrackerRepo.trim() !== repoOverride
  ) {
    console.warn(
      `[symphony] SYMPHONY_REPO="${repoOverride}" overrides tracker.repo="${rawTrackerRepo.trim()}" from WORKFLOW.md`,
    );
  }

  const resolvedTracker = resolveTrackerConfig(effectiveTracker);

  if (repoOverride !== undefined && !isGitHubTrackerConfig(resolvedTracker)) {
    console.warn(
      `[symphony] SYMPHONY_REPO is set but ignored for tracker.kind="${resolvedTracker.kind}"`,
    );
  }

  // For GitHub-backed trackers, derive repoUrl and inject GITHUB_REPO.
  let derivedRepoUrl: string | undefined;
  let repo: string | undefined;
  if (isGitHubTrackerConfig(resolvedTracker)) {
    repo = resolvedTracker.repo;
    try {
      const gitHost = new URL(resolvedTracker.apiUrl).hostname.replace(
        /^api\./,
        "",
      );
      derivedRepoUrl = `git@${gitHost}:${repo}.git`;
    } catch {
      throw new ConfigError(
        `tracker.api_url is not a valid URL: ${resolvedTracker.apiUrl}`,
      );
    }
  }

  const resolvedPolling = {
    intervalMs: requireNumber(polling["interval_ms"], "polling.interval_ms"),
    maxConcurrentRuns: requireNumber(
      polling["max_concurrent_runs"],
      "polling.max_concurrent_runs",
    ),
    retry: resolveRetryConfig(polling["retry"]),
  };
  const resolvedWatchdog = resolveWatchdogConfig(polling["watchdog"]);
  const agentCommand = requireString(agent["command"], "agent.command");
  const resolvedWorkspace = {
    root: path.resolve(
      path.dirname(workflowPath),
      requireString(workspace["root"], "workspace.root"),
    ),
    repoUrl: resolveRepoUrl(
      workspace["repo_url"],
      derivedRepoUrl,
      repoOverride !== undefined,
      workflowPath,
    ),
    branchPrefix: requireString(
      workspace["branch_prefix"],
      "workspace.branch_prefix",
    ),
    retention: resolveWorkspaceRetentionPolicy(workspace),
    workerHosts: resolveWorkerHostsConfig(workspace["worker_hosts"]),
  } as const;
  const resolvedRunner = resolveAgentRunnerConfig(
    agent,
    agentCommand,
    resolvedWorkspace.workerHosts,
  );

  const resolved: ResolvedConfig = {
    workflowPath,
    tracker: resolvedTracker,
    polling:
      resolvedWatchdog === undefined
        ? resolvedPolling
        : {
            ...resolvedPolling,
            watchdog: resolvedWatchdog,
          },
    workspace: resolvedWorkspace,
    hooks: {
      afterCreate:
        hooks["after_create"] === undefined
          ? []
          : requireStringArray(hooks["after_create"], "hooks.after_create"),
    },
    agent: {
      runner: resolvedRunner,
      command: agentCommand,
      promptTransport: requireString(
        agent["prompt_transport"],
        "agent.prompt_transport",
      ) as "stdin" | "file",
      timeoutMs: requireNumber(agent["timeout_ms"], "agent.timeout_ms"),
      maxTurns:
        agent["max_turns"] === undefined
          ? 1
          : requireNumber(agent["max_turns"], "agent.max_turns"),
      env: {
        ...Object.fromEntries(
          Object.entries((agent["env"] ?? {}) as Record<string, unknown>).map(
            ([key, value]) => [key, String(value)],
          ),
        ),
        ...(repo !== undefined ? { GITHUB_REPO: repo } : {}),
      },
    },
    observability: resolveObservabilityConfig(observabilityRaw),
  };

  if (!["stdin", "file"].includes(resolved.agent.promptTransport)) {
    throw new ConfigError("agent.prompt_transport must be 'stdin' or 'file'");
  }
  if (
    !Number.isInteger(resolved.agent.maxTurns) ||
    resolved.agent.maxTurns < 1
  ) {
    throw new ConfigError("agent.max_turns must be an integer >= 1");
  }

  if (resolved.polling.maxConcurrentRuns < 1) {
    throw new ConfigError("polling.max_concurrent_runs must be >= 1");
  }

  if (resolved.polling.retry.maxAttempts < 1) {
    throw new ConfigError("polling.retry.max_attempts must be >= 1");
  }
  validateRemoteExecutionConfig(resolved);
  return resolved;
}

function resolveWorkspaceRetentionPolicy(
  workspace: Readonly<Record<string, unknown>>,
) {
  const rawRetention = workspace["retention"];
  const retention =
    rawRetention === undefined
      ? {}
      : coerceOptionalObject(rawRetention, "workspace.retention");
  const legacyCleanupOnSuccess = workspace["cleanup_on_success"];
  const onSuccess =
    retention["on_success"] === undefined
      ? legacyCleanupOnSuccess === undefined
        ? DEFAULT_WORKSPACE_RETENTION.onSuccess
        : requireBoolean(legacyCleanupOnSuccess, "workspace.cleanup_on_success")
          ? "delete"
          : "retain"
      : requireEnum(
          retention["on_success"],
          ["delete", "retain"],
          "workspace.retention.on_success",
        );
  const onFailure =
    retention["on_failure"] === undefined
      ? DEFAULT_WORKSPACE_RETENTION.onFailure
      : requireEnum(
          retention["on_failure"],
          ["delete", "retain"],
          "workspace.retention.on_failure",
        );
  return {
    onSuccess,
    onFailure,
  } as const;
}

function resolveWorkerHostsConfig(
  raw: unknown,
): Readonly<Record<string, SshWorkerHostConfig>> {
  if (raw === undefined) {
    return {};
  }

  const workerHosts = coerceOptionalObject(raw, "workspace.worker_hosts");
  const resolved = Object.entries(workerHosts).map(([name, value]) => {
    const workerHost = coerceOptionalObject(
      value,
      `workspace.worker_hosts.${name}`,
    );
    return [
      name,
      {
        name,
        sshDestination: requireString(
          workerHost["ssh_destination"],
          `workspace.worker_hosts.${name}.ssh_destination`,
        ),
        sshExecutable:
          requireOptionalString(
            workerHost["ssh_executable"],
            `workspace.worker_hosts.${name}.ssh_executable`,
          ) ?? "ssh",
        sshOptions:
          workerHost["ssh_options"] === undefined
            ? []
            : requireStringArray(
                workerHost["ssh_options"],
                `workspace.worker_hosts.${name}.ssh_options`,
              ),
        workspaceRoot: requireString(
          workerHost["workspace_root"],
          `workspace.worker_hosts.${name}.workspace_root`,
        ),
      } satisfies SshWorkerHostConfig,
    ] as const;
  });

  return Object.fromEntries(resolved);
}

function resolveAgentRunnerConfig(
  agent: Readonly<Record<string, unknown>>,
  command: string,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): AgentRunnerConfig {
  const rawRunner = agent["runner"];

  if (rawRunner === undefined) {
    return inferAgentRunnerConfig(command);
  }

  const runner = coerceOptionalObject(rawRunner, "agent.runner");
  const kind = requireString(runner["kind"], "agent.runner.kind");
  if (!isSupportedAgentRunnerKind(kind)) {
    throw new ConfigError(
      `Unsupported agent.runner.kind '${kind}'. Supported kinds: ${SUPPORTED_AGENT_RUNNER_KINDS.join(", ")}`,
    );
  }

  validateExplicitAgentRunnerKind(kind, command);

  switch (kind) {
    case "codex":
      return resolveCodexRunnerConfig(runner, workerHosts);
    case "generic-command":
      return resolveGenericCommandRunnerConfig(runner);
    case "claude-code":
      return { kind: "claude-code" };
    default:
      return exhaustiveAgentRunnerKind(kind);
  }
}

function resolveCodexRunnerConfig(
  runner: Readonly<Record<string, unknown>>,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): AgentRunnerConfig {
  const remoteExecution = resolveCodexRemoteExecutionConfig(
    runner["remote_execution"],
    workerHosts,
  );
  if (remoteExecution === undefined) {
    return { kind: "codex" };
  }
  return {
    kind: "codex",
    remoteExecution,
  };
}

function resolveCodexRemoteExecutionConfig(
  raw: unknown,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): CodexRemoteExecutionConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const remoteExecution = coerceOptionalObject(
    raw,
    "agent.runner.remote_execution",
  );
  const kind = requireEnum(
    remoteExecution["kind"],
    ["ssh"],
    "agent.runner.remote_execution.kind",
  );
  const workerHostNames = resolveRemoteExecutionWorkerHostNames(
    remoteExecution,
    workerHosts,
  );
  return {
    kind,
    workerHostNames,
    workerHosts: workerHostNames.map(
      (workerHostName) => workerHosts[workerHostName]!,
    ),
  };
}

function resolveRemoteExecutionWorkerHostNames(
  remoteExecution: Readonly<Record<string, unknown>>,
  workerHosts: Readonly<Record<string, SshWorkerHostConfig>>,
): readonly string[] {
  const workerHostNamesRaw = remoteExecution["worker_hosts"];
  if (workerHostNamesRaw !== undefined) {
    const workerHostNames = requireStringArray(
      workerHostNamesRaw,
      "agent.runner.remote_execution.worker_hosts",
    );
    if (workerHostNames.length === 0) {
      throw new ConfigError(
        "agent.runner.remote_execution.worker_hosts must contain at least one worker host",
      );
    }
    const uniqueWorkerHostNames = [...new Set(workerHostNames)];
    for (const workerHostName of uniqueWorkerHostNames) {
      if (workerHosts[workerHostName] === undefined) {
        throw new ConfigError(
          `agent.runner.remote_execution.worker_hosts contains undefined worker host '${workerHostName}'`,
        );
      }
    }
    return uniqueWorkerHostNames;
  }

  const workerHostName = requireString(
    remoteExecution["worker_host"],
    "agent.runner.remote_execution.worker_host",
  );
  if (workerHosts[workerHostName] === undefined) {
    throw new ConfigError(
      `agent.runner.remote_execution.worker_host '${workerHostName}' is not defined in workspace.worker_hosts`,
    );
  }
  return [workerHostName];
}

function inferAgentRunnerConfig(command: string): AgentRunnerConfig {
  const executable = parseLocalRunnerCommand(command).executable;

  if (executable !== null && path.basename(executable) === "codex") {
    return { kind: "codex" };
  }

  return {
    kind: "generic-command",
  };
}

function resolveGenericCommandRunnerConfig(
  runner: Readonly<Record<string, unknown>>,
): AgentRunnerConfig {
  const provider = requireOptionalString(
    runner["provider"],
    "agent.runner.provider",
  );
  const model = requireOptionalString(runner["model"], "agent.runner.model");

  return {
    kind: "generic-command",
    ...(provider === null ? {} : { provider }),
    ...(model === null ? {} : { model }),
  };
}

function validateExplicitAgentRunnerKind(
  kind: SupportedAgentRunnerKind,
  command: string,
): void {
  const requiredExecutable =
    kind === "codex" ? "codex" : kind === "claude-code" ? "claude" : null;
  if (requiredExecutable === null) {
    return;
  }

  const executable = parseLocalRunnerCommand(command).executable;
  if (executable === null) {
    throw new ConfigError(
      `agent.runner.kind '${kind}' requires agent.command to invoke the ${requiredExecutable} CLI, but no executable could be determined from the command`,
    );
  }

  if (path.basename(executable) === requiredExecutable) {
    return;
  }

  throw new ConfigError(
    `agent.runner.kind '${kind}' requires agent.command to invoke the ${requiredExecutable} CLI`,
  );
}

function validateRemoteExecutionConfig(config: ResolvedConfig): void {
  if (config.agent.runner.kind !== "codex") {
    return;
  }

  const remoteExecution = config.agent.runner.remoteExecution;
  if (remoteExecution === undefined) {
    return;
  }

  if (!isRemoteExecutionRepoUrl(config.workspace.repoUrl)) {
    throw new ConfigError(
      "workspace.repo_url must be a remote clone URL when agent.runner.remote_execution is enabled",
    );
  }

  if (config.agent.promptTransport !== "stdin") {
    throw new ConfigError(
      "agent.prompt_transport must be 'stdin' for Codex SSH remote execution",
    );
  }
}

function exhaustiveAgentRunnerKind(value: never): never {
  throw new ConfigError(`Unsupported agent.runner.kind '${String(value)}'`);
}

function resolveTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): TrackerConfig {
  const kind = resolveTrackerKind(tracker);
  switch (kind) {
    case "github":
      return resolveGitHubTrackerConfig("github", tracker);
    case "github-bootstrap":
      return resolveGitHubTrackerConfig("github-bootstrap", tracker);
    case "linear":
      return resolveLinearTrackerConfig(tracker);
    default:
      return exhaustiveTrackerConfig(kind);
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

function resolveGitHubTrackerConfig<
  TKind extends GitHubCompatibleTrackerConfig["kind"],
>(
  kind: TKind,
  tracker: Readonly<Record<string, unknown>>,
): Extract<GitHubCompatibleTrackerConfig, { readonly kind: TKind }> {
  return {
    kind,
    repo: requireGitHubRepo(tracker["repo"]),
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
  } as Extract<GitHubCompatibleTrackerConfig, { readonly kind: TKind }>;
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
  readonly backoffMs: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for polling.retry");
  }

  const retry = value as Record<string, unknown>;
  if (Object.hasOwn(retry, "max_follow_up_attempts")) {
    throw new ConfigError(
      "polling.retry.max_follow_up_attempts is no longer supported; review and rework continuation is now tracker-driven",
    );
  }
  return {
    maxAttempts: requireNumber(
      retry["max_attempts"],
      "polling.retry.max_attempts",
    ),
    backoffMs: requireNumber(retry["backoff_ms"], "polling.retry.backoff_ms"),
  };
}

function resolveWatchdogConfig(value: unknown): WatchdogConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Expected object for polling.watchdog");
  }

  const watchdog = value as Record<string, unknown>;
  const enabled =
    watchdog["enabled"] === undefined
      ? true
      : requireBoolean(watchdog["enabled"], "polling.watchdog.enabled");
  const checkIntervalMs = requireOptionalPositiveInteger(
    watchdog["check_interval_ms"],
    "polling.watchdog.check_interval_ms",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.checkIntervalMs,
  );
  const stallThresholdMs = requireOptionalPositiveInteger(
    watchdog["stall_threshold_ms"],
    "polling.watchdog.stall_threshold_ms",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.stallThresholdMs,
  );
  const maxRecoveryAttempts = requireOptionalRecoveryAttempts(
    watchdog["max_recovery_attempts"],
    "polling.watchdog.max_recovery_attempts",
    enabled ? undefined : DEFAULT_DISABLED_WATCHDOG_CONFIG.maxRecoveryAttempts,
  );

  return {
    enabled,
    checkIntervalMs,
    stallThresholdMs,
    maxRecoveryAttempts,
  };
}

function requireOptionalPositiveInteger(
  value: unknown,
  field: string,
  fallback: number | undefined,
): number {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new ConfigError(`Expected number for ${field}`);
    }
    return fallback;
  }

  const resolved = requireNumber(value, field);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ConfigError(`${field} must be an integer > 0`);
  }
  return resolved;
}

function requireOptionalRecoveryAttempts(
  value: unknown,
  field: string,
  fallback: number | undefined,
): number {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new ConfigError(`Expected number for ${field}`);
    }
    return fallback;
  }

  const resolved = requireNumber(value, field);
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new ConfigError(`${field} must be an integer >= 0`);
  }
  return resolved;
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
  const workspace = coerceOptionalObject(
    parsed.frontMatter.workspace,
    "workspace",
  );
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
    case "github":
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

function isGitHubTrackerConfig(
  tracker: TrackerConfig,
): tracker is GitHubCompatibleTrackerConfig {
  return tracker.kind === "github" || tracker.kind === "github-bootstrap";
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

function renderContinuationPrompt(
  input: ContinuationPromptRenderInput,
): string {
  const lines = [
    "Continuation guidance:",
    "",
    "- The previous turn completed normally, but the issue is still in an active state.",
    `- This is continuation turn #${input.turnNumber.toString()} of ${input.maxTurns.toString()} for the current agent run.`,
    "- Resume from the current workspace state instead of restarting from scratch.",
    "- If your runner preserves prior thread history, use it. Otherwise, restate only the minimum missing context you need before acting.",
  ];
  if (input.pullRequest !== null) {
    lines.push(
      `- Current tracker handoff lifecycle: ${input.pullRequest.kind}.`,
    );
    lines.push(`- Current tracker summary: ${input.pullRequest.summary}`);
  }
  lines.push(
    "- Focus on the remaining issue work and only end the turn early if you are truly blocked.",
  );
  return lines.join("\n");
}

export function createPromptBuilder(
  definition: WorkflowDefinition,
): PromptBuilder {
  return {
    async build(input): Promise<string> {
      return await renderPromptTemplate(definition, {
        issue: buildPromptIssueContext(input.issue, definition.config.tracker),
        attempt: input.attempt,
        pullRequest: buildPromptPullRequestContext(input.pullRequest),
        config: definition.config,
      });
    },
    buildContinuation(input): Promise<string> {
      return Promise.resolve(
        renderContinuationPrompt({
          issue: input.issue,
          turnNumber: input.turnNumber,
          maxTurns: input.maxTurns,
          pullRequest: input.pullRequest,
        }),
      );
    },
  };
}
