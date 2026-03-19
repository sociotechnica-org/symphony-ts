import type { RunSession } from "../domain/run.js";
import type { TrackerToolService } from "../tracker/tool-service.js";

export const TRACKER_CURRENT_CONTEXT_TOOL_NAME = "tracker_current_context";

export interface DynamicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly deferLoading?: boolean;
}

export interface DynamicToolExecutionRequest {
  readonly tool: string;
  readonly arguments: unknown;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

export interface DynamicToolExecutionContext {
  readonly runSession: RunSession;
}

export interface DynamicToolContentItem {
  readonly type: "inputText" | "inputImage";
  readonly text?: string;
  readonly imageUrl?: string;
}

export interface DynamicToolExecutionResult {
  readonly success: boolean;
  readonly contentItems: readonly DynamicToolContentItem[];
  readonly summary: string;
}

export type DynamicToolExecutionOutcome =
  | {
      readonly kind: "unsupported-tool";
    }
  | {
      readonly kind: "invalid-arguments";
      readonly message: string;
    }
  | {
      readonly kind: "completed";
      readonly result: DynamicToolExecutionResult;
    };

export interface DynamicToolExecutor {
  readonly toolSpecs: readonly DynamicToolSpec[];
  execute(
    request: DynamicToolExecutionRequest,
    context: DynamicToolExecutionContext,
  ): Promise<DynamicToolExecutionOutcome>;
}

const TRACKER_CURRENT_CONTEXT_TOOL_SPEC: DynamicToolSpec = {
  name: TRACKER_CURRENT_CONTEXT_TOOL_NAME,
  description:
    "Read the sanitized current tracker issue and pull request context for this Symphony run.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export class RunnerDynamicToolExecutor implements DynamicToolExecutor {
  readonly #trackerToolService: TrackerToolService | null;

  constructor(trackerToolService: TrackerToolService | null = null) {
    this.#trackerToolService = trackerToolService;
  }

  get toolSpecs(): readonly DynamicToolSpec[] {
    return this.#trackerToolService === null
      ? []
      : [TRACKER_CURRENT_CONTEXT_TOOL_SPEC];
  }

  async execute(
    request: DynamicToolExecutionRequest,
    context: DynamicToolExecutionContext,
  ): Promise<DynamicToolExecutionOutcome> {
    if (
      request.tool !== TRACKER_CURRENT_CONTEXT_TOOL_NAME ||
      this.#trackerToolService === null
    ) {
      return { kind: "unsupported-tool" };
    }

    if (!isEmptyObject(request.arguments)) {
      return {
        kind: "invalid-arguments",
        message:
          "tracker_current_context does not accept arguments; expected an empty object",
      };
    }

    try {
      const trackerContext = await this.#trackerToolService.readCurrentContext(
        context.runSession,
      );
      const serialized = JSON.stringify(
        {
          tool: TRACKER_CURRENT_CONTEXT_TOOL_NAME,
          branchName: trackerContext.branchName,
          issue: trackerContext.issue,
          pullRequest: trackerContext.pullRequest,
          retrievedAt: trackerContext.retrievedAt,
        },
        null,
        2,
      );

      return {
        kind: "completed",
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: serialized }],
          summary: "tracker context loaded",
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown tracker tool failure";
      const serialized = JSON.stringify(
        {
          tool: TRACKER_CURRENT_CONTEXT_TOOL_NAME,
          error: {
            code: "tracker_read_failed",
            message,
          },
        },
        null,
        2,
      );

      return {
        kind: "completed",
        result: {
          success: false,
          contentItems: [{ type: "inputText", text: serialized }],
          summary: "tracker context load failed",
        },
      };
    }
  }
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}
