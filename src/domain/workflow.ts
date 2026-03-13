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

export interface GitHubBootstrapTrackerConfig {
  readonly kind: "github-bootstrap";
  readonly repo: string;
  readonly apiUrl: string;
  readonly readyLabel: string;
  readonly runningLabel: string;
  readonly failedLabel: string;
  readonly successComment: string;
  readonly reviewBotLogins: readonly string[];
}

export interface LinearTrackerConfig {
  readonly kind: "linear";
  readonly endpoint: string;
  readonly apiKey: string;
  readonly projectSlug: string;
  readonly assignee: string | null;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}

export type TrackerConfig = GitHubBootstrapTrackerConfig | LinearTrackerConfig;

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
  readonly cleanupOnSuccess: boolean;
}

export interface HooksConfig {
  readonly afterCreate: readonly string[];
}

export interface CodexRunnerConfig {
  readonly kind: "codex";
}

export interface GenericCommandRunnerConfig {
  readonly kind: "generic-command";
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

export interface ResolvedConfig {
  readonly workflowPath: string;
  readonly tracker: TrackerConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
}

export interface WorkflowDefinition {
  readonly config: ResolvedConfig;
  readonly promptTemplate: string;
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
