export interface IssueRef {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

export interface TrackerConfig {
  readonly kind: "github-bootstrap";
  readonly repo: string;
  readonly apiUrl: string;
  readonly readyLabel: string;
  readonly runningLabel: string;
  readonly failedLabel: string;
  readonly successComment: string;
}

export interface PollingConfig {
  readonly intervalMs: number;
  readonly maxConcurrentRuns: number;
  readonly retry: RetryPolicy;
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

export interface AgentConfig {
  readonly command: string;
  readonly promptTransport: "stdin" | "file";
  readonly timeoutMs: number;
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

export interface WorkspaceInfo {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly path: string;
  readonly branchName: string;
  readonly createdNow: boolean;
}

export interface RunContext {
  readonly issue: IssueRef;
  readonly workspace: WorkspaceInfo;
  readonly prompt: string;
  readonly attempt: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface RetryEntry {
  readonly issue: IssueRef;
  readonly attempt: number;
  readonly dueAt: number;
  readonly lastError: string;
}

export interface PullRequestRecord {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}
