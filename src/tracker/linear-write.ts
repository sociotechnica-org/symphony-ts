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
    project: LinearProjectSnapshot,
    input: LinearIssueWriteInput,
  ): Promise<LinearIssueSnapshot> {
    const stateId =
      input.stateName === undefined || input.stateName === null
        ? undefined
        : resolveLinearStateByName(project, input.stateName).id;

    return normalizeLinearIssueMutationResult(
      await this.#client.updateIssue({
        id: input.id,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
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
