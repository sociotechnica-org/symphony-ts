import { Liquid } from "liquidjs";
import type { HandoffLifecycle } from "../domain/handoff.js";
import type { PromptIssueContext } from "../domain/prompt-context.js";
import { WorkflowError } from "../domain/errors.js";
import type {
  PromptBuilder,
  ResolvedConfig,
  TrackerConfig,
  WorkflowDefinition,
} from "../domain/workflow.js";
import {
  buildPromptIssueContext,
  buildPromptLifecycleContext,
  buildPromptPullRequestContext,
} from "../tracker/prompt-context.js";

interface PromptRenderInput {
  readonly issue: PromptIssueContext;
  readonly attempt: number | null;
  readonly lifecycle: ReturnType<typeof buildPromptLifecycleContext>;
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

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

export function createPromptBuilder(
  definition: WorkflowDefinition,
): PromptBuilder {
  return {
    async build(input): Promise<string> {
      return await renderPromptTemplate(definition, {
        issue: buildPromptIssueContext(input.issue, definition.config.tracker),
        attempt: input.attempt,
        lifecycle: buildPromptLifecycleContext(input.pullRequest),
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
      lifecycle: input.lifecycle,
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

function exhaustiveTrackerConfig(tracker: never): never {
  throw new Error(`Unsupported tracker config '${JSON.stringify(tracker)}'`);
}
