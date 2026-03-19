import type { RunSession } from "../domain/run.js";
import type {
  PromptIssueContext,
  PromptPullRequestContext,
} from "../domain/prompt-context.js";
import type { TrackerConfig } from "../domain/workflow.js";
import { buildPromptIssueContext, buildPromptPullRequestContext } from "./prompt-context.js";
import type { Tracker } from "./service.js";

export interface TrackerCurrentContextToolResult {
  readonly branchName: string;
  readonly issue: PromptIssueContext;
  readonly pullRequest: PromptPullRequestContext | null;
  readonly retrievedAt: string;
}

export interface TrackerToolService {
  readCurrentContext(
    runSession: RunSession,
  ): Promise<TrackerCurrentContextToolResult>;
}

class RuntimeTrackerToolService implements TrackerToolService {
  readonly #tracker: Tracker;
  readonly #config: TrackerConfig;

  constructor(tracker: Tracker, config: TrackerConfig) {
    this.#tracker = tracker;
    this.#config = config;
  }

  async readCurrentContext(
    runSession: RunSession,
  ): Promise<TrackerCurrentContextToolResult> {
    const [issue, lifecycle] = await Promise.all([
      this.#tracker.getIssue(runSession.issue.number),
      this.#tracker.inspectIssueHandoff(runSession.workspace.branchName),
    ]);

    return {
      branchName: runSession.workspace.branchName,
      issue: buildPromptIssueContext(issue, this.#config),
      pullRequest: buildPromptPullRequestContext(lifecycle),
      retrievedAt: new Date().toISOString(),
    };
  }
}

export function createTrackerToolService(
  tracker: Tracker,
  config: TrackerConfig,
): TrackerToolService {
  return new RuntimeTrackerToolService(tracker, config);
}
