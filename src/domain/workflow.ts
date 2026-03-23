import path from "node:path";
import type { RuntimeIssue } from "./issue.js";
import type { HandoffLifecycle } from "./handoff.js";

export interface QueuePriorityConfig {
  readonly enabled: boolean;
}

export interface GitHubQueuePriorityConfig extends QueuePriorityConfig {
  readonly projectNumber?: number | undefined;
  readonly fieldName?: string | undefined;
  readonly optionRankMap?: Readonly<Record<string, number>> | undefined;
}

export interface WatchdogConfig {
  readonly enabled: boolean;
  readonly checkIntervalMs: number;
  readonly stallThresholdMs: number;
  readonly maxRecoveryAttempts: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

interface BaseGitHubTrackerConfig {
  readonly repo: string;
  readonly apiUrl: string;
  readonly readyLabel: string;
  readonly runningLabel: string;
  readonly failedLabel: string;
  readonly successComment: string;
  readonly reviewBotLogins: readonly string[];
  readonly approvedReviewBotLogins?: readonly string[] | undefined;
  readonly queuePriority?: GitHubQueuePriorityConfig | undefined;
}

export interface GitHubTrackerConfig extends BaseGitHubTrackerConfig {
  readonly kind: "github";
}

export interface GitHubBootstrapTrackerConfig extends BaseGitHubTrackerConfig {
  readonly kind: "github-bootstrap";
}

export type GitHubCompatibleTrackerConfig =
  | GitHubTrackerConfig
  | GitHubBootstrapTrackerConfig;

export interface LinearTrackerConfig {
  readonly kind: "linear";
  readonly endpoint: string;
  readonly apiKey: string;
  readonly projectSlug: string;
  readonly assignee: string | null;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly queuePriority?: QueuePriorityConfig | undefined;
}

export type TrackerConfig =
  | GitHubTrackerConfig
  | GitHubBootstrapTrackerConfig
  | LinearTrackerConfig;

export interface PollingConfig {
  readonly intervalMs: number;
  readonly maxConcurrentRuns: number;
  readonly retry: RetryPolicy;
  readonly watchdog?: WatchdogConfig;
}

export interface WorkspaceConfig {
  readonly root: string;
  readonly repoUrl: string;
  readonly branchPrefix: string;
  readonly retention: WorkspaceRetentionPolicy;
  readonly workerHosts?: Readonly<Record<string, SshWorkerHostConfig>>;
}

export type WorkspaceRetentionMode = "delete" | "retain";

export interface WorkspaceRetentionPolicy {
  readonly onSuccess: WorkspaceRetentionMode;
  readonly onFailure: WorkspaceRetentionMode;
}

export interface HooksConfig {
  readonly afterCreate: readonly string[];
}

export interface CodexRunnerConfig {
  readonly kind: "codex";
  readonly remoteExecution?: CodexRemoteExecutionConfig | undefined;
}

export interface SshWorkerHostConfig {
  readonly name: string;
  readonly sshDestination: string;
  readonly sshExecutable: string;
  readonly sshOptions: readonly string[];
  readonly workspaceRoot: string;
}

export interface CodexSshRemoteExecutionConfig {
  readonly kind: "ssh";
  readonly workerHostNames: readonly string[];
  readonly workerHosts: readonly SshWorkerHostConfig[];
}

export type CodexRemoteExecutionConfig = CodexSshRemoteExecutionConfig;

export interface GenericCommandRunnerConfig {
  readonly kind: "generic-command";
  readonly provider?: string | null;
  readonly model?: string | null;
}

export interface ClaudeCodeRunnerConfig {
  readonly kind: "claude-code";
}

export type AgentRunnerConfig =
  | CodexRunnerConfig
  | GenericCommandRunnerConfig
  | ClaudeCodeRunnerConfig;

export interface AgentConfig {
  readonly runner: AgentRunnerConfig;
  readonly command: string;
  readonly promptTransport: "stdin" | "file";
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface ObservabilityConfig {
  readonly dashboardEnabled: boolean;
  readonly refreshMs: number;
  readonly renderIntervalMs: number;
}

export interface RuntimeInstancePaths {
  readonly instanceRoot: string;
  readonly workflowRoot: string;
  readonly tempRoot: string;
  readonly varRoot: string;
  readonly runtimeRoot: string;
  readonly runtimeWorkflowPath: string;
  readonly workspaceRoot: string;
  readonly statusFilePath: string;
  readonly startupFilePath: string;
  readonly githubMirrorPath: string;
  readonly factoryArtifactsRoot: string;
  readonly issueArtifactsRoot: string;
  readonly reportsRoot: string;
  readonly issueReportsRoot: string;
  readonly campaignReportsRoot: string;
}

export type RuntimeInstanceInput = RuntimeInstancePaths | string;

export interface ResolvedConfig {
  readonly workflowPath: string;
  readonly instance: RuntimeInstancePaths;
  readonly tracker: TrackerConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
  readonly observability: ObservabilityConfig;
}

export interface WorkflowDefinition {
  readonly config: ResolvedConfig;
  readonly promptTemplate: string;
}

export function deriveInstanceRootFromWorkflowPath(
  workflowPath: string,
): string {
  const resolvedWorkflowPath = path.resolve(workflowPath);
  const workflowRoot = path.dirname(resolvedWorkflowPath);
  if (
    path.basename(resolvedWorkflowPath) === "WORKFLOW.md" &&
    path.basename(workflowRoot) === "factory-main" &&
    path.basename(path.dirname(workflowRoot)) === ".tmp"
  ) {
    return path.dirname(path.dirname(workflowRoot));
  }
  return workflowRoot;
}

export function deriveRuntimeInstancePaths(args: {
  readonly workflowPath: string;
  readonly workspaceRoot: string;
}): RuntimeInstancePaths {
  const resolvedWorkflowPath = path.resolve(args.workflowPath);
  const workflowRoot = path.dirname(resolvedWorkflowPath);
  const instanceRoot = deriveInstanceRootFromWorkflowPath(resolvedWorkflowPath);
  const tempRoot = path.join(instanceRoot, ".tmp");
  const varRoot = path.join(instanceRoot, ".var");
  const runtimeRoot = path.join(tempRoot, "factory-main");
  const reportsRoot = path.join(varRoot, "reports");

  return {
    instanceRoot,
    workflowRoot,
    tempRoot,
    varRoot,
    runtimeRoot,
    runtimeWorkflowPath: path.join(runtimeRoot, "WORKFLOW.md"),
    workspaceRoot: path.resolve(args.workspaceRoot),
    statusFilePath: path.join(tempRoot, "status.json"),
    startupFilePath: path.join(tempRoot, "startup.json"),
    githubMirrorPath: path.join(tempRoot, "github", "upstream"),
    factoryArtifactsRoot: path.join(varRoot, "factory"),
    issueArtifactsRoot: path.join(varRoot, "factory", "issues"),
    reportsRoot,
    issueReportsRoot: path.join(reportsRoot, "issues"),
    campaignReportsRoot: path.join(reportsRoot, "campaigns"),
  };
}

export function coerceRuntimeInstancePaths(
  input: RuntimeInstanceInput,
): RuntimeInstancePaths {
  if (typeof input !== "string") {
    return input;
  }

  const workspaceRoot = path.resolve(input);
  let current = workspaceRoot;
  let instanceRoot = path.dirname(workspaceRoot);

  for (;;) {
    const parent = path.dirname(current);
    if (path.basename(parent) === ".tmp") {
      instanceRoot = path.dirname(parent);
      break;
    }
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return deriveRuntimeInstancePaths({
    workflowPath: path.join(instanceRoot, "WORKFLOW.md"),
    workspaceRoot,
  });
}

export function getCodexRemoteWorkerHosts(
  config: ResolvedConfig,
): readonly SshWorkerHostConfig[] {
  const agent = (config as { agent?: unknown }).agent;
  if (
    typeof agent !== "object" ||
    agent === null ||
    !("runner" in agent) ||
    typeof agent.runner !== "object" ||
    agent.runner === null ||
    !("kind" in agent.runner) ||
    agent.runner.kind !== "codex"
  ) {
    return [];
  }
  const runner = agent.runner as {
    remoteExecution?: { workerHosts?: readonly SshWorkerHostConfig[] };
  };
  return "remoteExecution" in agent.runner
    ? (runner.remoteExecution?.workerHosts ?? [])
    : [];
}

export function getCodexRemoteWorkerHost(
  config: ResolvedConfig,
): SshWorkerHostConfig | null {
  return getCodexRemoteWorkerHosts(config)[0] ?? null;
}

export interface PromptBuilder {
  build(input: {
    readonly issue: RuntimeIssue;
    readonly attempt: number | null;
    readonly pullRequest: HandoffLifecycle | null;
  }): Promise<string>;
  buildContinuation(input: {
    readonly issue: RuntimeIssue;
    readonly turnNumber: number;
    readonly maxTurns: number;
    readonly pullRequest: HandoffLifecycle | null;
  }): Promise<string>;
}

export function getConfigInstancePaths(
  config: ResolvedConfig,
): RuntimeInstancePaths {
  const resolvedWorkspaceRoot = path.resolve(config.workspace.root);
  const resolvedWorkflowRoot = path.dirname(path.resolve(config.workflowPath));
  const expectedFromWorkspace = coerceRuntimeInstancePaths(
    resolvedWorkspaceRoot,
  );
  if (
    config.instance.instanceRoot === expectedFromWorkspace.instanceRoot &&
    config.instance.workflowRoot === resolvedWorkflowRoot &&
    config.instance.workspaceRoot === resolvedWorkspaceRoot
  ) {
    return config.instance;
  }
  return expectedFromWorkspace;
}
