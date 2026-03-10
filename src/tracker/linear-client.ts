import { TrackerError } from "../domain/errors.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";

interface GraphQLErrorPayload {
  readonly message?: unknown;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLErrorPayload[];
}

interface UpdateIssueRequest {
  readonly id: string;
  readonly description?: string;
  readonly stateId?: string;
}

const LINEAR_PROJECT_ISSUES_PAGE_SIZE = 50;

const PROJECT_FIELDS = `
  id
  slugId
  name
  states {
    nodes {
      id
      name
      type
      position
    }
  }
`;

const ISSUE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  createdAt
  updatedAt
  state {
    id
    name
    type
    position
  }
  comments {
    nodes {
      id
      body
      createdAt
      user {
        name
        email
      }
    }
  }
`;

const GET_PROJECT_QUERY = `
  query GetProject($slugId: String!) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
    }
  }
`;

const GET_PROJECT_ISSUES_PAGE_QUERY = `
  query GetProjectIssuesPage($slugId: String!, $after: String, $assignee: String) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
      issues(first: ${LINEAR_PROJECT_ISSUES_PAGE_SIZE}, after: $after, assignee: $assignee) {
        nodes {
          ${ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const GET_PROJECT_ISSUE_QUERY = `
  query GetProjectIssue($slugId: String!, $number: Int!) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
      issue(number: $number) {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_DESCRIPTION_MUTATION = `
  mutation UpdateIssueDescription($id: String!, $description: String) {
    issueUpdate(id: $id, input: { description: $description }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_STATE_MUTATION = `
  mutation UpdateIssueState($id: String!, $stateId: String) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_DESCRIPTION_AND_STATE_MUTATION = `
  mutation UpdateIssueDescriptionAndState($id: String!, $description: String, $stateId: String) {
    issueUpdate(id: $id, input: { description: $description, stateId: $stateId }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

export class LinearClient {
  readonly #config: LinearTrackerConfig;

  constructor(config: LinearTrackerConfig) {
    this.#config = config;
  }

  async fetchProject(): Promise<unknown> {
    return await this.#request("GetProject", GET_PROJECT_QUERY, {
      slugId: this.#config.projectSlug,
    });
  }

  async fetchProjectIssuesPage(after: string | null): Promise<unknown> {
    return await this.#request(
      "GetProjectIssuesPage",
      GET_PROJECT_ISSUES_PAGE_QUERY,
      {
        slugId: this.#config.projectSlug,
        after,
        assignee: this.#config.assignee,
      },
    );
  }

  async fetchProjectIssue(issueNumber: number): Promise<unknown> {
    return await this.#request("GetProjectIssue", GET_PROJECT_ISSUE_QUERY, {
      slugId: this.#config.projectSlug,
      number: issueNumber,
    });
  }

  async updateIssue(input: UpdateIssueRequest): Promise<unknown> {
    return await this.#request(
      this.#updateIssueOperation(input),
      this.#updateIssueMutation(input),
      this.#updateIssueVariables(input),
    );
  }

  async createComment(issueId: string, body: string): Promise<unknown> {
    return await this.#request("CreateComment", COMMENT_CREATE_MUTATION, {
      issueId,
      body,
    });
  }

  async #request<T>(
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.#config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName,
          query,
          variables,
        }),
      });
    } catch (error) {
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: ${(error as Error).message}`,
        { cause: error as Error },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: HTTP ${response.status} ${body}`.trim(),
      );
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if ((payload.errors?.length ?? 0) > 0) {
      const messages = payload.errors
        ?.map((entry) =>
          typeof entry.message === "string"
            ? entry.message
            : "Unknown GraphQL error",
        )
        .join("; ");
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: ${messages}`,
      );
    }
    if (payload.data === undefined) {
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: missing data payload`,
      );
    }
    return payload.data;
  }

  #updateIssueOperation(input: UpdateIssueRequest): string {
    const hasDescription = input.description !== undefined;
    const hasStateId = input.stateId !== undefined;
    if (hasDescription && hasStateId) {
      return "UpdateIssueDescriptionAndState";
    }
    if (hasDescription) {
      return "UpdateIssueDescription";
    }
    if (hasStateId) {
      return "UpdateIssueState";
    }
    throw new TrackerError("Linear issue update requires at least one field");
  }

  #updateIssueMutation(input: UpdateIssueRequest): string {
    const hasDescription = input.description !== undefined;
    const hasStateId = input.stateId !== undefined;
    if (hasDescription && hasStateId) {
      return ISSUE_UPDATE_DESCRIPTION_AND_STATE_MUTATION;
    }
    if (hasDescription) {
      return ISSUE_UPDATE_DESCRIPTION_MUTATION;
    }
    if (hasStateId) {
      return ISSUE_UPDATE_STATE_MUTATION;
    }
    throw new TrackerError("Linear issue update requires at least one field");
  }

  #updateIssueVariables(
    input: UpdateIssueRequest,
  ): Readonly<Record<string, unknown>> {
    const variables: Record<string, unknown> = { id: input.id };
    if (input.description !== undefined) {
      variables["description"] = input.description;
    }
    if (input.stateId !== undefined) {
      variables["stateId"] = input.stateId;
    }
    return variables;
  }
}
