import { TrackerError } from "../domain/errors.js";
import { LinearClient } from "./linear-client.js";
import {
  normalizeLinearIssueMutationResult,
  type LinearIssueNormalizationOptions,
  type LinearIssueSnapshot,
  type LinearProjectSnapshot,
  type LinearWorkflowState,
} from "./linear-normalize.js";

interface LinearIssueWriteInput {
  readonly id: string;
  readonly description?: string;
  readonly stateName?: string | null;
}

export class LinearIssueWriter {
  readonly #client: LinearClient;
  readonly #normalizeOptions: LinearIssueNormalizationOptions;

  constructor(
    client: LinearClient,
    normalizeOptions: LinearIssueNormalizationOptions,
  ) {
    this.#client = client;
    this.#normalizeOptions = normalizeOptions;
  }

  async createComment(
    issueId: string,
    body: string,
  ): Promise<LinearIssueSnapshot> {
    return normalizeLinearIssueMutationResult(
      await this.#client.createComment(issueId, body),
      "commentCreate",
      this.#normalizeOptions,
    );
  }

  async updateIssue(
    input: LinearIssueWriteInput,
    project?: LinearProjectSnapshot,
  ): Promise<LinearIssueSnapshot> {
    const hasDescription = input.description !== undefined;
    const hasStateName =
      input.stateName !== undefined && input.stateName !== null;

    if (!hasDescription && !hasStateName) {
      throw new TrackerError("Linear issue update requires at least one field");
    }

    if (hasStateName && project === undefined) {
      throw new TrackerError(
        `Linear issue update for ${input.id} requires project workflow state lookup`,
      );
    }

    const stateId =
      !hasStateName || project === undefined
        ? undefined
        : resolveLinearStateByName(project, input.stateName).id;

    return normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: input.id,
        ...(hasDescription ? { description: input.description } : {}),
        ...(stateId === undefined ? {} : { stateId }),
      }),
      "issueUpdate",
      this.#normalizeOptions,
    );
  }
}

export function resolveLinearStateByName(
  project: LinearProjectSnapshot,
  stateName: string,
): LinearWorkflowState {
  const match = project.states.find((state) => state.name === stateName);
  if (match !== undefined) {
    return match;
  }
  throw new TrackerError(
    `Linear project ${project.slugId} is missing configured state '${stateName}'`,
  );
}
