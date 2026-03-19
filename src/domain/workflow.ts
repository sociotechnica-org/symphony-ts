import type { RuntimeIssue } from "./issue.js";
import type { HandoffLifecycle } from "./handoff.js";

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

export interface ResolvedConfig {
  readonly workflowPath: string;
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
